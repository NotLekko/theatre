import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import type { Config } from "./config.ts";
import { Jarvis, type TurnObserver } from "./jarvis.ts";
import { Ears } from "./listen/ears.ts";
import { ensureSpeechModels } from "./models.ts";
import { VoiceInput } from "./listen/voiceInput.ts";
import { isStopRequest, type Confirmation } from "./listen/wake.ts";
import { MemoryStore } from "./memory.ts";
import { buildSystemPrompt } from "./persona.ts";
import { Reminders } from "./reminders.ts";
import { localTools, serverTools, type ToolContext } from "./tools.ts";

/** What a front end (the terminal, the web HUD) provides to a session. */
export interface SessionUI extends TurnObserver {
  /** A line from JARVIS outside a streamed answer, such as a refusal or an acknowledgement. */
  say(text: string): void;
  note(text: string): void;
  error(text: string): void;
  reminder(text: string): void;
  /** Shows a spoken request. `atPrompt` is false when it was said while JARVIS was busy. */
  heard(text: string, atPrompt: boolean): void;
  /** "Hey JARVIS" was said on its own: show "Yes, sir?"; he's now listening for the request. */
  acknowledge(text: string): void;
  /** Progress while voice input starts (downloads and so on); null clears it. */
  voiceStatus(text: string | null): void;
  voiceInputChanged(on: boolean, microphone?: string): void;
  turnStarted(input: string): void;
  turnEnded(outcome: "answered" | "refused" | "interrupted" | "failed"): void;
  /** Speaks a line and resolves when it has finished or been stopped. */
  speak(text: string): Promise<void>;
  stopSpeaking(): void;
  /** Asks the user to approve an action. Aborted if they answer out loud first. */
  askApproval(question: string, signal: AbortSignal): Promise<Confirmation>;
  /** Shows an approval answered out loud. */
  approvedByVoice(answer: Confirmation): void;
}

export interface Request {
  text: string;
  spoken: boolean;
  /** Whether it was given at the prompt, rather than while JARVIS was busy. */
  atPrompt: boolean;
}

/** A promise that never settles: a race entrant that has dropped out. */
const never = <T>() => new Promise<T>(() => {});

