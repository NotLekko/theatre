import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Ears, NoSpeechError } from "../src/listen/ears.ts";
import type { SpeechEngine } from "../src/listen/engine.ts";

// A fake speech engine. Audio arrives in 512-sample frames whose value encodes one word:
// a user's word is its index in WORDS / 1000; a word in JARVIS's voice is (500 + index) / 1000;
// 0 is silence. It "hears" and "transcribes" those codes deterministically.
const WORDS = ["", "hey", "jarvis", "what", "about", "tomorrow", "the", "forecast", "shows", "rain", "stop", "yes", "evening"];
const FRAME = 512;
const JARVIS = 500;

const code = (frame: Float32Array) => Math.round(frame[0]! * 1000);
const wordOf = (value: number) => WORDS[value % JARVIS]!;

class FakeEngine implements SpeechEngine {
  deafSpotter = false;
  transcriptions: string[] = [];
  #segment: Float32Array[] = [];
  #silence = 0;
  #segments: Float32Array[] = [];
  #lastUserWord = "";

  vad = {
    accept: (window: Float32Array) => {
      if (code(window) !== 0) {
        this.#segment.push(window.slice());
        this.#silence = 0;
      } else if (this.#segment.length > 0 && ++this.#silence >= 3) {
        // Three silent frames end an utterance.
        this.#segments.push(concat(this.#segment));
        this.#segment = [];
      }
    },
    speechDetected: () => this.#segment.length > 0,
    takeSegments: () => this.#segments.splice(0),
    reset: () => {
      this.#segment = [];
      this.#segments = [];
      this.#silence = 0;
    },
  };

