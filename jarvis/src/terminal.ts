import * as readline from "node:readline/promises";
import { EFFORT_LEVELS, isEffort, type Config } from "./config.ts";
import { bootSequence, color, TerminalRenderer } from "./hud.ts";
import type { Confirmation } from "./listen/wake.ts";
import { farewell, greeting } from "./persona.ts";
import { Session, type SessionUI } from "./session.ts";
import { Voice } from "./voice.ts";

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

const PROMPT = color.bold(color.gold("You ▸ "));

function parseTypedConfirmation(answer: string): Confirmation {
  const choice = answer.trim().toLowerCase();
  if (choice === "a" || choice === "always") return "always";
  return choice === "y" || choice === "yes" ? "yes" : "no";
}

/** The session's face in a terminal: streaming output, readline prompts, spoken replies. */
class TerminalUI implements SessionUI {
  readonly renderer = new TerminalRenderer();
  readonly voice: Voice;
  readonly rl: readline.Interface;
  readonly interactive: boolean;
  closed = false;
  // Whether a readline question is on screen, so output from timers can redraw it.
  #prompting = false;

  constructor(config: Config) {
    this.voice = new Voice(config.voice, config.voiceName);
    this.interactive = Boolean(process.stdin.isTTY);
    this.rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: this.interactive });
    this.rl.on("close", () => {
      this.closed = true;
    });
  }

  /** Prints something while a prompt may be on screen, then redraws the prompt. */
  #aside(write: () => void): void {
    const prompting = this.interactive && !this.closed && this.#prompting;
    if (prompting) this.renderer.clearLine();
    write();
    if (prompting) this.rl.prompt(true);
  }

  async #question(query: string, signal: AbortSignal): Promise<string> {
    this.#prompting = true;
    try {
      return await this.rl.question(query, { signal });
    } finally {
      this.#prompting = false;
    }
  }

  /** The next typed line. Rejects on Ctrl+C or Ctrl+D, or when `signal` aborts. */
  prompt(signal: AbortSignal): Promise<string> {
    return this.#question(PROMPT, signal);
  }

  // Streaming output of a turn.
  waiting = () => this.renderer.waiting();
  text = (delta: string) => this.renderer.text(delta);
  progress = (delta: string) => this.renderer.progress(delta);
  blockEnd = () => this.renderer.blockEnd();
  tool = (label: string) => this.renderer.tool(label);
  notice = (message: string) => this.renderer.notice(message);

  say(text: string): void {
    this.#aside(() => this.renderer.say(text));
  }

  note(text: string): void {
    this.#aside(() => this.renderer.note(`  ${text}`));
  }

  error(text: string): void {
    this.#aside(() => this.renderer.error(text));
  }

  reminder(text: string): void {
    this.#aside(() => this.renderer.alert(`Reminder: ${text}`));
  }

  heard(text: string, atPrompt: boolean): void {
    this.renderer.heard(text, atPrompt);
  }

  acknowledge(text: string): void {
    this.#aside(() => {
      this.renderer.say(text);
      this.renderer.note("  🎙 Listening...");
    });
  }

  voiceStatus(text: string | null): void {
    if (text === null) this.renderer.clearStatus();
    else this.renderer.status(text);
  }

  voiceInputChanged(on: boolean, microphone?: string): void {
    if (on) this.note(`🎙 Listening for "Hey JARVIS" on ${microphone}. Speech is recognized on this machine.`);
  }

  turnStarted(): void {}

  turnEnded(): void {
    this.renderer.settle();
  }

  speak(text: string): Promise<void> {
    this.voice.speak(text);
    return this.voice.finished(120_000);
  }

  stopSpeaking(): void {
    this.voice.stop();
  }

  async askApproval(question: string, signal: AbortSignal): Promise<Confirmation> {
    if (!this.interactive) {
      this.note("(no terminal to ask for approval, so I declined)");
      return "no";
    }
    this.renderer.settle();
    const answer = await this.#question(
      `    ${color.dim(question)}\n    ${color.gold("Proceed? [y]es / [N]o / [a]lways this session ▸ ")}`,
      signal,
    );
    return parseTypedConfirmation(answer);
  }

  approvedByVoice(answer: Confirmation): void {
    this.renderer.replacePrompt(`    ${color.gold("Proceed? ▸")} ${answer}  🎙`);
  }
}

/** Runs JARVIS in the terminal: interactively, or for one request when `prompt` is given. */
export async function runTerminal(config: Config, prompt: string | undefined): Promise<void> {
  const ui = new TerminalUI(config);
  const { renderer, voice, rl } = ui;
  const session = new Session(config, ui);
  const { jarvis, memory, reminders } = session;

  /** Handles a slash command. Returns false when it's time to power down. */
  async function command(input: string): Promise<boolean> {
    const [name = "", ...rest] = input.slice(1).trim().split(/\s+/);
    const arg = rest.join(" ");
    switch (name.toLowerCase()) {
      case "help":
        renderer.note(COMMANDS);
        break;
      case "listen":
        if (arg === "off" || (!arg && session.listening)) {
          session.stopListening();
          renderer.note("  Voice input off.");
        } else if (!ui.interactive) {
          renderer.error("Voice input needs an interactive terminal.");
        } else {
          await session.startListening();
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
        session.reset();
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
    await session.converse(input);
    return true;
  }

  // In a terminal readline turns Ctrl+C into this event; otherwise it's a process signal.
  // At the prompt, abort the pending question: closing readline wouldn't settle it.
  const onInterrupt = () => {
    if (!session.interrupt()) rl.close();
  };
  rl.on("SIGINT", onInterrupt);
  if (!ui.interactive) process.on("SIGINT", onInterrupt);

  if (prompt !== undefined) {
    if (!(await session.converse(prompt))) process.exitCode = 1;
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
    void session.speak(hello);
    if (config.listen) {
      if (ui.interactive) await session.startListening();
      else renderer.error("Voice input needs an interactive terminal.");
    }
    renderer.note("  Type /help for commands.\n");

    if (ui.interactive) {
      while (!ui.closed) {
        const request = await session.nextRequest((signal) => ui.prompt(signal));
        // Ctrl+C or Ctrl+D at the prompt. Cancelling the question already ended the prompt line.
        if (!request) break;
        if (request.spoken) {
          ui.heard(request.text, request.atPrompt);
          await session.converse(request.text);
        } else if (!(await handleLine(request.text))) {
          break;
        }
      }
    } else {
      for await (const line of rl) {
        if (!(await handleLine(line))) break;
      }
    }

    session.stopListening();
    const bye = farewell(config.honorific);
    renderer.say(bye);
    void session.speak(bye);
  }

  session.close();
  rl.close();
  await voice.finished(5000);
}
