import { spawn, spawnSync, type ChildProcess } from "node:child_process";

interface Engine {
  name: string;
  command: string;
  args: string[];
}

export function hasCommand(command: string): boolean {
  const probe =
    process.platform === "win32"
      ? spawnSync("where", [command], { stdio: "ignore" })
      : spawnSync("/bin/sh", ["-c", `command -v ${command}`], { stdio: "ignore" });
  return probe.status === 0;
}

function macVoiceInstalled(voice: string): boolean {
  const listing = spawnSync("say", ["-v", "?"], { encoding: "utf8" });
  return listing.status === 0 && listing.stdout.split("\n").some((line) => line.startsWith(`${voice} `));
}

/**
 * Picks a text-to-speech engine for this OS. Every engine reads the text from stdin,
 * so what JARVIS says never passes through a shell or an argument parser.
 */
export function detectEngine(voiceName: string | undefined): Engine | null {
  if (process.platform === "darwin") {
    // Daniel is the British voice that ships with macOS - the closest match to JARVIS.
    const voice = voiceName ?? (macVoiceInstalled("Daniel") ? "Daniel" : undefined);
    return { name: voice ? `say (${voice})` : "say", command: "say", args: voice ? ["-v", voice] : [] };
  }
  if (process.platform === "win32") {
    const select = voiceName ? `$s.SelectVoice('${voiceName.replace(/'/g, "''")}'); ` : "";
    const script =
      "Add-Type -AssemblyName System.Speech; " +
      "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; " +
      select +
      "$s.Speak([Console]::In.ReadToEnd())";
    return {
      name: "Windows speech",
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", script],
    };
  }
  for (const command of ["espeak-ng", "espeak"]) {
    if (hasCommand(command)) {
      const voice = voiceName ?? "en-gb";
      return { name: `${command} (${voice})`, command, args: ["-v", voice, "-s", "165"] };
    }
  }
  return null;
}

/** Turns a markdown reply into something pleasant to hear. */
export function toSpeech(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?(?:```|$)/g, " I've put the details on screen. ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "the link on screen")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/(?<!\w)__(.+?)__(?!\w)/g, "$1")
    .replace(/(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])/g, "$1")
    .replace(/(?<!\w)_(?!\s)(.+?)(?<!\s)_(?!\w)/g, "$1")
    .replace(/([^\s.!?:;,])[ \t]*\n+/g, "$1. ")
    .replace(/\s+/g, " ")
    .trim();
}

export class Voice {
  readonly #engine: Engine | null;
  #current: ChildProcess | null = null;
  enabled: boolean;

  constructor(enabled: boolean, voiceName: string | undefined) {
    this.#engine = detectEngine(voiceName);
    this.enabled = enabled && this.#engine !== null;
  }

  get available(): boolean {
    return this.#engine !== null;
  }

  get engineName(): string | undefined {
    return this.#engine?.name;
  }

  speak(text: string): void {
    if (!this.enabled || !this.#engine) return;
    const speech = toSpeech(text);
    if (!speech) return;
    this.stop();
    const child = spawn(this.#engine.command, this.#engine.args, { stdio: ["pipe", "ignore", "ignore"] });
    this.#current = child;
    child.on("error", () => {
      // The engine vanished or can't start; carry on in text only.
      this.enabled = false;
    });
    child.on("exit", () => {
      if (this.#current === child) this.#current = null;
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(speech);
  }

  stop(): void {
    this.#current?.kill();
    this.#current = null;
  }

  /** Resolves once the current utterance ends, or after `timeoutMs`. */
  finished(timeoutMs: number): Promise<void> {
    const child = this.#current;
    if (!child) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
