import { createSherpaEngine, type SpeechEngine } from "./engine.ts";
import {
  openMicrophone,
  SAMPLE_RATE,
  type AudioHandler,
  type ErrorHandler,
  type Microphone,
  type MicrophoneOptions,
} from "./microphone.ts";
import type { SpeechModelPaths } from "../models.ts";
import { findWakePhrase } from "./wake.ts";

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
  /**
   * Resolves with the next transcribed utterance. When several callers are waiting, the
   * one that asked most recently gets it (a yes/no question outranks general listening).
   */
  nextUtterance(signal: AbortSignal, options?: ListenOptions): Promise<string>;
  /**
   * Marks JARVIS as speaking `text` until `done` settles. Meanwhile his own voice reaches
   * the microphone, so only "Hey JARVIS" gets through - and it interrupts him.
   */
  whileSpeaking(done: Promise<unknown>, text?: string): void;
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
  /** Called the moment "Hey JARVIS" is heard while he's speaking: stop talking. */
  onBargeIn: () => void;
}

const VAD_WINDOW = 512;
const seconds = (s: number) => Math.round(s * SAMPLE_RATE);
/** Audio kept from before an interruption, to recover a request said in the same breath. */
const PRE_ROLL = seconds(2.5);
/** While he speaks, the recent audio is also transcribed this often, as a second detector. */
const BARGE_IN_WINDOW = seconds(2);
const BARGE_IN_STEP = seconds(0.5);
/** After interrupting, how long to wait for more speech before treating it as "Hey JARVIS" alone. */
const QUIET_AFTER_BARGE_IN = seconds(1);
const MAX_CAPTURE = seconds(15);

/** Keeps the most recent audio. */
class AudioRing {
  readonly #buffer: Float32Array;
  #end = 0;
  #filled = 0;

  constructor(capacity: number) {
    this.#buffer = new Float32Array(capacity);
  }

  push(samples: Float32Array): void {
    for (const sample of samples.length > this.#buffer.length ? samples.subarray(-this.#buffer.length) : samples) {
      this.#buffer[this.#end] = sample;
      this.#end = (this.#end + 1) % this.#buffer.length;
    }
    this.#filled = Math.min(this.#buffer.length, this.#filled + samples.length);
  }

