import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { SAMPLE_RATE } from "./microphone.ts";
import type { SpeechModelPaths } from "./models.ts";

/**
 * The speech models the ears use, behind a small interface so the listening logic can be
 * tested without them. Audio is 16 kHz mono floats in [-1, 1].
 */
export interface SpeechEngine {
  /** Voice activity detection, fed 512-sample windows. */
  vad: {
    accept(window: Float32Array): void;
    /** Whether someone is speaking right now. */
    speechDetected(): boolean;
    /** Utterances that have ended since the last call. */
    takeSegments(): Float32Array[];
    reset(): void;
  };
  /** Streaming keyword spotter for the wake phrase. */
  wakeWord: {
    /** Returns true when the wake phrase has just been heard. */
    accept(samples: Float32Array): boolean;
    reset(): void;
  };
  transcribe(samples: Float32Array): Promise<string>;
}

// The parts of sherpa-onnx-node used here (the package ships no type declarations).
interface SherpaVad {
  acceptWaveform(samples: Float32Array): void;
  isDetected(): boolean;
  isEmpty(): boolean;
  front(enableExternalBuffer?: boolean): { start: number; samples: Float32Array };
  pop(): void;
  clear(): void;
  reset(): void;
}
interface Wave {
  sampleRate: number;
  samples: Float32Array;
}
interface SherpaStream {
  acceptWaveform(wave: Wave): void;
}
interface SherpaRecognizer {
  createStream(): SherpaStream;
  decodeAsync(stream: SherpaStream): Promise<{ text: string }>;
}
interface SherpaKeywordSpotter {
  createStream(): SherpaStream;
  isReady(stream: SherpaStream): boolean;
  decode(stream: SherpaStream): void;
  reset(stream: SherpaStream): void;
  getResult(stream: SherpaStream): { keyword: string };
}
interface Sherpa {
  Vad: new (config: object, bufferSizeInSeconds: number) => SherpaVad;
  OfflineRecognizer: { createAsync(config: object): Promise<SherpaRecognizer> };
  KeywordSpotter: new (config: object) => SherpaKeywordSpotter;
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

// The wake phrases as tokens of the keyword model's vocabulary (its bpe.model, via
// sentencepiece): "HEY JARVIS" is "▁HE Y ▁JA R VI S".
const WAKE_KEYWORDS = [
  "▁HE Y ▁JA R VI S @HEY_JARVIS",
  "▁HI ▁JA R VI S @HI_JARVIS",
  "▁O K ▁JA R VI S @OK_JARVIS",
  "▁OKAY ▁JA R VI S @OKAY_JARVIS",
];

export async function createSherpaEngine(models: SpeechModelPaths): Promise<SpeechEngine> {
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
        windowSize: 512,
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
      numThreads: 1,
      debug: false,
    },
  });

  const keywordsFile = path.join(path.dirname(models.kws.tokens), "jarvis-keywords.txt");
  fs.writeFileSync(keywordsFile, WAKE_KEYWORDS.join("\n") + "\n");
  const spotter = new sherpa.KeywordSpotter({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: models.kws.encoder, decoder: models.kws.decoder, joiner: models.kws.joiner },
      tokens: models.kws.tokens,
      numThreads: 1,
      debug: false,
    },
    maxActivePaths: 4,
    numTrailingBlanks: 1,
    // Tuned on synthetic speech over JARVIS's own voice: more sensitive than the defaults
    // (1.0 and 0.25) with no false alarms on his speech or on other talk.
    keywordsScore: 2.0,
    keywordsThreshold: 0.1,
    keywordsFile,
  });
  let spotterStream = spotter.createStream();

  return {
    vad: {
      accept: (window) => vad.acceptWaveform(window),
      speechDetected: () => vad.isDetected(),
      takeSegments() {
        const segments: Float32Array[] = [];
        while (!vad.isEmpty()) {
          segments.push(vad.front(false).samples);
          vad.pop();
        }
        return segments;
      },
      reset() {
        vad.clear();
        vad.reset();
      },
    },
    wakeWord: {
      accept(samples) {
        spotterStream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples });
        while (spotter.isReady(spotterStream)) {
          spotter.decode(spotterStream);
          if (spotter.getResult(spotterStream).keyword) {
            spotter.reset(spotterStream);
            return true;
          }
        }
        return false;
      },
      reset() {
        spotterStream = spotter.createStream();
      },
    },
    async transcribe(samples) {
      const stream = recognizer.createStream();
      stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples });
      return (await recognizer.decodeAsync(stream)).text.trim();
    },
  };
}
