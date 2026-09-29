import { createRequire } from "node:module";
import {
  openMicrophone,
  SAMPLE_RATE,
  type AudioHandler,
  type ErrorHandler,
  type Microphone,
  type MicrophoneOptions,
} from "./microphone.ts";
import type { SpeechModelPaths } from "./models.ts";

// The parts of sherpa-onnx-node used here (the package ships no type declarations).
interface SpeechSegment {
  start: number;
  samples: Float32Array;
}
interface Vad {
  acceptWaveform(samples: Float32Array): void;
  isDetected(): boolean;
  isEmpty(): boolean;
  front(enableExternalBuffer?: boolean): SpeechSegment;
  pop(): void;
  clear(): void;
  reset(): void;
}
interface RecognizerStream {
  acceptWaveform(wave: { sampleRate: number; samples: Float32Array }): void;
}
interface Recognizer {
  createStream(): RecognizerStream;
  decodeAsync(stream: RecognizerStream): Promise<{ text: string }>;
}
interface Sherpa {
  Vad: new (config: object, bufferSizeInSeconds: number) => Vad;
  OfflineRecognizer: { createAsync(config: object): Promise<Recognizer> };
}

function loadSherpa(): Sherpa {
  try {
    return createRequire(import.meta.url)("sherpa-onnx-node") as Sherpa;
  } catch (err) {
    throw new Error(
      `speech recognition needs the optional package sherpa-onnx-node, which couldn't be loaded ` +
        `(${(err as Error).message.split("\n")[0]}). Run npm install in the jarvis folder.`,
    );
  }
}

/** Raised when nobody starts speaking within the allowed time. */
export class NoSpeechError extends Error {
  constructor() {
    super("No speech heard");
    this.name = "NoSpeechError";
  }
}

export interface ListenOptions {
  /** Give up if no speech has started within this long. */
  speechStartTimeoutMs?: number;
}

/** What the rest of JARVIS needs from the ears; tests substitute a fake. */
export interface Hearing {
  /** Resolves with the next transcribed utterance. */
  nextUtterance(signal: AbortSignal, options?: ListenOptions): Promise<string>;
  /** Ignores all sound until `done` settles, so JARVIS doesn't transcribe his own voice. */
  holdUntil(done: Promise<unknown>): void;
}

interface Waiter {
  resolve(text: string): void;
  reject(err: unknown): void;
  deadline: NodeJS.Timeout | undefined;
}

export type MicrophoneFactory = (onAudio: AudioHandler, onError: ErrorHandler) => Promise<Microphone>;

export interface EarsOptions {
  microphone?: MicrophoneOptions;
  /** Supplies audio instead of a real microphone (for tests). */
  openMicrophone?: MicrophoneFactory;
  /** Called if the microphone or recognizer fails after startup. */
  onError: ErrorHandler;
}

const VAD_WINDOW = 512;

/**
 * Turns microphone audio into text: the voice activity detector cuts the stream into
 * utterances and Moonshine transcribes each one, all on this machine. Audio is only
 * processed while someone is waiting for an utterance and nothing is holding the ears.
 */
export class Ears implements Hearing {
  readonly #vad: Vad;
  readonly #recognizer: Recognizer;
  readonly #onError: ErrorHandler;
  #microphone: Microphone | null = null;
  readonly #waiters = new Set<Waiter>();
  #holds = 0;
  #wasActive = false;
  #generation = 0;
  #pending = new Float32Array(0);
  #decoding: Promise<void> = Promise.resolve();

  private constructor(vad: Vad, recognizer: Recognizer, onError: ErrorHandler) {
    this.#vad = vad;
    this.#recognizer = recognizer;
    this.#onError = onError;
  }

