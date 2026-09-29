import fs from "node:fs";
import path from "node:path";
import * as readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { EFFORT_LEVELS, USAGE, isEffort, loadConfig, type CliOptions } from "./config.ts";
import { bootSequence, color, TerminalRenderer } from "./hud.ts";
import { Jarvis } from "./jarvis.ts";
import { MemoryStore } from "./memory.ts";
import { buildSystemPrompt, farewell, greeting } from "./persona.ts";
import { Reminders } from "./reminders.ts";
import { localTools, serverTools, type ToolContext } from "./tools.ts";
import { Voice } from "./voice.ts";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = path.join(appDir, ".env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const COMMANDS = `  /voice [on|off]   toggle speech
  /effort [level]   show or set thinking effort (${EFFORT_LEVELS.join(", ")})
  /memory           list what I remember about you
  /forget <id>      delete a memory
  /reminders        list pending reminders
  /clear            start a fresh conversation
  /usage            token usage this session
  /exit             power down (or Ctrl+D)
  Ctrl+C interrupts me mid-answer.`;

function describeError(err: unknown, model: string): string {
  if (err instanceof Anthropic.AuthenticationError) {
    return "My credentials were rejected. Check ANTHROPIC_API_KEY, or sign in with `ant auth login`.";
  }
  if (err instanceof Anthropic.PermissionDeniedError) return `Access denied: ${err.message}`;
  if (err instanceof Anthropic.NotFoundError) return `The model "${model}" isn't available to this account.`;
  if (err instanceof Anthropic.RateLimitError) return "We're being rate-limited. Give it a moment, then try again.";
  if (err instanceof Anthropic.BadRequestError) return `The API rejected the request: ${err.message}`;
  if (err instanceof Anthropic.InternalServerError) {
    return `Anthropic's servers are having trouble (${err.status}). Try again shortly.`;
  }
  if (err instanceof Anthropic.APIConnectionError) return "I can't reach Anthropic's servers. Check your network connection.";
  if (err instanceof Anthropic.APIError) return `API error ${err.status ?? ""}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

function parseCli(): CliOptions | undefined {
  try {
    return loadConfig(process.argv.slice(2));
  } catch (err) {
    console.error(`${(err as Error).message}\nRun with --help for usage.`);
    process.exitCode = 2;
    return undefined;
  }
}

async function main(): Promise<void> {
  const cli = parseCli();
  if (!cli) return;
  if (cli.help) {
    console.log(USAGE);
    return;
  }
  const { config } = cli;
  const oneShot = cli.prompt !== undefined;

  const memory = new MemoryStore(path.join(config.home, "memory.json"));
  const voice = new Voice(config.voice, config.voiceName);
  const renderer = new TerminalRenderer();
  const interactive = Boolean(process.stdin.isTTY);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: interactive });
  const promptText = color.bold(color.gold("You ▸ "));

  let current: AbortController | null = null;
  let idlePrompt: AbortController | null = null;
  let confirming = false;
  let approveAll = false;
  let closed = false;

  const reminders = new Reminders((reminder) => {
    renderer.alert(`Reminder: ${reminder.message}`);
    voice.speak(`Pardon the interruption, ${config.honorific}. You asked me to remind you: ${reminder.message}`);
    // Redraw whichever prompt the alert just cleared.
    if (interactive && !closed && (idlePrompt || confirming)) rl.prompt(true);
  });

  const systemPrompt = () =>
    buildSystemPrompt({ honorific: config.honorific, userName: config.userName, memories: memory.list() });

  const jarvis = new Jarvis({
    client: new Anthropic(),
    model: config.model,
    effort: config.effort,
    system: systemPrompt(),
    localTools,
    serverTools: serverTools(config.location),
  });

  async function confirm(question: string, signal: AbortSignal): Promise<boolean> {
    if (approveAll) {
      renderer.note("    (approved: you allowed all commands this session)");
      return true;
    }
    if (!interactive) {
      renderer.note("    (no terminal to ask for approval, so I declined)");
      return false;
    }
    renderer.settle();
    confirming = true;
    let answer: string;
    try {
      answer = await rl.question(
        `    ${color.dim(question)}\n    ${color.gold("Proceed? [y]es / [N]o / [a]lways this session ▸ ")}`,
        { signal },
      );
    } finally {
      confirming = false;
    }
    const choice = answer.trim().toLowerCase();
    if (choice === "a" || choice === "always") approveAll = true;
    return approveAll || choice === "y" || choice === "yes";
  }

  /** Runs one exchange. Resolves false if it failed. */
  async function converse(input: string): Promise<boolean> {
    const controller = new AbortController();
    current = controller;
    voice.stop();
    const ctx: ToolContext = {
      memory,
      reminders,
      signal: controller.signal,
      confirm: (question) => confirm(question, controller.signal),
    };
    try {
      const result = await jarvis.respond(input, renderer, ctx);
      renderer.settle();
      if (result.kind === "refused") {
        const line = `I'm afraid I can't help with that one, ${config.honorific}.`;
        renderer.say(line);
        voice.speak(line);
        return false;
      }
      if (result.truncated) renderer.note("  (my answer was cut short)");
      voice.speak(result.text);
      return true;
    } catch (err) {
      if (controller.signal.aborted) renderer.note("  (interrupted)");
      else renderer.error(describeError(err, jarvis.model));
      return false;
    } finally {
      current = null;
    }
  }

  /** Handles a slash command. Returns false when it's time to power down. */
  function command(input: string): boolean {
    const [name = "", ...rest] = input.slice(1).trim().split(/\s+/);
    const arg = rest.join(" ");
    switch (name.toLowerCase()) {
      case "help":
        renderer.note(COMMANDS);
        break;
      case "voice":
        if (!voice.available) {
          renderer.note("  No text-to-speech engine found. The README explains how to install one.");
          break;
        }
        voice.enabled = arg === "on" ? true : arg === "off" ? false : !voice.enabled;
        if (!voice.enabled) voice.stop();
        renderer.note(`  Voice ${voice.enabled ? "on" : "off"}.`);
        break;
      case "effort":
        if (!arg) renderer.note(`  Effort: ${jarvis.effort}`);
        else if (isEffort(arg)) {
          jarvis.effort = arg;
          renderer.note(`  Effort set to ${arg}.`);
        } else renderer.error(`Unknown effort level. Use one of: ${EFFORT_LEVELS.join(", ")}.`);
        break;
      case "memory":
      case "memories": {
        const saved = memory.list();
        renderer.note(saved.length ? saved.map((m) => `  [${m.id}] ${m.fact}`).join("\n") : "  Nothing saved yet.");
        break;
      }
      case "forget": {
        const removed = arg ? memory.remove(arg) : undefined;
        renderer.note(removed ? `  Forgot [${removed.id}] ${removed.fact}` : "  Usage: /forget <id>  (ids are listed by /memory)");
        break;
      }
      case "reminders": {
        const pending = reminders.list();
        renderer.note(
          pending.length
            ? pending.map((r) => `  [${r.id}] ${r.dueAt.toLocaleTimeString("en-GB")}  ${r.message}`).join("\n")
            : "  No reminders pending.",
        );
        break;
      }
      case "clear":
      case "reset":
        // A new conversation picks up memories saved since the last one.
        jarvis.reset(systemPrompt());
        approveAll = false;
        renderer.note("  Fresh conversation. Long-term memory carried over.");
        break;
      case "usage": {
        const u = jarvis.usage;
        const n = (value: number) => value.toLocaleString("en-GB");
        renderer.note(
          `  ${u.requests} requests · input ${n(u.input)} · output ${n(u.output)} · ` +
            `cache read ${n(u.cacheRead)} · cache write ${n(u.cacheWrite)} tokens`,
        );
        break;
      }
      case "exit":
      case "quit":
        return false;
      default:
        renderer.error(`Unknown command /${name}. Try /help.`);
    }
    return true;
  }

  async function handleLine(raw: string): Promise<boolean> {
    const input = raw.trim();
    if (!input) return true;
    if (input === "exit" || input === "quit") return false;
    if (input.startsWith("/")) return command(input);
    await converse(input);
    return true;
  }

  // In a terminal readline turns Ctrl+C into this event; otherwise it's a process signal.
  // At the prompt, abort the pending question: closing readline wouldn't settle it.
  const onInterrupt = () => {
    if (current) current.abort();
    else if (idlePrompt) idlePrompt.abort();
    else rl.close();
  };
  rl.on("SIGINT", onInterrupt);
  if (!interactive) process.on("SIGINT", onInterrupt);
  rl.on("close", () => {
    closed = true;
  });

  if (oneShot) {
    if (!(await converse(cli.prompt!))) process.exitCode = 1;
  } else {
    await bootSequence(
      [
        ["Arc reactor", "stable"],
        ["Neural link", `${config.model}, ${config.effort} effort`],
        [
          "Credentials",
          process.env.ANTHROPIC_API_KEY
            ? "ANTHROPIC_API_KEY"
            : process.env.ANTHROPIC_AUTH_TOKEN
              ? "ANTHROPIC_AUTH_TOKEN"
              : "none in environment; trying `ant auth login` profile",
        ],
        ["Voice synthesis", voice.enabled ? voice.engineName! : voice.available ? "muted" : "no engine found, text only"],
        ["Long-term memory", `${memory.list().length} record(s)`],
        ["Web uplink", "search and fetch"],
      ],
      config.fastBoot,
    );
    const hello = greeting(config.honorific);
    renderer.say(hello);
    voice.speak(hello);
    renderer.note("  Type /help for commands.\n");

    if (interactive) {
      while (!closed) {
        idlePrompt = new AbortController();
        let line: string;
        try {
          line = await rl.question(promptText, { signal: idlePrompt.signal });
        } catch {
          // Ctrl+C or Ctrl+D at the prompt; finish the prompt line.
          process.stdout.write("\n");
          break;
        } finally {
          idlePrompt = null;
        }
        if (!(await handleLine(line))) break;
      }
    } else {
      for await (const line of rl) {
        if (!(await handleLine(line))) break;
      }
    }

    const bye = farewell(config.honorific);
    renderer.say(bye);
    voice.speak(bye);
  }

  reminders.cancelAll();
  rl.close();
  await voice.finished(5000);
}

main().catch((err: unknown) => {
  console.error(color.red(`Fatal: ${err instanceof Error ? err.message : String(err)}`));
  process.exitCode = 1;
});