  latest(count: number): Float32Array {
    const n = Math.min(count, this.#filled);
    const out = new Float32Array(n);
    const start = (this.#end - n + this.#buffer.length) % this.#buffer.length;
    for (let i = 0; i < n; i++) out[i] = this.#buffer[(start + i) % this.#buffer.length]!;
    return out;
  }

  clear(): void {
    this.#filled = 0;
  }
}

function concat(parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const hasWords = (text: string) => /[a-z0-9]/i.test(text);
const LEADING_NAME = /^\W*(?:(?:hey|hay|hi|ok|okay)\W+)?(?:j[ae]r?)?v[aeiou]?s\b\W*/i;
const wordsOf = (text: string) => text.toLowerCase().match(/[a-z0-9']+/g) ?? [];

interface Capture {
  preRoll: Float32Array;
  live: Float32Array[];
  liveLength: number;
  heardSpeech: boolean;
  /** Words JARVIS was saying when interrupted, if known. */
  hisWords: Set<string> | null;
}

/**
 * Turns microphone audio into text, all on this machine. Audio is only processed while
 * someone is waiting for an utterance, in one of three ways:
 *
 * - listening: voice activity detection cuts the audio into utterances; each is transcribed.
 * - speaking: JARVIS is talking, so the microphone hears him too. Only the wake phrase is
 *   looked for, by a keyword spotter and by transcribing the last two seconds every half
 *   second. Either one hearing it interrupts him.
 * - capturing: after an interruption, the rest of what you say is recorded and turned into
 *   "Hey JARVIS, <request>" for whoever is waiting.
 */
export class Ears implements Hearing {
  readonly #engine: SpeechEngine;
  readonly #onError: ErrorHandler;
  readonly #onBargeIn: () => void;
  #microphone: Microphone | null = null;
  readonly #waiters = new Set<Waiter>();
  readonly #speaking = new Map<number, string>();
  #speechId = 0;
  #mode: "idle" | "listening" | "speaking" | "capturing" = "idle";
  // Results computed in an earlier mode are stale; this tells them apart.
  #generation = 0;
  #pending = new Float32Array(0);
  readonly #recent = new AudioRing(PRE_ROLL);
  #sinceBargeInCheck = 0;
  #bargeInCheckRunning = false;
  #capture: Capture | null = null;
  #decoding: Promise<void> = Promise.resolve();

  private constructor(engine: SpeechEngine, options: EarsOptions) {
    this.#engine = engine;
    this.#onError = options.onError;
    this.#onBargeIn = options.onBargeIn;
  }

  static async open(models: SpeechModelPaths, options: EarsOptions): Promise<Ears> {
    return Ears.withEngine(await createSherpaEngine(models), options);
  }

  /** Builds ears around any speech engine (tests use a fake one). */
  static async withEngine(engine: SpeechEngine, options: EarsOptions): Promise<Ears> {
    const ears = new Ears(engine, options);
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

  whileSpeaking(done: Promise<unknown>, text = ""): void {
    const id = this.#speechId++;
    this.#speaking.set(id, text);
    const finished = () => {
      this.#speaking.delete(id);
    };
    done.then(finished, finished);
  }

  close(): void {
    this.#microphone?.close();
    this.#microphone = null;
    for (const waiter of this.#waiters) waiter.reject(new Error("Stopped listening"));
  }

  #hear(samples: Float32Array): void {
    if (this.#waiters.size === 0) {
      this.#enter("idle");
      return;
    }
    this.#recent.push(samples);
    if (this.#mode === "capturing") {
      this.#captureMore(samples);
      return;
    }
    this.#enter(this.#speaking.size > 0 ? "speaking" : "listening");
    if (this.#mode === "speaking") this.#watchForWakePhrase(samples);
    else this.#listen(samples);
  }

  #enter(mode: "idle" | "listening" | "speaking" | "capturing"): void {
    if (mode === this.#mode) return;
    this.#mode = mode;
    this.#generation++;
    this.#pending = new Float32Array(0);
    this.#capture = null;
    this.#engine.vad.reset();
    if (mode === "idle") this.#recent.clear();
    if (mode === "speaking") {
      this.#engine.wakeWord.reset();
      this.#sinceBargeInCheck = 0;
    }
  }

  /** Feeds the voice activity detector; returns whether speech was detected along the way. */
  #feedVad(samples: Float32Array): boolean {
    const buffered = concat([this.#pending, samples]);
    let offset = 0;
    let detected = false;
    for (; offset + VAD_WINDOW <= buffered.length; offset += VAD_WINDOW) {
      this.#engine.vad.accept(buffered.subarray(offset, offset + VAD_WINDOW));
      if (this.#engine.vad.speechDetected()) detected = true;
    }
    this.#pending = buffered.slice(offset);
    return detected;
  }

  #listen(samples: Float32Array): void {
    if (this.#feedVad(samples)) this.#speechStarted();
    for (const segment of this.#engine.vad.takeSegments()) {
      const generation = this.#generation;
      this.#queue(async () => {
        const text = await this.#engine.transcribe(segment);
        if (generation === this.#generation && hasWords(text)) this.#deliver(text);
      });
    }
  }

  #watchForWakePhrase(samples: Float32Array): void {
    if (this.#engine.wakeWord.accept(samples)) {
      this.#interrupt();
      return;
    }
    // Second opinion: transcribe the last couple of seconds and look for the phrase in
    // the text. It catches some of what the keyword spotter misses when he's loud.
    this.#sinceBargeInCheck += samples.length;
    if (this.#sinceBargeInCheck < BARGE_IN_STEP || this.#bargeInCheckRunning) return;
    this.#sinceBargeInCheck = 0;
    this.#bargeInCheckRunning = true;
    const generation = this.#generation;
    const recent = this.#recent.latest(BARGE_IN_WINDOW);
    this.#queue(async () => {
      try {
        const text = await this.#engine.transcribe(recent);
        if (generation === this.#generation && findWakePhrase(text)) this.#interrupt();
      } finally {
        this.#bargeInCheckRunning = false;
      }
    });
  }

  /** "Hey JARVIS" over his speech: stop him, then record the rest of what's said. */
  #interrupt(): void {
    const preRoll = this.#recent.latest(PRE_ROLL);
    const said = [...this.#speaking.values()].join(" ");
    this.#enter("capturing");
    this.#capture = {
      preRoll,
      live: [],
      liveLength: 0,
      heardSpeech: false,
      hisWords: hasWords(said) ? new Set(wordsOf(said)) : null,
    };
    this.#onBargeIn();
  }

  #captureMore(samples: Float32Array): void {
    const capture = this.#capture!;
    capture.live.push(samples);
    capture.liveLength += samples.length;
    if (this.#feedVad(samples)) {
      capture.heardSpeech = true;
      this.#speechStarted();
    }
    this.#engine.vad.takeSegments();
    const finished = capture.heardSpeech
      ? !this.#engine.vad.speechDetected()
      : capture.liveLength >= QUIET_AFTER_BARGE_IN;
    if (finished || capture.liveLength >= MAX_CAPTURE) this.#finishCapture(capture);
  }

  #finishCapture(capture: Capture): void {
    // Back to listening, in the same generation so the result below still counts.
    this.#mode = "listening";
    this.#capture = null;
    this.#pending = new Float32Array(0);
    this.#engine.vad.reset();
    const generation = this.#generation;
    this.#queue(async () => {
      // A request usually begins in the same breath as "Hey JARVIS", before he has stopped,
      // so transcribe from before the interruption and take what follows the phrase. If
      // the phrase got lost under his voice, use what came after he stopped.
      const live = concat(capture.live);
      let command = findWakePhrase(await this.#engine.transcribe(concat([capture.preRoll, live])))?.command ?? "";
      if (!command && capture.heardSpeech) {
        // The tail of "Jarvis" itself can land after the interruption point.
        command = (await this.#engine.transcribe(live)).replace(LEADING_NAME, "");
      }
      // Words after the phrase may be his own voice, still playing. If we know what he was
      // saying, drop a "request" made only of his words; if not, only trust speech that
      // continued after he stopped.
      const echo = capture.hisWords
        ? wordsOf(command).every((word) => capture.hisWords!.has(word))
        : !capture.heardSpeech;
      if (echo) command = "";
      if (generation === this.#generation) this.#deliver(hasWords(command) ? `Hey Jarvis, ${command}` : "Hey Jarvis.");
    });
  }

  #speechStarted(): void {
    // Someone has started talking, so stop any "nobody spoke" countdowns.
    for (const waiter of this.#waiters) clearTimeout(waiter.deadline);
  }

  #deliver(text: string): void {
    [...this.#waiters].at(-1)?.resolve(text);
  }

  /** Runs recognition jobs one at a time, in order. */
  #queue(job: () => Promise<void>): void {
    this.#decoding = this.#decoding.then(job).catch((err: unknown) => this.#fail(err as Error));
  }

  #fail(err: Error): void {
    for (const waiter of this.#waiters) waiter.reject(err);
    this.#onError(err);
  }
}
