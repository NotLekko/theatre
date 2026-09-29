import type { TurnObserver } from "./jarvis.ts";

const out = process.stdout;
const useColor = Boolean(out.isTTY) && !process.env.NO_COLOR && process.env.TERM !== "dumb";

function paint(code: string): (text: string) => string {
  return (text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
}

export const color = {
  cyan: paint("38;5;51"),
  blue: paint("38;5;39"),
  gold: paint("38;5;214"),
  red: paint("38;5;203"),
  green: paint("38;5;114"),
  dim: paint("2"),
  bold: paint("1"),
};

const REACTOR = [
  "            ▄▄▄███████▄▄▄",
  "        ▄██▀▀▀  ▄▄▄▄▄  ▀▀▀██▄",
  "      ▄█▀   ▄█▀▀▀   ▀▀▀█▄   ▀█▄",
  "     ██   ▄█▀  ▄█████▄  ▀█▄   ██",
  "     ██   █▌  ▐███████▌  ▐█   ██",
  "     ██   ▀█▄  ▀█████▀  ▄█▀   ██",
  "      ▀█▄   ▀█▄▄▄   ▄▄▄█▀   ▄█▀",
  "        ▀██▄▄▄  ▀▀▀▀▀  ▄▄▄██▀",
  "            ▀▀▀███████▀▀▀",
];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Prints the arc reactor and a short run of system checks. */
export async function bootSequence(checks: Array<[label: string, value: string]>, fast: boolean): Promise<void> {
  const animate = Boolean(out.isTTY) && !fast;
  const pause = (ms: number) => (animate ? sleep(ms) : Promise.resolve());

  out.write("\n");
  for (const line of REACTOR) {
    out.write(color.cyan(line) + "\n");
    await pause(35);
  }
  out.write("\n" + color.bold(color.cyan("        J . A . R . V . I . S")) + "\n");
  out.write(color.dim("   Just A Rather Very Intelligent System") + "\n\n");

  const width = Math.max(...checks.map(([label]) => label.length)) + 4;
  for (const [label, value] of checks) {
    await pause(120);
    out.write(`  ${color.green("[ OK ]")} ${label} ${color.dim(".".repeat(width - label.length))} ${value}\n`);
  }
  out.write("\n");
}

const SPINNER_FRAMES = ["◜", "◠", "◝", "◞", "◡", "◟"];

class Spinner {
  #timer: NodeJS.Timeout | null = null;
  #frame = 0;

  start(label: string): void {
    if (this.#timer || !out.isTTY) return;
    const draw = () => {
      out.write(`\r\x1b[2K  ${color.cyan(SPINNER_FRAMES[this.#frame++ % SPINNER_FRAMES.length]!)} ${color.dim(label)}`);
    };
    draw();
    this.#timer = setInterval(draw, 90);
  }

  stop(): void {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = null;
    out.write("\r\x1b[2K");
  }
}

/** Renders a streaming turn in the terminal. */
export class TerminalRenderer implements TurnObserver {
  readonly #spinner = new Spinner();
  #mode: "idle" | "text" | "progress" = "idle";
  #atLineStart = true;

  #write(text: string): void {
    if (!text) return;
    out.write(text);
    this.#atLineStart = text.endsWith("\n");
  }

  #newline(): void {
    if (!this.#atLineStart) this.#write("\n");
  }

  waiting(): void {
    this.#newline();
    this.#mode = "idle";
    this.#spinner.start("Thinking");
  }

  text(delta: string): void {
    this.#spinner.stop();
    if (this.#mode !== "text") {
      this.#newline();
      this.#write(color.bold(color.blue("JARVIS ▸ ")));
      this.#mode = "text";
    }
    this.#write(color.cyan(delta));
  }

  progress(delta: string): void {
    this.#spinner.stop();
    if (this.#mode !== "progress") {
      this.#newline();
      this.#write(color.dim("  › "));
      this.#mode = "progress";
    }
    this.#write(color.dim(delta.replace(/\n+/g, " ")));
  }

  blockEnd(): void {
    // Text blocks split by citations should read as one paragraph, so only end progress lines.
    if (this.#mode === "progress") {
      this.#newline();
      this.#mode = "idle";
    }
  }

  tool(label: string): void {
    this.#spinner.stop();
    this.#newline();
    this.#write(`  ${color.gold("⟡")} ${color.gold(label)}\n`);
    this.#mode = "idle";
  }

  notice(message: string): void {
    this.#spinner.stop();
    this.#newline();
    this.#write(color.dim(`  (${message})`) + "\n");
    this.#mode = "idle";
  }

  /** Stops any animation and moves to a fresh line, e.g. before prompting the user. */
  settle(): void {
    this.#spinner.stop();
    this.#newline();
    this.#mode = "idle";
  }

  say(text: string): void {
    this.settle();
    this.#write(color.bold(color.blue("JARVIS ▸ ")) + color.cyan(text) + "\n");
  }

  note(text: string): void {
    this.settle();
    this.#write(color.dim(text) + "\n");
  }

  error(text: string): void {
    this.settle();
    this.#write(color.red(`  ⚠ ${text}`) + "\n");
  }

  alert(text: string): void {
    // Called from a timer, possibly while the user is typing: clear the prompt line first.
    this.#spinner.stop();
    if (out.isTTY) out.write("\r\x1b[2K");
    else this.#newline();
    this.#write(color.gold(`  ⏰ ${text}`) + "\n");
  }
}
