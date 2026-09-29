import { createRequire } from "node:module";
import type { VoiceModelPaths } from "../models.ts";

/** Turns text into speech: mono float samples in [-1, 1]. */
export interface Synthesizer {
  readonly sampleRate: number;
  synthesize(text: string): Promise<Float32Array>;
}

/**
 * Kokoro's British male voices and their speaker ids in the v1.0 model. Fable is the
 * default: the lowest and most measured of the four, closest to JARVIS in the films.
 */
export const NEURAL_VOICES = { bm_fable: 25, bm_daniel: 24, bm_george: 26, bm_lewis: 27 } as const;
export type NeuralVoiceName = keyof typeof NEURAL_VOICES;
export const DEFAULT_NEURAL_VOICE: NeuralVoiceName = "bm_fable";

export function isNeuralVoice(name: string): name is NeuralVoiceName {
  return Object.hasOwn(NEURAL_VOICES, name);
}

// JARVIS speaks crisply: a touch quicker than Kokoro's natural pace.
const SPEED = 1.08;

// The parts of sherpa-onnx-node used here (the package ships no type declarations).
interface SherpaTts {
  sampleRate: number;
  generateAsync(request: { text: string; sid: number; speed: number }): Promise<{ samples: Float32Array; sampleRate: number }>;
}
interface Sherpa {
  OfflineTts: { createAsync(config: object): Promise<SherpaTts> };
}

/** Loads Kokoro with one of its British voices. */
export async function createKokoro(paths: VoiceModelPaths, voice: NeuralVoiceName): Promise<Synthesizer> {
  let sherpa: Sherpa;
  try {
    sherpa = createRequire(import.meta.url)("sherpa-onnx-node") as Sherpa;
  } catch (err) {
    throw new Error(
      `the film voice needs the optional package sherpa-onnx-node, which couldn't be loaded ` +
        `(${(err as Error).message.split("\n")[0]}). Run npm install in the jarvis folder.`,
    );
  }
  const tts = await sherpa.OfflineTts.createAsync({
    model: {
      kokoro: {
        model: paths.model,
        voices: paths.voices,
        tokens: paths.tokens,
        dataDir: paths.dataDir,
        lexicon: paths.lexicon,
        // Received Pronunciation for anything the lexicon doesn't cover.
        lang: "en-gb-x-rp",
      },
      numThreads: 2,
      debug: false,
    },
    maxNumSentences: 1,
  });

  // One synthesis at a time: the model isn't meant to be run concurrently.
  let queue: Promise<unknown> = Promise.resolve();
  return {
    sampleRate: tts.sampleRate,
    synthesize(text) {
      const result = queue.then(async () => (await tts.generateAsync({ text, sid: NEURAL_VOICES[voice], speed: SPEED })).samples);
      queue = result.catch(() => {});
      return result;
    },
  };
}
