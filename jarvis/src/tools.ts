import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Location } from "./config.ts";
import type { MemoryStore } from "./memory.ts";
import type { Reminders } from "./reminders.ts";

export interface ToolContext {
  memory: MemoryStore;
  reminders: Reminders;
  /** Asks the user to approve an action. Resolves false if they decline. */
  confirm: (question: string) => Promise<boolean>;
  signal: AbortSignal;
}

export interface LocalTool<Schema extends z.ZodObject = z.ZodObject> {
  name: string;
  description: string;
  schema: Schema;
  /** A one-line status shown in the HUD while the tool runs. */
  label(input: z.infer<Schema>): string;
  run(input: z.infer<Schema>, ctx: ToolContext): Promise<string>;
}

function defineTool<Schema extends z.ZodObject>(tool: LocalTool<Schema>): LocalTool<Schema> {
  return tool;
}

export function toApiTool(tool: LocalTool): Anthropic.Beta.BetaTool {
  const { $schema: _dialect, ...schema } = z.toJSONSchema(tool.schema) as Record<string, unknown>;
  return {
    name: tool.name,
    description: tool.description,
    input_schema: schema as Anthropic.Beta.BetaTool.InputSchema,
    // Stream tool input as it's generated. The server no longer validates it, so every
    // input is checked against the zod schema before the tool runs.
    eager_input_streaming: true,
  };
}

// ---------------------------------------------------------------------------
// Formatting helpers

export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function formatDuration(totalSeconds: number): string {
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(" ");
}

function formatDelay(minutes: number): string {
  if (minutes < 1) return `${Math.round(minutes * 60)}s`;
  if (minutes < 60) return `${+minutes.toFixed(1)} min`;
  return `${+(minutes / 60).toFixed(1)} h`;
}

/** Keeps the head and tail of long output, where the useful parts usually are. */
export function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  const omitted = text.length - 2 * half;
  return `${text.slice(0, half)}\n... [${omitted} characters omitted] ...\n${text.slice(-half)}`;
}

const ANSI_ESCAPES = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

// ---------------------------------------------------------------------------
// Process helpers

function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    // The command runs in its own process group, so this also stops anything it spawned.
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

const MAX_CAPTURE = 1_000_000;
const MAX_RESULT = 12_000;

export interface CommandResult {
  exit_code: number | null;
  timed_out: boolean;
  stdout: string;
  stderr: string;
}

export function runCommand(command: string, timeoutMs: number, signal: AbortSignal): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      if (stdout.length < MAX_CAPTURE) stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      if (stderr.length < MAX_CAPTURE) stderr += chunk;
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    const onAbort = () => killTree(child);
    signal.addEventListener("abort", onAbort, { once: true });

    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    child.on("error", (err) => {
      finish();
      reject(err);
    });
    child.on("close", (code) => {
      finish();
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      resolve({
        exit_code: code,
        timed_out: timedOut,
        stdout: truncateMiddle(stdout.replace(ANSI_ESCAPES, ""), MAX_RESULT),
        stderr: truncateMiddle(stderr.replace(ANSI_ESCAPES, ""), MAX_RESULT),
      });
    });
  });
}

function openInBrowser(url: string): Promise<void> {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args as string[], { stdio: "ignore", detached: true });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

/** Share of CPU time spent busy across all cores, sampled over a short window. */
async function cpuUtilization(sampleMs = 250): Promise<number> {
  const snapshot = () =>
    os.cpus().reduce(
      (acc, cpu) => {
        const t = cpu.times;
        acc.idle += t.idle;
        acc.total += t.user + t.nice + t.sys + t.idle + t.irq;
        return acc;
      },
      { idle: 0, total: 0 },
    );
  const before = snapshot();
  await new Promise((r) => setTimeout(r, sampleMs));
  const after = snapshot();
  const total = after.total - before.total;
  return total > 0 ? 1 - (after.idle - before.idle) / total : 0;
}

function diskUsage(target: string): Record<string, string> | string {
  try {
    const stats = fs.statfsSync(target);
    const total = stats.blocks * stats.bsize;
    const available = stats.bavail * stats.bsize;
    return {
      volume_of: target,
      total: formatBytes(total),
      available: formatBytes(available),
      used_percent: `${Math.round((1 - stats.bfree / stats.blocks) * 100)}%`,
    };
  } catch (err) {
    return `unavailable (${(err as Error).message})`;
  }
}

// ---------------------------------------------------------------------------
// Local tools