  static async open(models: SpeechModelPaths, options: EarsOptions): Promise<Ears> {
    const sherpa = loadSherpa();
    const vad = new sherpa.Vad(
      {
        sileroVad: {
          model: models.vad,
          threshold: 0.5,
          minSpeechDuration: 0.25,
          // How long a pause ends an utterance.
          minSilenceDuration: 0.6,
          maxSpeechDuration: 20,
          windowSize: VAD_WINDOW,
        },
        sampleRate: SAMPLE_RATE,
        numThreads: 1,
        debug: false,
      },
      60,
    );
    const recognizer = await sherpa.OfflineRecognizer.createAsync({
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
      modelConfig: {
        moonshine: {
          preprocessor: models.asr.preprocessor,
          encoder: models.asr.encoder,
          uncachedDecoder: models.asr.uncachedDecoder,
          cachedDecoder: models.asr.cachedDecoder,
        },
        tokens: models.asr.tokens,
        numThreads: 2,
        debug: false,
      },
    });

    const ears = new Ears(vad, recognizer, options.onError);
    const open =
      options.openMicrophone ?? ((onAudio, onError) => openMicrophone(onAudio, onError, options.microphone));
    ears.#microphone = await open(
      (samples) => ears.#hear(samples),
      (err) => ears.#fail(err),
    );
    return ears;
  }

  get microphoneName(): string {
    return this.#microphone?.name ?? "none";
  }

  nextUtterance(signal: AbortSignal, options: ListenOptions = {}): Promise<string> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      const onAbort = () => waiter.reject(signal.reason);
      const cleanup = () => {
        clearTimeout(waiter.deadline);
        this.#waiters.delete(waiter);
        signal.removeEventListener("abort", onAbort);
      };
      const waiter: Waiter = {
        resolve: (text) => {
          cleanup();
          resolve(text);
        },
        reject: (err) => {
          cleanup();
          reject(err);
        },
        deadline: options.speechStartTimeoutMs
          ? setTimeout(() => waiter.reject(new NoSpeechError()), options.speechStartTimeoutMs)
          : undefined,
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.#waiters.add(waiter);
    });
  }

  holdUntil(done: Promise<unknown>): void {
    this.#holds++;
    const release = () => {
      this.#holds--;
    };
    done.then(release, release);
  }

  close(): void {
    this.#microphone?.close();
    this.#microphone = null;
    for (const waiter of this.#waiters) waiter.reject(new Error("Stopped listening"));
  }

  #hear(samples: Float32Array): void {
    if (this.#waiters.size === 0 || this.#holds > 0) {
      this.#wasActive = false;
      return;
    }
    if (!this.#wasActive) {
      // Start fresh: nothing heard while inactive (or still being transcribed) counts.
      this.#wasActive = true;
      this.#generation++;
      this.#pending = new Float32Array(0);
      this.#vad.clear();
      this.#vad.reset();
    }

    const buffered = new Float32Array(this.#pending.length + samples.length);
    buffered.set(this.#pending);
    buffered.set(samples, this.#pending.length);
    let offset = 0;
    for (; offset + VAD_WINDOW <= buffered.length; offset += VAD_WINDOW) {
      this.#vad.acceptWaveform(buffered.subarray(offset, offset + VAD_WINDOW));
      if (this.#vad.isDetected()) {
        // Someone has started talking, so stop any "nobody spoke" countdowns.
        for (const waiter of this.#waiters) clearTimeout(waiter.deadline);
      }
      while (!this.#vad.isEmpty()) {
        const segment = this.#vad.front(false);
        this.#vad.pop();
        this.#transcribe(segment.samples, this.#generation);
      }
    }
    this.#pending = buffered.slice(offset);
  }

  #transcribe(samples: Float32Array, generation: number): void {
    // Decode one utterance at a time, in order.
    this.#decoding = this.#decoding.then(async () => {
      const stream = this.#recognizer.createStream();
      stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples });
      const { text } = await this.#recognizer.decodeAsync(stream);
      const heard = text.trim();
      if (generation !== this.#generation || !/[a-z0-9]/i.test(heard)) return;
      for (const waiter of [...this.#waiters]) waiter.resolve(heard);
    }).catch((err: unknown) => this.#fail(err as Error));
  }

  #fail(err: Error): void {
    for (const waiter of this.#waiters) waiter.reject(err);
    this.#onError(err);
  }
}
