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
  /** How long to wait for a command after "Hey JARVIS" on its own. */
  commandTimeoutMs?: number;
}

/** The "Hey JARVIS" conversation flow on top of the ears. */
export class VoiceInput {
  readonly #options: VoiceInputOptions;

  constructor(options: VoiceInputOptions) {
    this.#options = options;
  }

  /**
   * Resolves with the next spoken command. Speech that doesn't start with the wake
   * phrase is ignored. "Hey JARVIS, what time is it?" yields the command directly;
   * "Hey JARVIS" alone gets an acknowledgement and the next utterance is the command.
   */
  async waitForCommand(signal: AbortSignal): Promise<string> {
    const { hearing, honorific, commandTimeoutMs = 8000 } = this.#options;
    while (true) {
      const wake = matchWakePhrase(await hearing.nextUtterance(signal));
      if (!wake) continue;
      if (wake.command) return wake.command;

      const reply = `Yes, ${honorific}?`;
      this.#options.acknowledge(reply);
      await this.#options.speak(reply);
      try {
        const heard = await hearing.nextUtterance(signal, { speechStartTimeoutMs: commandTimeoutMs });
        // People often repeat the wake phrase: "Hey JARVIS... hey JARVIS, lights."
        const command = matchWakePhrase(heard)?.command ?? heard;
        if (command) return command;
      } catch (err) {
        if (!(err instanceof NoSpeechError)) throw err;
        this.#options.note("(I didn't hear a request, so I've gone back to standby)");
      }
    }
  }

  /** Asks aloud whether to proceed and interprets the spoken answer. */
  async confirm(question: string, signal: AbortSignal): Promise<Confirmation> {
    await this.#options.speak(`${question} Shall I proceed?`);
    return parseConfirmation(await this.#options.hearing.nextUtterance(signal));
  }
}