export function describeError(err: unknown, model: string): string {
  if (err instanceof Anthropic.AuthenticationError) {
    return "My credentials were rejected. Check ANTHROPIC_API_KEY, or sign in with `ant auth login`.";
  }
  if (err instanceof Anthropic.PermissionDeniedError) return `Access denied: ${err.message}`;
  if (err instanceof Anthropic.NotFoundError) return `The model "${model}" isn't available to this account.`;
  if (err instanceof Anthropic.RateLimitError) return "We're being rate-limited. Give it a moment, then try again.";
  if (err instanceof Anthropic.BadRequestError) return `The API rejected the request: ${err.message}`;
  if (err instanceof Anthropic.InternalServerError) {
    return `Anthropic's servers are having trouble (${err.status}). Try again shortly.`;
  }
  if (err instanceof Anthropic.APIConnectionError) return "I can't reach Anthropic's servers. Check your network connection.";
  if (err instanceof Anthropic.APIError) return `API error ${err.status ?? ""}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

/**
 * One conversation with JARVIS: the model, tools, memory, reminders and voice input,
 * independent of how it's displayed.
 */
export class Session {
  readonly config: Config;
  readonly ui: SessionUI;
  readonly memory: MemoryStore;
  readonly reminders: Reminders;
  readonly jarvis: Jarvis;
  #current: AbortController | null = null;
  #idle: AbortController | null = null;
  #approveAll = false;
  #listening: { ears: Ears; input: VoiceInput } | null = null;
  /** "Hey JARVIS" heard while he was working on something: the request that came with it. */
  #interruption: { request: string } | null = null;
  #lastSpeech: { done: Promise<void>; text: string } | null = null;

  constructor(config: Config, ui: SessionUI, client = new Anthropic()) {
    this.config = config;
    this.ui = ui;
    this.memory = new MemoryStore(path.join(config.home, "memory.json"));
    this.reminders = new Reminders((reminder) => {
      ui.reminder(reminder.message);
      void this.speak(`Pardon the interruption, ${config.honorific}. You asked me to remind you: ${reminder.message}`);
    });
    this.jarvis = new Jarvis({
      client,
      model: config.model,
      effort: config.effort,
      system: this.systemPrompt(),
      localTools,
      serverTools: serverTools(config.location),
    });
  }

  systemPrompt(): string {
    return buildSystemPrompt({
      honorific: this.config.honorific,
      userName: this.config.userName,
      memories: this.memory.list(),
    });
  }

  get listening(): boolean {
    return this.#listening !== null;
  }

  get busy(): boolean {
    return this.#current !== null;
  }

  /** Starts a fresh conversation; it picks up memories saved since the last one. */
  reset(): void {
    this.jarvis.reset(this.systemPrompt());
    this.#approveAll = false;
  }

  /** Speaks a line. While it plays, the ears only listen for "Hey JARVIS", which cuts him off. */
  speak(text: string): Promise<void> {
    const done = this.ui.speak(text);
    this.#lastSpeech = { done, text };
    this.#listening?.ears.whileSpeaking(done, text);
    return done;
  }

  /** Runs one exchange. Resolves false if it didn't produce an answer. */
  async converse(input: string): Promise<boolean> {
    const controller = new AbortController();
    this.#current = controller;
    this.ui.stopSpeaking();
    // "Hey JARVIS" while he's working drops the current request; the next call to
    // nextRequest() then takes up the new one (or just stands by, for "stop").
    const listener = new AbortController();
    this.#listening?.input.waitForWakePhrase(listener.signal).then(
      (request) => {
        this.#interruption = { request };
        controller.abort();
      },
      () => {},
    );
    const ctx: ToolContext = {
      memory: this.memory,
      reminders: this.reminders,
      signal: controller.signal,
      confirm: (question) => this.#confirm(question, controller.signal),
    };
    this.ui.turnStarted(input);
    try {
      const result = await this.jarvis.respond(input, this.ui, ctx);
      if (result.kind === "refused") {
        this.ui.turnEnded("refused");
        const line = `I'm afraid I can't help with that one, ${this.config.honorific}.`;
        this.ui.say(line);
        void this.speak(line);
        return false;
      }
      this.ui.turnEnded("answered");
      if (result.truncated) this.ui.note("(my answer was cut short)");
      void this.speak(result.text);
      return true;
    } catch (err) {
      if (controller.signal.aborted) {
        this.ui.turnEnded("interrupted");
        this.ui.note(this.#interruption ? "🎙 (interrupted)" : "(interrupted)");
      } else {
        this.ui.turnEnded("failed");
        this.ui.error(describeError(err, this.jarvis.model));
      }
      return false;
    } finally {
      listener.abort();
      this.#current = null;
    }
  }

  async #confirm(question: string, signal: AbortSignal): Promise<boolean> {
    if (this.#approveAll) {
      this.ui.note("(approved: you allowed all commands this session)");
      return true;
    }
    // Take an answer from the UI or, when listening, out loud - whichever comes first.
    const settled = new AbortController();
    const either = AbortSignal.any([signal, settled.signal]);
    const given = this.ui.askApproval(question, either);
    const spoken = this.#listening
      ? this.#listening.input.confirm(question, either).then((answer) => ({ answer }), never<{ answer: Confirmation }>)
      : never<{ answer: Confirmation }>();
    let winner: Confirmation | { answer: Confirmation };
    try {
      winner = await Promise.race([given, spoken]);
    } finally {
      settled.abort();
      given.catch(() => {});
    }
    const answer = typeof winner === "string" ? winner : winner.answer;
    if (typeof winner !== "string") this.ui.approvedByVoice(answer);
    // Answered without speaking: no need to finish asking out loud.
    else if (this.#listening) this.ui.stopSpeaking();
    if (answer === "always") this.#approveAll = true;
    return answer !== "no";
  }

  /**
   * Waits for the next request: typed (from `typed`, which rejects when its signal aborts)
   * or, when listening, spoken. A request spoken while JARVIS was busy comes first.
   * Resolves null when the wait is interrupted.
   */
  async nextRequest(typed: (signal: AbortSignal) => Promise<string>): Promise<Request | null> {
    const pending = this.#interruption?.request;
    this.#interruption = null;
    if (pending && !isStopRequest(pending)) return { text: pending, spoken: true, atPrompt: false };
    if (pending) this.ui.note("🎙 Standing by.");

    const controller = new AbortController();
    this.#idle = controller;
    const fromUser = typed(controller.signal).then((text): Request => ({ text, spoken: false, atPrompt: true }));
    // If the microphone fails, voice drops out of the race and the other input carries on.
    const spoken = this.#listening
      ? this.#voiceRequest(this.#listening.input, controller.signal, pending === "").then(
          (text): Request => ({ text, spoken: true, atPrompt: true }),
          never<Request>,
        )
      : never<Request>();
    try {
      return await Promise.race([fromUser, spoken]);
    } catch {
      return null;
    } finally {
      this.#idle = null;
      controller.abort();
      fromUser.catch(() => {});
    }
  }

  /** The next spoken request, skipping any that only ask JARVIS to stop. */
  async #voiceRequest(voiceInput: VoiceInput, signal: AbortSignal, woken: boolean): Promise<string> {
    let request = woken ? await voiceInput.askForRequest(signal) : "";
    while (true) {
      request ||= await voiceInput.waitForCommand(signal);
      if (!isStopRequest(request)) return request;
      this.ui.note("🎙 Standing by.");
      request = "";
    }
  }

  /** Cancels the answer in progress, if any. */
  cancelTurn(): boolean {
    if (!this.#current) return false;
    this.#current.abort();
    return true;
  }

  /** Cancels the answer in progress or, failing that, the wait for the next request. */
  interrupt(): boolean {
    if (this.cancelTurn()) return true;
    if (!this.#idle) return false;
    this.#idle.abort();
    return true;
  }

  async startListening(): Promise<void> {
    if (this.#listening) {
      this.ui.note('Already listening for "Hey JARVIS".');
      return;
    }
    const ui = this.ui;
    try {
      const models = await ensureSpeechModels(path.join(this.config.home, "models"), {
        onProgress: (message) => ui.voiceStatus(message),
      });
      ui.voiceStatus("Starting the microphone");
      const ears = await Ears.open(models, {
        microphone: { deviceIndex: this.config.micDevice },
        onError: (err) => {
          this.stopListening();
          ui.error(`Voice input stopped: ${err.message}`);
        },
        onBargeIn: () => {
          ui.stopSpeaking();
          ui.note("🎙 (interrupted)");
        },
      });
      // He may still be finishing a sentence.
      if (this.#lastSpeech) ears.whileSpeaking(this.#lastSpeech.done, this.#lastSpeech.text);
      const input = new VoiceInput({
        hearing: ears,
        honorific: this.config.honorific,
        speak: (text) => this.speak(text),
        acknowledge: (text) => ui.acknowledge(text),
        note: (text) => ui.note(text),
      });
      this.#listening = { ears, input };
      ui.voiceStatus(null);
      ui.voiceInputChanged(true, ears.microphoneName);
    } catch (err) {
      ui.voiceStatus(null);
      ui.error(`Voice input is unavailable: ${(err as Error).message}`);
    }
  }

  stopListening(): void {
    if (!this.#listening) return;
    this.#listening.ears.close();
    this.#listening = null;
    this.ui.voiceInputChanged(false);
  }

  close(): void {
    this.stopListening();
    this.reminders.cancelAll();
  }
}
