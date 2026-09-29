import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";
import { formatBytes } from "./tools.ts";

/** sherpa-onnx's model releases on GitHub. */
export const MODEL_RELEASES = "https://github.com/k2-fsa/sherpa-onnx/releases/download";

const VAD_FILE = "silero_vad.onnx";

interface Archive {
  name: string;
  release: string;
  label: string;
}
const ASR: Archive = { name: "sherpa-onnx-moonshine-tiny-en-int8", release: "asr-models", label: "speech recognition model" };
const KWS: Archive = {
  name: "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01",
  release: "kws-models",
  label: "wake word model",
};

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
  /** A streaming keyword spotter that hears "Hey JARVIS" even while he's talking. */
  kws: {
    encoder: string;
    decoder: string;
    joiner: string;
    tokens: string;
  };
}

export function speechModelPaths(dir: string): SpeechModelPaths {
  const asr = path.join(dir, ASR.name);
  const kws = path.join(dir, KWS.name);
  const kwsFile = (part: string) => path.join(kws, `${part}-epoch-12-avg-2-chunk-16-left-64.int8.onnx`);
  return {
    vad: path.join(dir, VAD_FILE),
    asr: {
      preprocessor: path.join(asr, "preprocess.onnx"),
      encoder: path.join(asr, "encode.int8.onnx"),
      uncachedDecoder: path.join(asr, "uncached_decode.int8.onnx"),
      cachedDecoder: path.join(asr, "cached_decode.int8.onnx"),
      tokens: path.join(asr, "tokens.txt"),
    },
    kws: {
      encoder: kwsFile("encoder"),
      decoder: kwsFile("decoder"),
      joiner: kwsFile("joiner"),
      tokens: path.join(kws, "tokens.txt"),
    },
  };
}

export interface EnsureOptions {
  baseUrl?: string;
  onProgress?: (message: string) => void;
  /** Cancels the download. */
  signal?: AbortSignal;
}

/** Downloads the speech models into `dir` on first use (about 130 MB) and returns their paths. */
export async function ensureSpeechModels(dir: string, options: EnsureOptions = {}): Promise<SpeechModelPaths> {
  const { baseUrl = MODEL_RELEASES, onProgress = () => {} } = options;
  const paths = speechModelPaths(dir);

  if (!fs.existsSync(paths.vad)) {
    await download(`${baseUrl}/${ASR.release}/${VAD_FILE}`, paths.vad, "voice activity model", onProgress);
  }
  for (const [archive, files] of [
    [ASR, paths.asr],
    [KWS, paths.kws],
  ] as const) {
    if (Object.values(files).every((file) => fs.existsSync(file))) continue;
    const local = path.join(dir, `${archive.name}.tar.bz2`);
    await download(`${baseUrl}/${archive.release}/${archive.name}.tar.bz2`, local, archive.label, onProgress);
    onProgress(`Unpacking ${archive.label}`);
    try {
      await untar(local, dir);
    } finally {
      fs.rmSync(local, { force: true });
    }
  }

  const missing = [paths.vad, ...Object.values(paths.asr), ...Object.values(paths.kws)].filter(
    (file) => !fs.existsSync(file),
  );
  if (missing.length > 0) {
    throw new Error(`Speech models are incomplete (missing ${missing.join(", ")}). Delete ${dir} and try again.`);
  }
  return paths;
}

// ---------------------------------------------------------------------------
// The film voice: Kokoro, a small neural text-to-speech model with British voices.

const KOKORO: Archive = { name: "kokoro-int8-multi-lang-v1_0", release: "tts-models", label: "voice model" };

export interface VoiceModelPaths {
  model: string;
  voices: string;
  tokens: string;
  /** espeak-ng's pronunciation data, for words the lexicon doesn't know. */
  dataDir: string;
  /** British English pronunciations. */
  lexicon: string;
}

export function voiceModelPaths(dir: string): VoiceModelPaths {
  const kokoro = path.join(dir, KOKORO.name);
  return {
    model: path.join(kokoro, "model.int8.onnx"),
    voices: path.join(kokoro, "voices.bin"),
    tokens: path.join(kokoro, "tokens.txt"),
    dataDir: path.join(kokoro, "espeak-ng-data"),
    lexicon: path.join(kokoro, "lexicon-gb-en.txt"),
  };
}

/**
 * Downloads the voice model into `dir` on first use (a 132 MB download) and returns its
 * paths. Only the parts an English voice needs are unpacked.
 */
export async function ensureVoiceModel(dir: string, options: EnsureOptions = {}): Promise<VoiceModelPaths> {
  const { baseUrl = MODEL_RELEASES, onProgress = () => {}, signal } = options;
  const paths = voiceModelPaths(dir);
  const files = Object.values(paths);
  if (files.every((file) => fs.existsSync(file))) return paths;

  const local = path.join(dir, `${KOKORO.name}.tar.bz2`);
  await download(`${baseUrl}/${KOKORO.release}/${KOKORO.name}.tar.bz2`, local, KOKORO.label, onProgress, signal);
  onProgress(`Unpacking ${KOKORO.label}`);
  try {
    await untar(local, dir, files.map((file) => path.relative(dir, file).split(path.sep).join("/")));
  } finally {
    fs.rmSync(local, { force: true });
  }
  const missing = files.filter((file) => !fs.existsSync(file));
  if (missing.length > 0) {
    throw new Error(`The voice model is incomplete (missing ${missing.join(", ")}). Delete ${dir} and try again.`);
  }
  return paths;
}

async function download(
  url: string,
  dest: string,
  label: string,
  onProgress: (message: string) => void,
  signal?: AbortSignal,
) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const response = await fetch(url, { signal });
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

/** Unpacks a .tar.bz2 archive into `dir`: all of it, or only `members`. */
function untar(archive: string, dir: string, members: string[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", ["-xjf", archive, "-C", dir, ...members], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (err) => reject(new Error(`Couldn't run tar to unpack ${archive}: ${err.message}`)));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar couldn't unpack ${archive}: ${stderr.trim() || `exit code ${code}`}`));
    });
  });
}
