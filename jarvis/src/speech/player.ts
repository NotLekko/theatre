import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hasCommand } from "../voice.ts";

/** Plays WAV audio through the speakers with a command-line player. */
export interface Player {
  readonly name: string;
  /** Resolves when playback ends, or as soon as `signal` aborts (which stops it). */
  play(wav: Buffer, signal: AbortSignal): Promise<void>;
  close(): void;
}

interface PlayerCommand {
  name: string;
  command: string;
  /** Arguments to play a file; the file's path goes after them. */
  args: string[];
  /** Pass the path in this environment variable instead of as an argument. */
  pathVariable?: string;
}

// Windows' own player, with the path passed in the environment so it never needs quoting.
const WINDOWS: PlayerCommand = {
  name: "Windows audio",
  command: "powershell.exe",
  args: ["-NoProfile", "-NonInteractive", "-Command", "(New-Object Media.SoundPlayer $env:JARVIS_WAV).PlaySync()"],
  pathVariable: "JARVIS_WAV",
};

// In order of preference: the PulseAudio/PipeWire players most Linux desktops have, then
// raw ALSA, then SoX and FFmpeg.
const LINUX: PlayerCommand[] = [
  { name: "paplay", command: "paplay", args: [] },
  { name: "pw-play", command: "pw-play", args: [] },
  { name: "aplay", command: "aplay", args: ["-q"] },
  { name: "sox", command: "play", args: ["-q"] },
  { name: "ffplay", command: "ffplay", args: ["-nodisp", "-autoexit", "-loglevel", "quiet"] },
];

function detectCommand(): PlayerCommand | null {
  if (process.platform === "darwin") return { name: "afplay", command: "afplay", args: [] };
  if (process.platform === "win32") return WINDOWS;
  return LINUX.find((player) => hasCommand(player.command)) ?? null;
}

/** Finds an audio player on this machine, or returns null if there isn't one. */
export function detectPlayer(): Player | null {
  const player = detectCommand();
  return player ? new CommandPlayer(player) : null;
}

class CommandPlayer implements Player {
  readonly name: string;
  readonly #player: PlayerCommand;
  #dir: string | undefined;
  #count = 0;

  constructor(player: PlayerCommand) {
    this.#player = player;
    this.name = player.name;
  }

  async play(wav: Buffer, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    this.#dir ??= fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-voice-"));
    const file = path.join(this.#dir, `${++this.#count}.wav`);
    fs.writeFileSync(file, wav);
    try {
      await this.#run(file, signal);
    } finally {
      fs.rmSync(file, { force: true });
    }
  }

  #run(file: string, signal: AbortSignal): Promise<void> {
    const { command, args, pathVariable } = this.#player;
    return new Promise((resolve, reject) => {
      const child = spawn(command, pathVariable ? args : [...args, file], {
        stdio: ["ignore", "ignore", "pipe"],
        env: pathVariable ? { ...process.env, [pathVariable]: file } : process.env,
      });
      let stderr = "";
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
      const stop = () => child.kill();
      signal.addEventListener("abort", stop, { once: true });
      child.on("error", (err) => {
        signal.removeEventListener("abort", stop);
        reject(new Error(`Couldn't start ${this.name}: ${err.message}`));
      });
      child.on("close", (code) => {
        signal.removeEventListener("abort", stop);
        if (code === 0 || signal.aborted) resolve();
        else reject(new Error(`${this.name} couldn't play audio: ${stderr.trim().split("\n")[0] || `exit code ${code}`}`));
      });
    });
  }

  close(): void {
    if (this.#dir) fs.rmSync(this.#dir, { recursive: true, force: true });
    this.#dir = undefined;
  }
}
