import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { Ears, NoSpeechError, type Hearing, type ListenOptions } from "../src/listen/ears.ts";
import { openMicrophone } from "../src/listen/microphone.ts";
import { ensureSpeechModels, speechModelPaths } from "../src/models.ts";
import { VoiceInput } from "../src/listen/voiceInput.ts";
import { findWakePhrase, isStopRequest, matchWakePhrase, parseConfirmation } from "../src/listen/wake.ts";

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-listen-"));

describe("matchWakePhrase", () => {
  it("finds the wake phrase and the request that follows it", () => {
    assert.deepEqual(matchWakePhrase("Hey Jarvis, what time is it?"), { command: "What time is it?" });
    assert.deepEqual(matchWakePhrase("hey jarvis open youtube"), { command: "Open youtube" });
    assert.deepEqual(matchWakePhrase("Okay, Jarvis. Run diagnostics."), { command: "Run diagnostics." });
    assert.deepEqual(matchWakePhrase("Uh, hey Jervis, lights"), { command: "Lights" });
  });

  it("treats the wake phrase alone as a request for attention", () => {
    assert.deepEqual(matchWakePhrase("Hey, Jarvis."), { command: "" });
    assert.deepEqual(matchWakePhrase("Hey Jarvis!"), { command: "" });
    assert.deepEqual(matchWakePhrase("hi jarvis"), { command: "" });
  });

  it("ignores speech that merely mentions JARVIS", () => {
    assert.equal(matchWakePhrase("What's the weather like?"), null);
    assert.equal(matchWakePhrase("I told Jarvis to hey"), null);
    assert.equal(matchWakePhrase("Yesterday I said hey Jarvis to my friend"), null);
    assert.equal(matchWakePhrase("Hey Travis"), null);
    assert.equal(matchWakePhrase("They jarvis"), null);
  });
});

describe("findWakePhrase", () => {
  it("finds the wake phrase anywhere, as when it's said over JARVIS", () => {
    assert.deepEqual(findWakePhrase("through the afternoon. Hey, Jarvis, what about tomorrow?"), {
      command: "What about tomorrow?",
    });
    assert.deepEqual(findWakePhrase("clearing by evening hey jarvis"), { command: "" });
    assert.equal(findWakePhrase("Jarvis Cocker is playing at the Albert Hall"), null);
    assert.equal(findWakePhrase("Hey, that reminds me"), null);
  });
});

describe("isStopRequest", () => {
  it("recognizes requests to stop or not bother", () => {
    for (const text of ["Stop.", "Stop talking", "Never mind.", "That's enough, thanks.", "Be quiet", "Cancel that", "Thank you, Jarvis"]) {
      assert.equal(isStopRequest(text), true, text);
    }
  });

  it("leaves real requests alone", () => {
    for (const text of ["Stop the music", "What's the weather?", "Cancel my three o'clock", "Thanks, now check the news"]) {
      assert.equal(isStopRequest(text), false, text);
    }
  });
});

describe("parseConfirmation", () => {
  it("understands spoken answers", () => {
    assert.equal(parseConfirmation("Yes, go ahead."), "yes");
    assert.equal(parseConfirmation("Yeah."), "yes");
    assert.equal(parseConfirmation("Sure thing"), "yes");
    assert.equal(parseConfirmation("Go for it"), "yes");
    assert.equal(parseConfirmation("No, don't do that."), "no");
    assert.equal(parseConfirmation("Nope"), "no");
    assert.equal(parseConfirmation("Yes, always."), "always");
    assert.equal(parseConfirmation("Don't ask again, just do it"), "always");
  });

  it("treats anything unclear or hedged as no", () => {
    assert.equal(parseConfirmation("What's the weather?"), "no");
    assert.equal(parseConfirmation("Yes but don't delete anything"), "no");
    assert.equal(parseConfirmation("Hmm"), "no");
  });
});

