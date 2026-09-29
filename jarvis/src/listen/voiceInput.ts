import { NoSpeechError, type Hearing } from "./ears.ts";
import { matchWakePhrase, parseConfirmation, type Confirmation } from "./wake.ts";

export interface VoiceInputOptions {
  hearing: Hearing;
  /** Speaks a line and resolves when it has finished playing. */
  speak: (text: string) => Promise<void>;
  /** Shows JARVIS's acknowledgement once the wake phrase is heard alone. */
  acknowledge: (text: string) => void;
  note: (text: string) => void;
  honorific: string;
  /** How long to wait for a request after "Hey JARVIS" on its own. */
  commandTimeoutMs?: number;
}

/** The "Hey JARVIS" conversation flow on top of the ears. */
export class VoiceInput {
  readonly #options: VoiceInputOptions;

  constructor(options: VoiceInputOptions) {
    this.#options = options;
  }

  /**
   * Resolves with the next spoken request. "Hey JARVIS, what time is it?" yields the
   * request directly; "Hey JARVIS" alone gets "Yes, sir?" and the next utterance is the
   * request. Speech without the wake phrase is ignored.
   */
  async waitForCommand(signal: AbortSignal): Promise<string> {
    while (true) {
      const command = (await this.waitForWakePhrase(signal)) || (await this.askForRequest(signal));
      if (command) return command;
    }
  }

  /** Waits for the wake phrase. Resolves with the request said with it, or "" if none was. */
  async waitForWakePhrase(signal: AbortSignal): Promise<string> {
    while (true) {
      const wake = matchWakePhrase(await this.#options.hearing.nextUtterance(signal));
      if (wake) return wake.command;
    }
  }

  /** Answers "Yes, sir?" and listens for the request. Resolves "" if nobody says anything. */
  async askForRequest(signal: AbortSignal): Promise<string> {
    const { hearing, honorific, commandTimeoutMs = 8000 } = this.#options;
    const reply = `Yes, ${honorific}?`;
    this.#options.acknowledge(reply);
    await this.#options.speak(reply);
    try {
      const heard = await hearing.nextUtterance(signal, { speechStartTimeoutMs: commandTimeoutMs });
      // People often repeat the wake phrase: "Hey JARVIS... hey JARVIS, lights."
      return matchWakePhrase(heard)?.command ?? heard;
    } catch (err) {
      if (!(err instanceof NoSpeechError)) throw err;
      this.#options.note("(I didn't hear a request, so I've gone back to standby)");
      return "";
    }
  }

  /** Asks aloud whether to proceed and interprets the spoken answer. */
  async confirm(question: string, signal: AbortSignal): Promise<Confirmation> {
    // Start listening before asking, so an answer that interrupts the question counts.
    const answer = this.#options.hearing.nextUtterance(signal);
    answer.catch(() => {}); // Awaited below; this just keeps an early abort from going unhandled.
    await this.#options.speak(`${question} Shall I proceed?`);
    const heard = await answer;
    return parseConfirmation(matchWakePhrase(heard)?.command ?? heard);
  }
}
