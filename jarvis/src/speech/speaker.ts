import type { VoiceEngine } from "../config.ts";
import { Voice } from "../voice.ts";
import type { FxPreset } from "./fx.ts";
import type { NeuralVoiceName } from "./kokoro.ts";
import { FilmVoice, speechChunks, type Narrator } from "./narrator.ts";
import { detectPlayer, type Player } from "./player.ts";
import { encodeWav } from "./wav.ts";

/** What the speaker needs from the operating system's own voice. */
export interface SystemVoice {
  readonly available: boolean;
  readonly engineName: string | undefined;
  speak(text: string): void;
  stop(): void;
  finished(timeoutMs: number): Promise<void>;
}

export interface SpeakerOptions {
  enabled: boolean;
  engine: VoiceEngine;
  /** The film voice, used when `engine` is "neural". */
  neuralVoice: NeuralVoiceName;
  /** The operating system voice, used with the "system" engine and as the stand-in. */
  systemVoiceName: string | undefined;
  fx: FxPreset;
  /** Where the voice model lives. */
  modelsDir: string;
  /** Download the film voice if it isn't there yet (it's 132 MB). */
  download: boolean;
  /** Tells the user the film voice is ready, or why the system voice is standing in. */
  onNotice: (message: string) => void;
  // For tests.
  player?: Player | null;
  system?: SystemVoice;
  loadNarrator?: (signal: AbortSignal) => Promise<Narrator>;
}

// How long to wait for the film voice to load from disk before using the stand-in.
const LOAD_WAIT_MS = 20_000;

/**
 * JARVIS's voice in the terminal: the film voice when it's available, otherwise the
 * operating system's voice. On first run the film voice downloads in the background and
 * the system voice stands in until it's ready.
 */
export class Speaker {
  readonly #options: SpeakerOptions;
  readonly #system: SystemVoice;
  readonly #player: Player | null;
  #film: FilmVoice | null = null;
  #enabled = false;
  #controller: AbortController | null = null;
  #current: Promise<void> | null = null;

  constructor(options: SpeakerOptions) {
    this.#options = options;
    this.#system = options.system ?? new Voice(true, options.engine === "system" ? options.systemVoiceName : undefined);
    this.#player = options.engine === "neural" ? (options.player === undefined ? detectPlayer() : options.player) : null;
    this.enabled = options.enabled;
  }

  /** Whether the film voice is loaded, or on its way. */
  get #neural(): boolean {
    return this.#player !== null && (this.#film?.usable ?? true);
  }

  /** Whether any voice can speak on this machine. */
  get available(): boolean {
    return this.#neural || this.#system.available;
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  set enabled(on: boolean) {
    this.#enabled = on && this.available;
    if (!this.#enabled) this.stop();
    else if (this.#player && !this.#film) this.#startFilmVoice();
  }

  get fx(): FxPreset {
    return this.#film?.fx ?? this.#options.fx;
  }

  set fx(preset: FxPreset) {
    this.#options.fx = preset;
    if (this.#film) this.#film.fx = preset;
  }

  /** Whether the film voice is in use (loaded or on its way), so effects apply. */
  get filmVoice(): boolean {
    return this.#neural;
  }

  /** A description for the start-up checks. */
  get engineName(): string {
    const system = this.#system.engineName ?? "no system voice";
    if (this.#options.engine === "system") return system;
    if (!this.#player) return `${system} (no audio player found for the film voice)`;
    if (!this.#neural) return system;
    const film = `film voice (${this.#options.neuralVoice}, ${this.fx} effects) via ${this.#player.name}`;
    return this.#film && !this.#film.onDisk && !this.#film.narrator
      ? `${film}; downloading it, ${system} until then`
      : film;
  }

  #startFilmVoice(): void {
    const { modelsDir, neuralVoice, fx, download, onNotice } = this.#options;
    this.#film = new FilmVoice({
      modelsDir,
      voice: neuralVoice,
      fx,
      download,
      load: this.#options.loadNarrator,
      onReady: (downloaded) => {
        if (downloaded) onNotice("🔊 My film voice is ready.");
      },
      onError: (err) => this.#fallBack(`I couldn't load my film voice: ${err.message}`),
    });
  }

  /** Gives up on the film voice for this session. */
  #fallBack(reason: string): void {
    this.#film?.fail();
    this.#player?.close();
    this.#options.onNotice(
      `🔊 ${reason}. ${this.#system.available ? `Using ${this.#system.engineName} instead.` : "I'll keep to text."}`,
    );
  }

  speak(text: string): void {
    if (!this.#enabled) return;
    this.stop();
    const film = this.#film;
    if (!film?.usable) {
      this.#system.speak(text);
      return;
    }
    const controller = new AbortController();
    this.#controller = controller;
    this.#current = (async () => {
      const narrator = film.narrator ?? (await film.whenReady(LOAD_WAIT_MS));
      if (controller.signal.aborted) return;
      if (narrator) await this.#play(narrator, text, controller.signal);
      else this.#system.speak(text);
    })();
  }

  async #play(narrator: Narrator, text: string, signal: AbortSignal): Promise<void> {
    const player = this.#player!;
    try {
      for await (const samples of narrator.render(speechChunks(text), signal)) {
        await player.play(encodeWav(samples, narrator.sampleRate), signal);
        if (signal.aborted) return;
      }
    } catch (err) {
      if (signal.aborted) return;
      this.#fallBack(`My film voice failed: ${(err as Error).message}`);
      this.#system.speak(text);
    }
  }

  stop(): void {
    this.#controller?.abort();
    this.#controller = null;
    this.#current = null;
    this.#system.stop();
  }

  /** Resolves once the current utterance ends, or after `timeoutMs`. */
  async finished(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    if (this.#current) {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<void>((resolve) => (timer = setTimeout(resolve, timeoutMs)));
      await Promise.race([this.#current, timeout]);
      clearTimeout(timer);
    }
    await this.#system.finished(Math.max(0, deadline - Date.now()));
  }

  close(): void {
    this.stop();
    this.#film?.close();
    this.#player?.close();
  }
}