const getDatetime = defineTool({
  name: "get_datetime",
  description: "Get the current local date, time and time zone of the user's computer.",
  schema: z.object({}),
  label: () => "Checking the clock",
  async run() {
    const now = new Date();
    return JSON.stringify({
      local: now.toLocaleString("en-GB", { dateStyle: "full", timeStyle: "long" }),
      iso: now.toISOString(),
      time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
  },
});

const systemStatus = defineTool({
  name: "system_status",
  description:
    "Run diagnostics on the user's computer: host name, operating system, uptime, CPU load, memory, and disk space on the home volume.",
  schema: z.object({}),
  label: () => "Running diagnostics",
  async run() {
    const cpus = os.cpus();
    const total = os.totalmem();
    const free = os.freemem();
    return JSON.stringify(
      {
        host: os.hostname(),
        os: `${os.type()} ${os.release()} (${os.arch()})`,
        uptime: formatDuration(os.uptime()),
        cpu: {
          model: cpus[0]?.model.trim() ?? "unknown",
          cores: cpus.length,
          utilization: `${Math.round((await cpuUtilization()) * 100)}%`,
          ...(process.platform === "win32" ? {} : { load_average_1_5_15_min: os.loadavg().map((n) => +n.toFixed(2)) }),
        },
        memory: {
          total: formatBytes(total),
          available: formatBytes(free),
          used_percent: `${Math.round((1 - free / total) * 100)}%`,
        },
        disk: diskUsage(os.homedir()),
        jarvis_process: { node: process.version, memory: formatBytes(process.memoryUsage().rss) },
      },
      null,
      2,
    );
  },
});

const runShellCommand = defineTool({
  name: "run_shell_command",
  description:
    "Run a shell command on the user's computer and return its exit code, stdout and stderr. " +
    "The user must approve each command before it runs. Commands run non-interactively (no stdin) " +
    "in the current working directory and are stopped after the timeout. Prefer commands that finish " +
    "quickly and print concise output; long output is truncated in the middle.",
  schema: z.object({
    command: z.string().min(1).describe("The command line to run, e.g. `df -h ~`"),
    reason: z.string().min(1).describe("One short sentence, shown to the user, explaining why you want to run it"),
    timeout_seconds: z.number().int().min(1).max(600).optional().describe("How long to allow; default 60"),
  }),
  label: ({ command }) => `Shell: ${command}`,
  async run({ command, reason, timeout_seconds }, ctx) {
    if (!(await ctx.confirm(reason))) {
      return "The user declined to run this command.";
    }
    const result = await runCommand(command, (timeout_seconds ?? 60) * 1000, ctx.signal);
    return JSON.stringify(result, null, 2);
  },
});

const remember = defineTool({
  name: "remember",
  description:
    "Save a fact about the user to long-term memory so it is available in future sessions. " +
    "Use it for lasting, useful facts such as their name, preferences, projects and people who matter to them. Never store secrets.",
  schema: z.object({
    fact: z.string().min(1).max(500).describe('A short, self-contained statement, e.g. "Prefers metric units"'),
  }),
  label: ({ fact }) => `Committing to memory: ${fact}`,
  async run({ fact }, ctx) {
    const memory = ctx.memory.add(fact);
    return `Saved as ${memory.id}.`;
  },
});

const forget = defineTool({
  name: "forget",
  description: "Delete a fact from long-term memory by its id (for example m3).",
  schema: z.object({
    memory_id: z.string().min(1).describe("The id of the saved memory, e.g. m3"),
  }),
  label: ({ memory_id }) => `Erasing memory ${memory_id}`,
  async run({ memory_id }, ctx) {
    const removed = ctx.memory.remove(memory_id);
    if (removed) return `Forgot ${removed.id}: "${removed.fact}".`;
    const known = ctx.memory.list().map((m) => `[${m.id}] ${m.fact}`);
    throw new Error(`No memory with id ${memory_id}. Saved memories: ${known.join("; ") || "none"}.`);
  },
});

const setReminder = defineTool({
  name: "set_reminder",
  description:
    "Set a reminder that interrupts the user with a spoken and on-screen alert after a delay. " +
    "Reminders only fire while this session is running (up to 24 hours ahead).",
  schema: z.object({
    message: z.string().min(1).describe("What to remind the user about"),
    minutes_from_now: z.number().positive().max(1440).describe("Delay in minutes; fractions allowed (0.5 = 30 seconds)"),
  }),
  label: ({ message, minutes_from_now }) => `Reminder in ${formatDelay(minutes_from_now)}: ${message}`,
  async run({ message, minutes_from_now }, ctx) {
    const reminder = ctx.reminders.add(message, minutes_from_now * 60_000);
    return `Reminder ${reminder.id} set for ${reminder.dueAt.toLocaleTimeString("en-GB")}.`;
  },
});

const listReminders = defineTool({
  name: "list_reminders",
  description: "List the reminders that are still pending in this session.",
  schema: z.object({}),
  label: () => "Checking reminders",
  async run(_input, ctx) {
    const pending = ctx.reminders.list();
    if (pending.length === 0) return "No reminders are pending.";
    return JSON.stringify(
      pending.map((r) => ({ id: r.id, message: r.message, due: r.dueAt.toLocaleTimeString("en-GB") })),
    );
  },
});

const cancelReminder = defineTool({
  name: "cancel_reminder",
  description: "Cancel a pending reminder by its id (for example r2).",
  schema: z.object({
    reminder_id: z.string().min(1).describe("The reminder id, e.g. r2"),
  }),
  label: ({ reminder_id }) => `Cancelling reminder ${reminder_id}`,
  async run({ reminder_id }, ctx) {
    const cancelled = ctx.reminders.cancel(reminder_id);
    if (!cancelled) throw new Error(`No pending reminder with id ${reminder_id}.`);
    return `Cancelled ${cancelled.id}: "${cancelled.message}".`;
  },
});

const openUrl = defineTool({
  name: "open_url",
  description: "Open an http or https URL in the user's default web browser.",
  schema: z.object({
    url: z.string().describe("The full URL, including https://"),
  }),
  label: ({ url }) => `Opening ${url}`,
  async run({ url }) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`"${url}" is not a valid URL.`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("Only http and https URLs can be opened.");
    }
    await openInBrowser(parsed.href);
    return `Opened ${parsed.href} in the default browser.`;
  },
});

export const localTools: LocalTool[] = [
  getDatetime,
  systemStatus,
  runShellCommand,
  remember,
  forget,
  setReminder,
  listReminders,
  cancelReminder,
  openUrl,
];

// ---------------------------------------------------------------------------
// Server tools - these run on Anthropic's side; no local code needed.

export function serverTools(location: Location): Anthropic.Beta.BetaToolUnion[] {
  return [
    {
      type: "web_search_20260209",
      name: "web_search",
      max_uses: 5,
      user_location: { type: "approximate", ...location },
    },
    {
      type: "web_fetch_20260209",
      name: "web_fetch",
      max_uses: 5,
      max_content_tokens: 20_000,
    },
  ];
}
