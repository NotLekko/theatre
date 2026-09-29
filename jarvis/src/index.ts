import fs from "node:fs";
import path from "node:path";
import * as readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { EFFORT_LEVELS, USAGE, isEffort, loadConfig, type CliOptions } from "./config.ts";
import { bootSequence, color, TerminalRenderer } from "./hud.ts";
import { Jarvis } from "./jarvis.ts";
import { Ears } from "./listen/ears.ts";
import { ensureSpeechModels } from "./listen/models.ts";
import { VoiceInput } from "./listen/voiceInput.ts";
import type { Confirmation } from "./listen/wake.ts";
import { MemoryStore } from "./memory.ts";
import { buildSystemPrompt, farewell, greeting } from "./persona.ts";
import { Reminders } from "./reminders.ts";
import { localTools, serverTools, type ToolContext } from "./tools.ts";
import { Voice } from "./voice.ts";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = path.join(appDir, ".env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const COMMANDS = `  /listen [on|off]  voice input: say "Hey JARVIS", then your request
  /voice [on|off]   toggle speech
  /effort [level]   show or set thinking effort (${EFFORT_LEVELS.join(", ")})
  /memory           list what I remember about you
  /forget <id>      delete a memory
  /reminders        list pending reminders
  /clear            start a fresh conversation
  /usage            token usage this session
  /exit             power down (or Ctrl+D)
  Ctrl+C interrupts me mid-answer.`;

/** A promise that never settles: a race entrant that has dropped out. */
const never = <T>() => new Promise<T>(() => {});

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

function parseTypedConfirmation(answer: string): Confirmation {
  const choice = answer.trim().toLowerCase();
  if (choice === "a" || choice === "always") return "always";
  return choice === "y" || choice === "yes" ? "yes" : "no";
}

interface Input {
  text: string;
  spoken: boolean;
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
  let listening: { ears: Ears; input: VoiceInput } | null = null;

  /** Speaks a line; while it plays the microphone ignores everything, so JARVIS doesn't hear himself. */
  function speak(text: string): Promise<void> {
    voice.speak(text);
    const done = voice.finished(120_000);
    listening?.ears.holdUntil(done);
    return done;
  }

  /** Prints something while a prompt may be on screen, then redraws the prompt. */
  function aside(write: () => void): void {
    const prompting = interactive && !closed && (idlePrompt !== null || confirming);
    if (prompting) renderer.clearLine();
    write();
    if (prompting) rl.prompt(true);
  }

  const reminders = new Reminders((reminder) => {
    aside(() => renderer.alert(`Reminder: ${reminder.message}`));
    void speak(`Pardon the interruption, ${config.honorific}. You asked me to remind you: ${reminder.message}`);
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

  async function startListening(): Promise<void> {
    if (listening) {
      renderer.note('  Already listening for "Hey JARVIS".');
      return;
    }
    if (!interactive) {
      renderer.error("Voice input needs an interactive terminal.");
      return;
    }
    try {
      const models = await ensureSpeechModels(path.join(config.home, "models"), {
        onProgress: (message) => renderer.status(message),
      });
      renderer.status("Starting the microphone");
      const ears = await Ears.open(models, {
        microphone: { deviceIndex: config.micDevice },
        onError: (err) => {
          stopListening();
          aside(() => renderer.error(`Voice input stopped: ${err.message}`));
        },
      });
      // Don't transcribe anything JARVIS is already saying.
      ears.holdUntil(voice.finished(30_000));
      const input = new VoiceInput({
        hearing: ears,
        honorific: config.honorific,
        speak,
        acknowledge: (text) =>
          aside(() => {
            renderer.say(text);
            renderer.note("  🎙 Listening...");
          }),
        note: (text) => aside(() => renderer.note(`  ${text}`)),
      });
      listening = { ears, input };
      renderer.clearStatus();
      renderer.note(`  🎙 Listening for "Hey JARVIS" on ${ears.microphoneName}. Speech is recognized on this machine.`);
    } catch (err) {
      renderer.clearStatus();
      renderer.error(`Voice input is unavailable: ${(err as Error).message}`);
    }
  }

  function stopListening(): void {
    listening?.ears.close();
    listening = null;
  }

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
    // Accept an answer from the keyboard or, when listening, out loud - whichever comes first.
    const settled = new AbortController();
    const either = AbortSignal.any([signal, settled.signal]);
    const typed = rl
      .question(`    ${color.dim(question)}\n    ${color.gold("Proceed? [y]es / [N]o / [a]lways this session ▸ ")}`, {
        signal: either,
      })
      .then(parseTypedConfirmation);
    const spoken = listening
      ? listening.input.confirm(question, either).then((answer) => ({ answer }), never<{ answer: Confirmation }>)
      : never<{ answer: Confirmation }>();
    confirming = true;
    let winner: Confirmation | { answer: Confirmation };
    try {
      winner = await Promise.race([typed, spoken]);
    } finally {
      confirming = false;
      settled.abort();
      typed.catch(() => {});
    }
    const answer = typeof winner === "string" ? winner : winner.answer;
    if (typeof winner !== "string") renderer.replacePrompt(`    ${color.gold("Proceed? ▸")} ${answer}  🎙`);
    // Answered by keyboard: no need to finish asking out loud.
    else if (listening) voice.stop();
    if (answer === "always") approveAll = true;
    return answer !== "no";
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
        void speak(line);
        return false;
      }
      if (result.truncated) renderer.note("  (my answer was cut short)");
      void speak(result.text);
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
  async function command(input: string): Promise<boolean> {
    const [name = "", ...rest] = input.slice(1).trim().split(/\s+/);
    const arg = rest.join(" ");
    switch (name.toLowerCase()) {
      case "help":
        renderer.note(COMMANDS);
        break;
      case "listen":
        if (arg === "off" || (!arg && listening)) {
          stopListening();
          renderer.note("  Voice input off.");
        } else {
          await startListening();
        }
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

  /** Waits for the next request, typed or (when listening) spoken. Resolves null on Ctrl+C or Ctrl+D. */
  async function nextInput(): Promise<Input | null> {
    const controller = new AbortController();
    idlePrompt = controller;
    const typed = rl
      .question(promptText, { signal: controller.signal })
      .then((text): Input => ({ text, spoken: false }));
    // If the microphone fails, voice drops out of the race and the keyboard carries on.
    const spoken = listening
      ? listening.input.waitForCommand(controller.signal).then((text): Input => ({ text, spoken: true }), never<Input>)
      : never<Input>();
    try {
      return await Promise.race([typed, spoken]);
    } catch {
      return null;
    } finally {
      idlePrompt = null;
      controller.abort();
      typed.catch(() => {});
    }
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
        ["Voice input", config.listen ? 'wake word "Hey JARVIS"' : "keyboard (/listen to enable)"],
        ["Long-term memory", `${memory.list().length} record(s)`],
        ["Web uplink", "search and fetch"],
      ],
      config.fastBoot,
    );
    const hello = greeting(config.honorific);
    renderer.say(hello);
    void speak(hello);
    if (config.listen) await startListening();
    renderer.note("  Type /help for commands.\n");

    if (interactive) {
      while (!closed) {
        const input = await nextInput();
        // Ctrl+C or Ctrl+D at the prompt. Cancelling the question already ended the prompt line.
        if (!input) break;
        if (input.spoken) {
          renderer.heard(input.text);
          await converse(input.text);
        } else if (!(await handleLine(input.text))) {
          break;
        }
      }
    } else {
      for await (const line of rl) {
        if (!(await handleLine(line))) break;
      }
    }

    stopListening();
    const bye = farewell(config.honorific);
    renderer.say(bye);
    void speak(bye);
  }

  reminders.cancelAll();
  rl.close();
  await voice.finished(5000);
}

main().catch((err: unknown) => {
  console.error(color.red(`Fatal: ${err instanceof Error ? err.message : String(err)}`));
  process.exitCode = 1;
});
