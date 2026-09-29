import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import { hasCommand } from "../voice.ts";
import type { RecorderMessage } from "./recorderWorker.ts";

export const SAMPLE_RATE = 16000;

export interface Microphone {
  readonly name: string;
  close(): void;
}

/** Receives 16 kHz mono audio as floats in [-1, 1]. */
export type AudioHandler = (samples: Float32Array) => void;
export type ErrorHandler = (err: Error) => void;

export type Backend = "pvrecorder" | "sox" | "arecord";

export interface MicrophoneOptions {
  /** PvRecorder device index; -1 (the default) is the system default input. */
  deviceIndex?: number;
  backends?: Backend[];
  /** The module that provides PvRecorder (tests substitute a fake). */
  recorderModule?: string;
}

function toFloat(frame: Int16Array): Float32Array {
  const samples = new Float32Array(frame.length);
  for (let i = 0; i < frame.length; i++) samples[i] = frame[i]! / 32768;
  return samples;
}

/**
 * PvRecorder ships prebuilt binaries for macOS, Windows and Linux, so it needs no setup.
 * It records on a worker thread (see recorderWorker.ts) and hands frames back here.
 */
function openPvRecorder(
  onAudio: AudioHandler,
  onError: ErrorHandler,
  deviceIndex: number,
  recorderModule: string,
): Promise<Microphone> {
  return new Promise((resolve, reject) => {
    const stop = new Int32Array(new SharedArrayBuffer(4));
    const worker = new Worker(new URL("./recorderWorker.ts", import.meta.url), {
      workerData: { deviceIndex, stop, recorderModule },
    });
    // Recording alone shouldn't keep JARVIS running after everything else has finished.
    worker.unref();
    let ready = false;
    let closing = false;
    const fail = (err: Error) => {
      if (!ready) reject(err);
      else if (!closing) onError(err);
    };
    worker.on("message", (message: RecorderMessage) => {
      switch (message.type) {
        case "ready":
          ready = true;
          resolve({
            name: message.name,
            close() {
              closing = true;
              Atomics.store(stop, 0, 1);
            },
          });
          break;
        case "audio":
          onAudio(toFloat(message.frame));
          break;
        case "error":
          fail(new Error(message.message));
          break;
      }
    });
    worker.on("error", fail);
    worker.on("exit", () => fail(new Error("the recorder stopped")));
  });
}

const COMMANDS: Record<Exclude<Backend, "pvrecorder">, string[]> = {
  // sox captures from the default input on macOS, Linux and Windows.
  sox: ["-q", "-d", "-t", "raw", "-r", "16000", "-e", "signed-integer", "-b", "16", "-c", "1", "-L", "-"],
  arecord: ["-q", "-f", "S16_LE", "-r", "16000", "-c", "1", "-t", "raw"],
};

/** Records with a command-line tool that writes raw 16-bit PCM to stdout. */
function openCommand(
  command: Exclude<Backend, "pvrecorder">,
  onAudio: AudioHandler,
  onError: ErrorHandler,
): Promise<Microphone> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, COMMANDS[command], { stdio: ["ignore", "pipe", "pipe"] });
    let leftover: Buffer | null = null;
    let stderr = "";
    let started = false;
    let closing = false;

    child.stdout.on("data", (chunk: Buffer) => {
      markStarted();
      const data = leftover ? Buffer.concat([leftover, chunk]) : chunk;
      const usable = data.length - (data.length % 2);
      leftover = usable < data.length ? data.subarray(usable) : null;
      const samples = new Float32Array(usable / 2);
      for (let i = 0; i < samples.length; i++) samples[i] = data.readInt16LE(i * 2) / 32768;
      if (samples.length > 0) onAudio(samples);
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));

    const microphone: Microphone = {
      name: command,
      close() {
        closing = true;
        child.kill();
      },
    };
    const failure = (reason: string) => new Error(`${command} ${reason}${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
    child.on("error", (err) => (started ? onError(err) : reject(err)));
    child.on("exit", (code) => {
      clearTimeout(grace);
      if (!started) reject(failure(`exited with code ${code}`));
      else if (!closing) onError(failure("stopped recording"));
    });
    // A recorder that can't open the device exits without producing audio; one that's
    // recording sends its first samples within moments. Give a slow one a few seconds.
    function markStarted() {
      if (started || child.exitCode !== null) return;
      started = true;
      clearTimeout(grace);
      resolve(microphone);
    }
    const grace = setTimeout(markStarted, 3000);
  });
}

/** Opens the first microphone backend that works. */
export async function openMicrophone(
  onAudio: AudioHandler,
  onError: ErrorHandler,
  options: MicrophoneOptions = {},
): Promise<Microphone> {
  const {
    deviceIndex = -1,
    backends = ["pvrecorder", "sox", "arecord"],
    recorderModule = "@picovoice/pvrecorder-node",
  } = options;
  const failures: string[] = [];
  for (const backend of backends) {
    try {
      if (backend === "pvrecorder") return await openPvRecorder(onAudio, onError, deviceIndex, recorderModule);
      if (!hasCommand(backend)) {
        failures.push(`${backend}: not installed`);
        continue;
      }
      return await openCommand(backend, onAudio, onError);
    } catch (err) {
      failures.push(`${backend}: ${(err as Error).message}`);
    }
  }
  throw new Error(
    `No microphone available (${failures.join("; ")}). Check that one is connected and that your ` +
      `terminal app is allowed to use it; installing sox gives JARVIS another way to record.`,
  );
}