/** Hands out scripted utterances; SILENCE stands for nobody speaking before the deadline. */
const SILENCE = Symbol("silence");
class ScriptedHearing implements Hearing {
  readonly script: Array<string | typeof SILENCE>;
  readonly calls: ListenOptions[] = [];
  readonly log: string[];

  constructor(script: Array<string | typeof SILENCE>, log: string[]) {
    this.script = script;
    this.log = log;
  }

  async nextUtterance(signal: AbortSignal, options: ListenOptions = {}): Promise<string> {
    signal.throwIfAborted();
    this.calls.push(options);
    this.log.push("listen");
    const next = this.script.shift();
    if (next === undefined) {
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    }
    if (next === SILENCE) {
      assert.ok(options.speechStartTimeoutMs, "silence only times out when a deadline was set");
      throw new NoSpeechError();
    }
    return next;
  }

  whileSpeaking(): void {}
}

function voiceInput(script: Array<string | typeof SILENCE>) {
  const log: string[] = [];
  const hearing = new ScriptedHearing(script, log);
  const input = new VoiceInput({
    hearing,
    honorific: "sir",
    speak: async (text) => {
      log.push(`speak:${text}`);
    },
    acknowledge: (text) => log.push(`ack:${text}`),
    note: (text) => log.push(`note:${text}`),
  });
  return { input, hearing, log, signal: new AbortController().signal };
}

describe("VoiceInput", () => {
  it("ignores chatter and returns a request made in the same breath as the wake phrase", async () => {
    const { input, log, signal } = voiceInput(["Pass the salt.", "Hey Jarvis, what time is it?"]);
    assert.equal(await input.waitForCommand(signal), "What time is it?");
    assert.deepEqual(log, ["listen", "listen"]);
  });

  it("reports the wake phrase alone as an empty request", async () => {
    const { input, signal } = voiceInput(["Hey Jarvis.", "Hey Jarvis, stop."]);
    assert.equal(await input.waitForWakePhrase(signal), "");
    assert.equal(await input.waitForWakePhrase(signal), "Stop.");
  });

  it("answers a bare wake phrase and takes the next utterance as the request", async () => {
    const { input, hearing, log, signal } = voiceInput(["Hey Jarvis.", "Run a diagnostic."]);
    assert.equal(await input.waitForCommand(signal), "Run a diagnostic.");
    assert.deepEqual(log, ["listen", "ack:Yes, sir?", "speak:Yes, sir?", "listen"]);
    assert.equal(hearing.calls[1]?.speechStartTimeoutMs, 8000);
  });

  it("strips a repeated wake phrase from the request", async () => {
    const { input, signal } = voiceInput(["Hey Jarvis.", "Hey Jarvis, lights on."]);
    assert.equal(await input.waitForCommand(signal), "Lights on.");
  });

  it("goes back to standby when no request follows", async () => {
    const { input, log, signal } = voiceInput(["Hey Jarvis.", SILENCE, "Hey Jarvis, status report."]);
    assert.equal(await input.waitForCommand(signal), "Status report.");
    assert.ok(log.some((line) => line.startsWith("note:") && line.includes("standby")));
  });

  it("stops waiting when aborted", async () => {
    const { input } = voiceInput([]);
    const controller = new AbortController();
    const waiting = input.waitForCommand(controller.signal);
    controller.abort(new Error("typed instead"));
    await assert.rejects(waiting, /typed instead/);
  });

  it("asks aloud before running a command, already listening so the answer can cut in", async () => {
    const { input, log, signal } = voiceInput(["Yes, go ahead."]);
    assert.equal(await input.confirm("Checking the disk.", signal), "yes");
    assert.deepEqual(log, ["listen", "speak:Checking the disk. Shall I proceed?"]);
  });

  it("understands an answer that starts with the wake phrase", async () => {
    const { input, signal } = voiceInput(["Hey Jarvis, yes."]);
    assert.equal(await input.confirm("Checking the disk.", signal), "yes");
  });
});