  wakeWord = {
    accept: (samples: Float32Array) => {
      for (let i = 0; i < samples.length; i += FRAME) {
        const value = code(samples.subarray(i, i + FRAME));
        if (value === 0 || value >= JARVIS) continue;
        const word = wordOf(value);
        if (word === this.#lastUserWord) continue;
        const fired = this.#lastUserWord === "hey" && word === "jarvis" && !this.deafSpotter;
        this.#lastUserWord = word;
        if (fired) return true;
      }
      return false;
    },
    reset: () => {
      this.#lastUserWord = "";
    },
  };

  async transcribe(samples: Float32Array): Promise<string> {
    const words: string[] = [];
    let previous = -1;
    for (let i = 0; i < samples.length; i += FRAME) {
      const value = code(samples.subarray(i, i + FRAME));
      if (value !== previous && value !== 0) words.push(wordOf(value));
      previous = value;
    }
    const text = words.join(" ");
    this.transcriptions.push(text);
    return text;
  }
}

function concat(parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Frames for a script like "you: hey jarvis | jarvis: the forecast | silence: 5". */
function frames(script: string): Float32Array[] {
  const out: Float32Array[] = [];
  for (const part of script.split("|").map((p) => p.trim())) {
    const [who, rest = ""] = part.split(":").map((p) => p.trim()) as [string, string];
    if (who === "silence") {
      for (let i = 0; i < Number(rest); i++) out.push(new Float32Array(FRAME));
      continue;
    }
    for (const word of rest.split(/\s+/)) {
      const index = WORDS.indexOf(word);
      assert.ok(index > 0, `unknown word ${word}`);
      // Each word lasts four frames.
      for (let i = 0; i < 4; i++) out.push(new Float32Array(FRAME).fill((who === "jarvis" ? JARVIS + index : index) / 1000));
    }
  }
  return out;
}

async function setup() {
  const engine = new FakeEngine();
  let hear: (samples: Float32Array) => void = () => {};
  let bargeIns = 0;
  let onBargeIn = () => {};
  const ears = await Ears.withEngine(engine, {
    openMicrophone: async (onAudio) => {
      hear = onAudio;
      return { name: "fake", close() {} };
    },
    onError: (err) => assert.fail(err),
    onBargeIn: () => {
      bargeIns++;
      onBargeIn();
    },
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
  return {
    engine,
    ears,
    bargeIns: () => bargeIns,
    onBargeIn: (fn: () => void) => (onBargeIn = fn),
    /** Plays the script into the microphone, letting pending transcriptions finish. */
    async play(script: string) {
      for (const frame of frames(script)) {
        hear(frame);
        await settle();
      }
      await settle();
    },
  };
}

/** A stand-in for JARVIS talking, which ends when stop() is called. */
function speech() {
  let stop!: () => void;
  const done = new Promise<void>((resolve) => (stop = resolve));
  return { done, stop };
}

describe("Ears", () => {
  it("transcribes each utterance for whoever is waiting", async () => {
    const { ears, play } = await setup();
    const heard = ears.nextUtterance(new AbortController().signal);
    await play("silence: 2 | you: hey jarvis what about tomorrow | silence: 4");
    assert.equal(await heard, "hey jarvis what about tomorrow");
  });

  it("gives an utterance to the most recent listener", async () => {
    const { ears, play } = await setup();
    const general = new AbortController();
    const first = ears.nextUtterance(general.signal);
    const question = ears.nextUtterance(new AbortController().signal);
    await play("you: yes | silence: 4");
    assert.equal(await question, "yes");
    general.abort(new Error("done"));
    await assert.rejects(first, /done/);
  });

  it("ignores sound while nobody is listening", async () => {
    const { ears, engine, play } = await setup();
    await play("you: what about tomorrow | silence: 4");
    assert.deepEqual(engine.transcriptions, []);
    const heard = ears.nextUtterance(new AbortController().signal);
    await play("you: yes | silence: 4");
    assert.equal(await heard, "yes");
  });

  it("gives up when nobody starts speaking in time", async () => {
    const { ears } = await setup();
    await assert.rejects(ears.nextUtterance(new AbortController().signal, { speechStartTimeoutMs: 20 }), NoSpeechError);
  });

  describe("while JARVIS is speaking", () => {
    it("ignores speech without the wake phrase, his own included", async () => {
      const { ears, play, bargeIns } = await setup();
      const talking = speech();
      ears.whileSpeaking(talking.done);
      const heard = ears.nextUtterance(new AbortController().signal);
      await play("jarvis: the forecast shows rain | you: what about tomorrow | jarvis: evening | silence: 4");
      assert.equal(bargeIns(), 0);

      talking.stop();
      await play("silence: 2 | you: yes | silence: 4");
      assert.equal(await heard, "yes", "only speech after he stopped is heard");
    });

    it("stops him on the wake phrase and picks up a request said in the same breath", async () => {
      const { ears, play, bargeIns, onBargeIn } = await setup();
      const talking = speech();
      ears.whileSpeaking(talking.done, "The forecast shows rain, clearing by evening.");
      onBargeIn(talking.stop);
      const heard = ears.nextUtterance(new AbortController().signal);
      await play("jarvis: the forecast shows | you: hey jarvis what about tomorrow | silence: 4");
      assert.equal(bargeIns(), 1);
      assert.equal(await heard, "Hey Jarvis, What about tomorrow");
    });

    it("doesn't mistake the tail of his own sentence for a request", async () => {
      const { ears, play, onBargeIn } = await setup();
      const talking = speech();
      ears.whileSpeaking(talking.done, "The forecast shows rain, clearing by evening.");
      onBargeIn(talking.stop);
      const heard = ears.nextUtterance(new AbortController().signal);
      // His voice runs on briefly after the phrase; that mustn't become a request.
      await play("jarvis: the forecast | you: hey jarvis | jarvis: evening | silence: 40");
      assert.equal(await heard, "Hey Jarvis.");
    });

    it("also catches the wake phrase in a transcript when the keyword spotter misses it", async () => {
      const { ears, engine, play, bargeIns, onBargeIn } = await setup();
      engine.deafSpotter = true;
      const talking = speech();
      ears.whileSpeaking(talking.done, "The forecast shows rain.");
      onBargeIn(talking.stop);
      const heard = ears.nextUtterance(new AbortController().signal);
      await play("jarvis: the forecast shows rain | you: hey jarvis stop | silence: 40");
      assert.equal(bargeIns(), 1);
      assert.equal(await heard, "Hey Jarvis, Stop");
    });

    it("without knowing his words, only trusts speech that continues after he stops", async () => {
      const { ears, play, onBargeIn } = await setup();
      const talking = speech();
      ears.whileSpeaking(talking.done);
      onBargeIn(talking.stop);
      const alone = ears.nextUtterance(new AbortController().signal);
      await play("jarvis: the forecast | you: hey jarvis | silence: 40");
      assert.equal(await alone, "Hey Jarvis.");

      const again = speech();
      ears.whileSpeaking(again.done);
      onBargeIn(again.stop);
      const request = ears.nextUtterance(new AbortController().signal);
      await play("jarvis: the forecast | you: hey jarvis what about tomorrow | silence: 4");
      assert.equal(await request, "Hey Jarvis, What about tomorrow");
    });

    it("drops an interruption if nobody is listening by the time it ends", async () => {
      const { ears, play, onBargeIn } = await setup();
      const talking = speech();
      ears.whileSpeaking(talking.done);
      onBargeIn(talking.stop);
      const listener = new AbortController();
      const heard = ears.nextUtterance(listener.signal);
      heard.catch(() => {});
      await play("jarvis: the forecast | you: hey jarvis what");
      listener.abort(new Error("typed instead"));
      await play("you: about tomorrow | silence: 4");

      const next = ears.nextUtterance(new AbortController().signal);
      await play("you: yes | silence: 4");
      assert.equal(await next, "yes");
    });
  });
});
