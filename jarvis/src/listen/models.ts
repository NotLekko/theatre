import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";
import { formatBytes } from "../tools.ts";

/** sherpa-onnx's model releases on GitHub. */
export const MODEL_RELEASES = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models";

const VAD_FILE = "silero_vad.onnx";
const ASR_NAME = "sherpa-onnx-moonshine-tiny-en-int8";

export interface SpeechModelPaths {
  /** Silero voice activity detector: finds where speech starts and stops. */
  vad: string;
  /** Moonshine Tiny: a small English speech recognizer built for live transcription. */
  asr: {
    preprocessor: string;
    encoder: string;
    uncachedDecoder: string;
    cachedDecoder: string;
    tokens: string;
  };
}

export function speechModelPaths(dir: string): SpeechModelPaths {
  const asr = path.join(dir, ASR_NAME);
  return {
    vad: path.join(dir, VAD_FILE),
    asr: {
      preprocessor: path.join(asr, "preprocess.onnx"),
      encoder: path.join(asr, "encode.int8.onnx"),
      uncachedDecoder: path.join(asr, "uncached_decode.int8.onnx"),
      cachedDecoder: path.join(asr, "cached_decode.int8.onnx"),
      tokens: path.join(asr, "tokens.txt"),
    },
  };
}

export interface EnsureOptions {
  baseUrl?: string;
  onProgress?: (message: string) => void;
}

/** Downloads the speech models into `dir` on first use (about 110 MB) and returns their paths. */
export async function ensureSpeechModels(dir: string, options: EnsureOptions = {}): Promise<SpeechModelPaths> {
  const { baseUrl = MODEL_RELEASES, onProgress = () => {} } = options;
  const paths = speechModelPaths(dir);

  if (!fs.existsSync(paths.vad)) {
    await download(`${baseUrl}/${VAD_FILE}`, paths.vad, "voice activity model", onProgress);
  }
  if (!Object.values(paths.asr).every((file) => fs.existsSync(file))) {
    const archive = path.join(dir, `${ASR_NAME}.tar.bz2`);
    await download(`${baseUrl}/${ASR_NAME}.tar.bz2`, archive, "speech recognition model", onProgress);
    onProgress("Unpacking speech recognition model");
    try {
      await untar(archive, dir);
    } finally {
      fs.rmSync(archive, { force: true });
    }
  }

  const missing = [paths.vad, ...Object.values(paths.asr)].filter((file) => !fs.existsSync(file));
  if (missing.length > 0) {
    throw new Error(`Speech models are incomplete (missing ${missing.join(", ")}). Delete ${dir} and try again.`);
  }
  return paths;
}

async function download(url: string, dest: string, label: string, onProgress: (message: string) => void) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Couldn't download the ${label} (HTTP ${response.status} from ${url}).`);
  }
  const total = Number(response.headers.get("content-length")) || 0;
  let received = 0;
  let lastReport = 0;
  const body = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
  body.on("data", (chunk: Buffer) => {
    received += chunk.length;
    const now = Date.now();
    if (now - lastReport < 200) return;
    lastReport = now;
    const amount = total
      ? `${Math.floor((received / total) * 100)}% of ${formatBytes(total)}`
      : formatBytes(received);
    onProgress(`Downloading ${label}: ${amount}`);
  });

  // Write to a temporary name so an interrupted download is never mistaken for a model.
  const partial = `${dest}.part`;
  try {
    await pipeline(body, fs.createWriteStream(partial));
    fs.renameSync(partial, dest);
  } catch (err) {
    fs.rmSync(partial, { force: true });
    throw err;
  }
}

function untar(archive: string, dir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", ["-xjf", archive, "-C", dir], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (err) => reject(new Error(`Couldn't run tar to unpack ${archive}: ${err.message}`)));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar couldn't unpack ${archive}: ${stderr.trim() || `exit code ${code}`}`));
    });
  });
}
