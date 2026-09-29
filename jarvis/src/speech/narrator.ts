import fs from "node:fs";
import { ensureVoiceModel, voiceModelPaths } from "../models.ts";
import { toSpeech } from "../voice.ts";
import { applyFx, type FxPreset } from "./fx.ts";
import { createKokoro, type NeuralVoiceName, type Synthesizer } from "./kokoro.ts";

// Each sentence is a chunk, prepared while the one before it plays. The first is kept
// short so he starts talking quickly, and long sentences are split at a clause so the
// next chunk is always ready in time.
const FIRST_CHUNK = 100;
const MAX_CHUNK = 160;

// Abbreviations whose full stop doesn't end a sentence.
const ABBREVIATION = /\b(?:Mr|Mrs|Ms|Dr|Prof|St|Sr|Jr|vs|etc|approx|e\.g|i\.e)\.$/i;

function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  let start = 0;
  for (const match of text.matchAll(/[.!?…]+["'”’)\]]*\s+/g)) {
    if (ABBREVIATION.test(text.slice(start, match.index + match[0].trimEnd().length))) continue;
    const end = match.index + match[0].length;
    sentences.push(text.slice(start, end).trim());
    start = end;
  }
  sentences.push(text.slice(start).trim());
  return sentences.filter(Boolean);
}

/** Splits a long sentence at its clauses (or, failing that, between words). */
function splitLong(sentence: string, max: number): string[] {
  if (sentence.length <= max) return [sentence];
  const clauses = [...sentence.matchAll(/[,;:—–]\s+/g)].map((m) => m.index + m[0].length);
  const cut =
    clauses.findLast((at) => at <= max && at >= 20) ??
    (sentence.lastIndexOf(" ", max) > 20 ? sentence.lastIndexOf(" ", max) : max);
  return [sentence.slice(0, cut).trim(), ...splitLong(sentence.slice(cut).trim(), max)].filter(Boolean);
}

/** Breaks a reply into the pieces he'll say, in order. */
export function speechChunks(markdown: string): string[] {
  return splitSentences(toSpeech(markdown)).flatMap((sentence, i) => splitLong(sentence, i === 0 ? FIRST_CHUNK : MAX_CHUNK));
}

function whenAborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/** JARVIS's film voice: a neural voice put through the effects chain. */
export class Narrator {
  /** The effects preset, which can change between replies. */
  fx: FxPreset;
  readonly #synth: Synthesizer;

  constructor(synth: Synthesizer, fx: FxPreset) {
    this.#synth = synth;
    this.fx = fx;
  }

  get sampleRate(): number {
    return this.#synth.sampleRate;
  }

  /**
   * Renders `chunks` in order. Each chunk is prepared while the caller handles the one
   * before it, so playback can run without gaps. Stops early when `signal` aborts.
   */
  async *render(chunks: string[], signal: AbortSignal): AsyncGenerator<Float32Array> {
    const prepare = (text: string) => {
      const audio = this.#synth.synthesize(text).then((samples) => applyFx(samples, this.sampleRate, this.fx));
      audio.catch(() => {}); // a rejection is rethrown when awaited, if it still matters
      return audio;
    };
    const aborted = whenAborted(signal);
    let next = chunks.length > 0 ? prepare(chunks[0]!) : undefined;
    for (let i = 0; next; i++) {
      const samples = await Promise.race([next, aborted]);
      if (!samples || signal.aborted) return;
      next = i + 1 < chunks.length ? prepare(chunks[i + 1]!) : undefined;
      yield samples;
    }
  }
}

export interface FilmVoiceOptions {
  /** Where the voice model lives, and is downloaded to on first use. */
  modelsDir: string;
  voice: NeuralVoiceName;
  fx: FxPreset;
  /** Download the model if it isn't there yet. */
  download: boolean;
  onReady?: (downloaded: boolean) => void;
  onError?: (err: Error) => void;
  /** Replaces downloading and loading the model (for tests). */
  load?: (signal: AbortSignal) => Promise<Narrator>;
}

/** The film voice, loading in the background: from disk in a second or two, or downloaded on first use. */
export class FilmVoice {
  /** The model was already downloaded, so it's worth a brief wait rather than using a stand-in. */
  readonly onDisk: boolean;
  #narrator: Narrator | null = null;
  #failed = false;
  #fx: FxPreset;
  readonly #ready: Promise<Narrator | null>;
  readonly #controller = new AbortController();

  constructor(options: FilmVoiceOptions) {
    const { modelsDir, voice, download, onReady = () => {}, onError = () => {} } = options;
    this.#fx = options.fx;
    this.onDisk = Object.values(voiceModelPaths(modelsDir)).every((file) => fs.existsSync(file));
    if (!this.onDisk && !download) {
      this.#failed = true;
      this.#ready = Promise.resolve(null);
      return;
    }
    const signal = this.#controller.signal;
    const load =
      options.load ??
      (async () => new Narrator(await createKokoro(await ensureVoiceModel(modelsDir, { signal }), voice), this.#fx));
    this.#ready = load(signal).then(
      (narrator) => {
        if (signal.aborted) return null;
        narrator.fx = this.#fx;
        this.#narrator = narrator;
        onReady(!this.onDisk);
        return narrator;
      },
      (err: Error) => {
        this.#failed = true;
        if (!signal.aborted) onError(err);
        return null;
      },
    );
  }

  /** The narrator, once loaded (and unless it has failed). */
  get narrator(): Narrator | null {
    return this.#failed ? null : this.#narrator;
  }

  /** Whether the film voice is loading or loaded: false once it has failed or been closed. */
  get usable(): boolean {
    return !this.#failed;
  }

  get fx(): FxPreset {
    return this.#fx;
  }

  set fx(preset: FxPreset) {
    this.#fx = preset;
    if (this.#narrator) this.#narrator.fx = preset;
  }

  /**
   * The narrator if it's loaded. If it's still loading from disk, waits up to `timeoutMs`
   * for it; if it's still downloading, doesn't wait.
   */
  async whenReady(timeoutMs: number): Promise<Narrator | null> {
    if (this.#failed || this.#narrator || !this.onDisk) return this.narrator;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<null>((resolve) => (timer = setTimeout(resolve, timeoutMs, null)));
    try {
      await Promise.race([this.#ready, timeout]);
    } finally {
      clearTimeout(timer);
    }
    return this.narrator;
  }

  /** Gives up on the film voice for this session, for example after a playback failure. */
  fail(): void {
    this.#failed = true;
  }

  /** Stops a download in progress. */
  close(): void {
    this.#failed = true;
    this.#controller.abort();
  }
}