describe("ensureSpeechModels", { skip: !hasTool("tar") || !hasTool("bzip2") }, () => {
  it("downloads and unpacks the models once", async () => {
    // A stand-in for the GitHub releases: the VAD file, and tarballs shaped like the real ones.
    const release = tempDir();
    fs.mkdirSync(path.join(release, "asr-models"));
    fs.mkdirSync(path.join(release, "kws-models"));
    fs.writeFileSync(path.join(release, "asr-models", "silero_vad.onnx"), "vad");
    const layout = speechModelPaths(tempDir());
    for (const [tag, files] of [
      ["asr-models", layout.asr],
      ["kws-models", layout.kws],
    ] as const) {
      const folder = path.dirname(files.tokens);
      fs.mkdirSync(folder);
      for (const file of Object.values(files)) fs.writeFileSync(file, path.basename(file));
      const archive = path.join(release, tag, `${path.basename(folder)}.tar.bz2`);
      execFileSync("tar", ["-cjf", archive, "-C", path.dirname(folder), path.basename(folder)]);
    }

    const requests: string[] = [];
    const server = http.createServer((req, res) => {
      requests.push(req.url ?? "");
      const file = path.join(release, req.url ?? "");
      if (!file.startsWith(release) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404).end();
        return;
      }
      const body = fs.readFileSync(file);
      res.writeHead(200, { "content-length": body.length }).end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      const dir = path.join(tempDir(), "models");
      const progress: string[] = [];
      const paths = await ensureSpeechModels(dir, { baseUrl, onProgress: (message) => progress.push(message) });
      assert.equal(fs.readFileSync(paths.vad, "utf8"), "vad");
      assert.equal(fs.readFileSync(paths.asr.tokens, "utf8"), "tokens.txt");
      assert.equal(fs.readFileSync(paths.kws.encoder, "utf8"), path.basename(paths.kws.encoder));
      assert.ok(progress.includes("Unpacking speech recognition model"));
      assert.ok(progress.includes("Unpacking wake word model"));
      assert.equal(requests.length, 3);
      assert.deepEqual(
        fs.readdirSync(dir).sort(),
        ["sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01", "sherpa-onnx-moonshine-tiny-en-int8", "silero_vad.onnx"],
        "the archives and partial files are cleaned up",
      );

      await ensureSpeechModels(dir, { baseUrl });
      assert.equal(requests.length, 3, "nothing is downloaded the second time");

      // A failed download leaves nothing behind that could pass for a model.
      const empty = path.join(tempDir(), "m");
      await assert.rejects(ensureSpeechModels(empty, { baseUrl: `${baseUrl}/missing` }), /HTTP 404/);
      assert.deepEqual(fs.readdirSync(empty), []);
    } finally {
      server.close();
    }
  });
});

function hasTool(command: string): boolean {
  return spawnSync("/bin/sh", ["-c", `command -v ${command}`], { stdio: "ignore" }).status === 0;
}

describe("openMicrophone", () => {
  it("records with PvRecorder on a worker thread and releases it when closed", async () => {
    const log = path.join(tempDir(), "recorder.log");
    process.env.FAKE_PVRECORDER_LOG = log;
    const frames: Float32Array[] = [];
    const mic = await openMicrophone((samples) => frames.push(samples), assert.fail, {
      backends: ["pvrecorder"],
      deviceIndex: 3,
      recorderModule: path.join(import.meta.dirname, "fixtures", "fake-pvrecorder.cjs"),
    });
    assert.equal(mic.name, "Fake Microphone");
    await new Promise((resolve) => setTimeout(resolve, 100));
    mic.close();
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.ok(frames.length >= 5, `received ${frames.length} frames`);
    assert.equal(frames[0]!.length, 512);
    assert.equal(frames[0]![0], 0.5);
    assert.equal(frames[1]![0], -0.5);
    assert.deepEqual(fs.readFileSync(log, "utf8").trim().split("\n"), ["open 512 3", "start", "stop", "release"]);
    const count = frames.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(frames.length, count, "no audio arrives after closing");
  });

  it("reads 16-bit PCM from a command-line recorder", { skip: process.platform === "win32" }, async () => {
    const dir = tempDir();
    // Three samples: 0, 16384 (0.5) and -32768 (-1.0), little-endian.
    fs.writeFileSync(path.join(dir, "pcm"), Buffer.from([0x00, 0x00, 0x00, 0x40, 0x00, 0x80]));
    fs.writeFileSync(path.join(dir, "arecord"), `#!/bin/sh\ncat "${dir}/pcm"\nexec sleep 30\n`, { mode: 0o755 });
    const originalPath = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${originalPath}`;
    try {
      const received: number[] = [];
      const mic = await openMicrophone((samples) => received.push(...samples), assert.fail, { backends: ["arecord"] });
      assert.equal(mic.name, "arecord");
      assert.deepEqual(received, [0, 0.5, -1]);
      mic.close();
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("reports every backend it tried when none works", { skip: process.platform === "win32" }, async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "arecord"), "#!/bin/sh\necho 'no capture device' >&2\nexit 1\n", { mode: 0o755 });
    const originalPath = process.env.PATH;
    process.env.PATH = dir;
    try {
      await assert.rejects(
        openMicrophone(() => {}, () => {}, { backends: ["sox", "arecord"] }),
        /sox: not installed; arecord: arecord exited with code 1: no capture device/,
      );
    } finally {
      process.env.PATH = originalPath;
    }
  });
});

// ---------------------------------------------------------------------------
// With the real speech models. They're a 130 MB download, so these run only when they're
// already present (JARVIS_TEST_MODELS, or ~/.jarvis/models after using /listen), with
// espeak-ng installed to synthesize test speech. The interruption test also needs two
// natural-sounding Piper voices from sherpa-onnx's tts-models release (in
// JARVIS_TEST_VOICES): the keyword spotter doesn't recognize espeak-ng's robotic voice.

const modelsDir = process.env.JARVIS_TEST_MODELS ?? path.join(os.homedir(), ".jarvis", "models");
const models = speechModelPaths(modelsDir);
const haveModels = [models.vad, ...Object.values(models.asr), ...Object.values(models.kws)].every((file) =>
  fs.existsSync(file),
);
const voicesDir = process.env.JARVIS_TEST_VOICES ?? "";
const haveVoices = ["vits-piper-en_GB-alan-medium", "vits-piper-en_US-amy-low"].every((voice) =>
  fs.existsSync(path.join(voicesDir, voice)),
);

describe("Ears with real models", { skip: !haveModels || !hasTool("espeak-ng") }, () => {
  const sherpa = createRequire(import.meta.url)("sherpa-onnx-node");
  const to16k = (wave: { samples: Float32Array; sampleRate: number }): Float32Array =>
    new sherpa.LinearResampler(wave.sampleRate, 16000).resample(wave.samples, true);
  const speech = (text: string): Float32Array => {
    const wav = path.join(tempDir(), "speech.wav");
    execFileSync("espeak-ng", ["-v", "en-us", "-s", "160", "-w", wav, text]);
    return to16k(sherpa.readWave(wav));
  };
  const silence = (seconds: number) => new Float32Array(Math.round(16000 * seconds));
  const noop = () => {};

  /** A microphone that plays `audio` in real time, then silence. */
  function fakeMicrophone(audio: Float32Array | ((offset: number) => Float32Array)) {
    const frameAt = typeof audio === "function" ? audio : (offset: number) => audio.slice(offset, offset + 512);
    return async (onAudio: (samples: Float32Array) => void) => {
      let offset = 0;
      const timer = setInterval(() => {
        const frame = new Float32Array(512);
        frame.set(frameAt(offset).subarray(0, 512));
        onAudio(frame);
        offset += 512;
      }, 32);
      return { name: "fake", close: () => clearInterval(timer) };
    };
  }

  function concat(...parts: Float32Array[]): Float32Array {
    const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }

  it("transcribes speech into utterances", async () => {
    const audio = concat(silence(0.5), speech("Hey Jarvis, what time is it?"), silence(1));
    const ears = await Ears.open(models, { openMicrophone: fakeMicrophone(audio), onError: assert.fail, onBargeIn: noop });
    try {
      assert.equal(await ears.nextUtterance(AbortSignal.timeout(15_000)), "Hey Jarvis, what time is it?");
    } finally {
      ears.close();
    }
  });

  it("ignores other speech while he's talking, and gives up when nobody speaks", async () => {
    const audio = concat(silence(0.3), speech("What's the weather like in London?"), silence(1), speech("Yes, go ahead."), silence(3));
    let bargeIns = 0;
    const ears = await Ears.open(models, {
      openMicrophone: fakeMicrophone(audio),
      onError: assert.fail,
      onBargeIn: () => bargeIns++,
    });
    try {
      ears.whileSpeaking(new Promise((resolve) => setTimeout(resolve, 3000)), "Certainly, sir.");
      assert.equal(await ears.nextUtterance(AbortSignal.timeout(15_000)), "Yes, go ahead.");
      assert.equal(bargeIns, 0);
      await assert.rejects(ears.nextUtterance(AbortSignal.timeout(15_000), { speechStartTimeoutMs: 1500 }), NoSpeechError);
    } finally {
      ears.close();
    }
  });

  it("stops talking when interrupted and hears the request", { skip: !haveVoices }, async () => {
    const piper = (voice: string) => {
      const dir = path.join(voicesDir, voice);
      const model = fs.readdirSync(dir).find((file) => file.endsWith(".onnx"))!;
      const tts = new sherpa.OfflineTts({
        model: { vits: { model: path.join(dir, model), tokens: path.join(dir, "tokens.txt"), dataDir: path.join(dir, "espeak-ng-data") } },
      });
      return (text: string) => to16k(tts.generate({ text, sid: 0, speed: 1 }));
    };
    const reply =
      "Certainly, sir. The forecast for London shows light rain through the afternoon, clearing by evening. " +
      "Tomorrow looks brighter, though I would still recommend an umbrella.";
    const his = piper("vits-piper-en_GB-alan-medium")(reply);
    const yours = piper("vits-piper-en_US-amy-low")("Hey Jarvis, what about the weekend?");
    const rms = (a: Float32Array) => Math.sqrt(a.reduce((sum, x) => sum + x * x, 0) / a.length);
    const loudness = rms(his) / rms(yours);
    const youStart = 16000 * 4;

    // His voice reaches the microphone at a fifth of yours until he's told to stop, and
    // takes a tenth of a second to fall silent. (Louder echo is where detection starts to
    // miss; this test is about what happens once he's been interrupted.)
    let position = 0;
    let stoppedAt = Infinity;
    const talking = { stop: noop };
    const done = new Promise<void>((resolve) => (talking.stop = resolve));
    const ears = await Ears.open(models, {
      openMicrophone: fakeMicrophone((offset) => {
        position = offset;
        return Float32Array.from({ length: 512 }, (_, i) => {
          const t = offset + i;
          const him = t < stoppedAt + 1600 ? (his[t] ?? 0) * 0.2 : 0;
          const you = t >= youStart ? (yours[t - youStart] ?? 0) * loudness : 0;
          return him + you;
        });
      }),
      onError: assert.fail,
      onBargeIn: () => {
        stoppedAt = position;
        talking.stop();
      },
    });
    ears.whileSpeaking(done, reply);
    try {
      const heard = await ears.nextUtterance(AbortSignal.timeout(20_000));
      assert.ok(stoppedAt < his.length, "he was cut off before finishing");
      assert.match(matchWakePhrase(heard)?.command ?? "", /weekend/i);
    } finally {
      ears.close();
    }
  });
});
