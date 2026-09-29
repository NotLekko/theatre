import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { loadConfig } from "../src/config.ts";
import { createSherpaEngine } from "../src/listen/engine.ts";
import { ensureVoiceModel, speechModelPaths, voiceModelPaths } from "../src/models.ts";
import { Session } from "../src/session.ts";
import { applyFx, FX_PRESETS, isFxPreset } from "../src/speech/fx.ts";
import { FilmVoice, Narrator, speechChunks } from "../src/speech/narrator.ts";
import { detectPlayer, type Player } from "../src/speech/player.ts";
import { Speaker, type SystemVoice } from "../src/speech/speaker.ts";
import { encodeWav } from "../src/speech/wav.ts";
import { toSpeech } from "../src/voice.ts";
import { startWebServer } from "../src/web.ts";

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-speech-"));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const RATE = 24_000;

/** A mix of sine waves, `amplitude` each. */
function tones(freqs: number[], seconds: number, amplitude = 0.2): Float32Array {
  return Float32Array.from({ length: Math.round(seconds * RATE) }, (_, i) =>
    freqs.reduce((sum, f) => sum + amplitude * Math.sin((2 * Math.PI * f * i) / RATE), 0),
  );
}

/** The level of one frequency in a signal (Goertzel), in dB. */
function levelDb(x: Float32Array, freq: number): number {
  const c = 2 * Math.cos((2 * Math.PI * freq) / RATE);
  let s1 = 0;
  let s2 = 0;
  for (const v of x) {
    const s = v + c * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  return 10 * Math.log10(s1 * s1 + s2 * s2 - c * s1 * s2 + 1e-20);
}

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const all: T[] = [];
  for await (const item of items) all.push(item);
  return all;
}

const peak = (x: Float32Array) => x.reduce((max, v) => Math.max(max, Math.abs(v)), 0);

async function waitFor(check: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${what}`);
    await sleep(10);
  }
}

// ---------------------------------------------------------------------------
// Stand-ins for the voice model, the audio player and the system voice.

function fakeSynth(options: { delayMs?: number; failOn?: string } = {}) {
  const calls: string[] = [];
  return {
    calls,
    sampleRate: RATE,
    async synthesize(text: string) {
      calls.push(text);
      await sleep(options.delayMs ?? 0);
      if (options.failOn && text.includes(options.failOn)) throw new Error("the synthesizer broke");
      return tones([440], 0.2);
    },
  };
}

function fakePlayer(options: { holdMs?: number; fail?: boolean } = {}) {
  const played: Buffer[] = [];
  const aborted: boolean[] = [];
  let closed = false;
  const player: Player & { played: Buffer[]; aborted: boolean[]; readonly closed: boolean } = {
    name: "fake player",
    played,
    aborted,
    get closed() {
      return closed;
    },
    async play(wav, signal) {
      played.push(wav);
      if (options.fail) throw new Error("no sound device");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, options.holdMs ?? 0);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          aborted.push(true);
          resolve();
        }, { once: true });
      });
    },
    close() {
      closed = true;
    },
  };
  return player;
}

function fakeSystem(): SystemVoice & { spoken: string[] } {
  const spoken: string[] = [];
  return {
    spoken,
    available: true,
    engineName: "espeak-ng (en-gb)",
    speak: (text) => spoken.push(text),
    stop() {},
    finished: async () => {},
  };
}

/** A models folder that looks like the voice model has been downloaded. */
function modelsWithVoice(): string {
  const dir = tempDir();
  for (const file of Object.values(voiceModelPaths(dir))) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "");
  }
  return dir;
}

// ---------------------------------------------------------------------------

describe("applyFx", () => {
  it("keeps every preset finite and at -1 dBFS", () => {
    const speechLike = tones([140, 900, 2500, 6000], 1, 0.15);
    for (const preset of FX_PRESETS) {
      const out = applyFx(speechLike, RATE, preset);
      assert.ok(out.every(Number.isFinite), preset);
      assert.ok(Math.abs(peak(out) - 0.89) < 0.001, `${preset} peaks at ${peak(out)}`);
    }
    assert.ok(isFxPreset("helmet"));
    assert.ok(!isFxPreset("robot"));
  });

  it("gives the film preset a short room tail and leaves clean alone", () => {
    const input = tones([440], 1);
    assert.equal(applyFx(input, RATE, "film").length, input.length + 0.35 * RATE);
    assert.equal(applyFx(input, RATE, "helmet").length, input.length + 0.15 * RATE);
    const clean = applyFx(input, RATE, "clean");
    assert.equal(clean.length, input.length);
    const scale = clean[1000]! / input[1000]!;
    assert.ok(Math.abs(clean[2000]! - input[2000]! * scale) < 1e-4, "clean is only a change of level");
  });

  it("trims rumble and lifts presence in the film preset", () => {
    // (Frequencies chosen so that none is a harmonic of another.)
    const out = applyFx(tones([40, 1100, 3000], 1.5), RATE, "film").subarray(RATE * 0.25, RATE * 1.25);
    assert.ok(levelDb(out, 1100) - levelDb(out, 40) > 8, "40 Hz is cut");
    assert.ok(levelDb(out, 3000) - levelDb(out, 1100) > 1, "3 kHz is lifted");
  });

  it("narrows the helmet preset", () => {
    const out = applyFx(tones([100, 1800, 8000], 1.5), RATE, "helmet").subarray(RATE * 0.25, RATE * 1.25);
    assert.ok(levelDb(out, 1800) - levelDb(out, 8000) > 6, "highs are cut");
    assert.ok(levelDb(out, 1800) - levelDb(out, 100) > 6, "lows are cut");
  });

  it("passes silence through", () => {
    for (const preset of FX_PRESETS) assert.ok(applyFx(new Float32Array(2400), RATE, preset).every((v) => v === 0));
  });
});

describe("encodeWav", () => {
  it("writes 16-bit mono PCM and clips out-of-range samples", () => {
    const wav = encodeWav(Float32Array.from([0, 1, -1, 2, -2, 0.5]), RATE);
    assert.equal(wav.toString("ascii", 0, 4), "RIFF");
    assert.equal(wav.readUInt32LE(4), 36 + 12);
    assert.equal(wav.toString("ascii", 8, 16), "WAVEfmt ");
    assert.equal(wav.readUInt16LE(20), 1);
    assert.equal(wav.readUInt16LE(22), 1);
    assert.equal(wav.readUInt32LE(24), RATE);
    assert.equal(wav.readUInt32LE(28), RATE * 2);
    assert.equal(wav.readUInt16LE(34), 16);
    assert.equal(wav.toString("ascii", 36, 40), "data");
    assert.equal(wav.readUInt32LE(40), 12);
    const samples = Array.from({ length: 6 }, (_, i) => wav.readInt16LE(44 + i * 2));
    assert.deepEqual(samples, [0, 32767, -32768, 32767, -32768, 16384]);
  });
});

describe("speechChunks", () => {
  it("says a reply a sentence at a time", () => {
    assert.deepEqual(speechChunks("Good evening, sir. The suit is ready! Shall I?"), [
      "Good evening, sir.",
      "The suit is ready!",
      "Shall I?",
    ]);
    assert.deepEqual(speechChunks(""), []);
  });

  it("doesn't break at abbreviations or decimals", () => {
    assert.deepEqual(speechChunks("Dr. Banner called at 3.5 past. Mr. Hogan too, e.g. twice."), [
      "Dr. Banner called at 3.5 past.",
      "Mr. Hogan too, e.g. twice.",
    ]);
  });

  it("speaks the markdown-free text", () => {
    const reply = "Here's the **plan**:\n\n- Check the `suit`\n- Call [Pepper](https://example.com)\n\n```sh\nls\n```";
    const chunks = speechChunks(reply);
    assert.equal(chunks.join(" "), toSpeech(reply));
    assert.ok(!chunks.join(" ").includes("*"));
  });

  it("splits long sentences at a clause, starting with a short one", () => {
    const first =
      "The diagnostics came back clean across the board, the repulsors are calibrated, and the flight stabilizers are responding within tolerance";
    const second =
      "I have also taken the liberty of rerouting auxiliary power to the arc reactor housing, trimming the thruster output, and logging everything for your review in the morning";
    const chunks = speechChunks(`${first}. ${second}.`);
    assert.ok(chunks[0]!.length <= 100, `first chunk is ${chunks[0]!.length} characters`);
    assert.ok(chunks.every((chunk) => chunk.length <= 160));
    assert.match(chunks[0]!, /,$/);
    assert.equal(chunks.join(" "), `${first}. ${second}.`);
  });
});

describe("Narrator", () => {
  it("prepares the next chunk while the caller handles this one", async () => {
    const synth = fakeSynth();
    const narrator = new Narrator(synth, "clean");
    const chunks = narrator.render(["One.", "Two.", "Three."], new AbortController().signal);
    const first = await chunks.next();
    assert.equal(first.done, false);
    assert.deepEqual(synth.calls, ["One.", "Two."]);
    assert.ok(Math.abs(peak(first.value as Float32Array) - 0.89) < 0.001, "effects are applied");
    const rest: Float32Array[] = [];
    for await (const samples of chunks) rest.push(samples);
    assert.equal(rest.length, 2);
    assert.deepEqual(synth.calls, ["One.", "Two.", "Three."]);
  });

  it("uses the effects preset of the moment", async () => {
    const narrator = new Narrator(fakeSynth(), "clean");
    narrator.fx = "film";
    const [samples] = await collect(narrator.render(["One."], new AbortController().signal));
    assert.equal(samples!.length, 0.2 * RATE + 0.35 * RATE);
  });

  it("stops promptly when aborted, even mid-synthesis", async () => {
    const controller = new AbortController();
    const synth = fakeSynth({ delayMs: 2000 });
    const chunks = new Narrator(synth, "clean").render(["One.", "Two."], controller.signal);
    const started = Date.now();
    const pending = chunks.next();
    setTimeout(() => controller.abort(), 20);
    assert.equal((await pending).done, true);
    assert.ok(Date.now() - started < 1000);
  });

  it("reports a failure of the synthesizer", async () => {
    const chunks = new Narrator(fakeSynth({ failOn: "Two" }), "clean").render(["One.", "Two."], new AbortController().signal);
    await chunks.next();
    await assert.rejects(chunks.next(), /the synthesizer broke/);
  });
});

describe("FilmVoice", () => {
  const load = () => async () => new Narrator(fakeSynth(), "film");

  it("stays out of the way when it may not download and isn't there", async () => {
    let loaded = false;
    const film = new FilmVoice({
      modelsDir: tempDir(),
      voice: "bm_fable",
      fx: "film",
      download: false,
      load: async () => {
        loaded = true;
        return new Narrator(fakeSynth(), "film");
      },
    });
    assert.equal(film.usable, false);
    assert.equal(await film.whenReady(1000), null);
    assert.equal(loaded, false);
  });

  it("waits for a model on disk, but not for a download", async () => {
    let finishLoading = () => {};
    const gate = new Promise<void>((resolve) => (finishLoading = resolve));
    const ready: boolean[] = [];
    const downloading = new FilmVoice({
      modelsDir: tempDir(),
      voice: "bm_fable",
      fx: "helmet",
      download: true,
      load: async () => {
        await gate;
        return new Narrator(fakeSynth(), "film");
      },
      onReady: (downloaded) => ready.push(downloaded),
    });
    assert.equal(downloading.onDisk, false);
    assert.equal(await downloading.whenReady(5000), null, "doesn't wait for a download");
    finishLoading();
    await waitFor(() => downloading.narrator !== null, "the download");
    assert.deepEqual(ready, [true]);
    assert.equal(downloading.narrator!.fx, "helmet", "the chosen effects carry over");

    const onDisk = new FilmVoice({ modelsDir: modelsWithVoice(), voice: "bm_fable", fx: "film", download: false, load: load() });
    assert.equal(onDisk.onDisk, true);
    assert.ok(await onDisk.whenReady(5000));
  });

  it("reports a failure to load, and cancels loading when closed", async () => {
    const errors: string[] = [];
    const broken = new FilmVoice({
      modelsDir: modelsWithVoice(),
      voice: "bm_fable",
      fx: "film",
      download: true,
      load: async () => {
        throw new Error("sherpa-onnx-node is missing");
      },
      onError: (err) => errors.push(err.message),
    });
    assert.equal(await broken.whenReady(1000), null);
    assert.deepEqual(errors, ["sherpa-onnx-node is missing"]);
    assert.equal(broken.usable, false);

    let signal: AbortSignal | undefined;
    const closed = new FilmVoice({
      modelsDir: tempDir(),
      voice: "bm_fable",
      fx: "film",
      download: true,
      load: (s) => {
        signal = s;
        return new Promise(() => {});
      },
      onError: (err) => errors.push(err.message),
    });
    closed.close();
    assert.equal(signal?.aborted, true);
    assert.equal(closed.usable, false);
    assert.equal(errors.length, 1);
  });
});

describe("Speaker", () => {
  const options = (overrides: Partial<ConstructorParameters<typeof Speaker>[0]> = {}) => ({
    enabled: true,
    engine: "neural" as const,
    neuralVoice: "bm_fable" as const,
    systemVoiceName: undefined,
    fx: "film" as const,
    modelsDir: modelsWithVoice(),
    download: true,
    onNotice: () => {},
    ...overrides,
  });

  it("speaks in the film voice, a sentence per clip", async () => {
    const player = fakePlayer();
    const system = fakeSystem();
    const speaker = new Speaker(
      options({ player, system, loadNarrator: async () => new Narrator(fakeSynth({ delayMs: 50 }), "film") }),
    );
    assert.equal(speaker.engineName, "film voice (bm_fable, film effects) via fake player");
    speaker.speak("Good evening, sir. All systems are online.");
    await speaker.finished(5000);
    assert.equal(player.played.length, 2);
    assert.ok(player.played.every((wav) => wav.toString("ascii", 0, 4) === "RIFF"));
    assert.deepEqual(system.spoken, []);
    speaker.close();
    assert.ok(player.closed);
  });

  it("lets the system voice stand in while the film voice downloads", async () => {
    const system = fakeSystem();
    let signal: AbortSignal | undefined;
    const speaker = new Speaker(
      options({
        modelsDir: tempDir(),
        player: fakePlayer(),
        system,
        loadNarrator: (s) => {
          signal = s;
          return new Promise(() => {});
        },
      }),
    );
    assert.match(speaker.engineName, /downloading it, espeak-ng \(en-gb\) until then/);
    speaker.speak("Good evening, sir.");
    await speaker.finished(1000);
    assert.deepEqual(system.spoken, ["Good evening, sir."]);
    speaker.close();
    assert.equal(signal?.aborted, true, "closing cancels the download");
  });

  it("uses the system voice for a one-off answer when the film voice isn't downloaded", async () => {
    const system = fakeSystem();
    const speaker = new Speaker(options({ modelsDir: tempDir(), download: false, player: fakePlayer(), system }));
    speaker.speak("It's ten past nine.");
    await speaker.finished(1000);
    assert.deepEqual(system.spoken, ["It's ten past nine."]);
  });

  it("stops mid-sentence", async () => {
    const player = fakePlayer({ holdMs: 10_000 });
    const speaker = new Speaker(options({ player, system: fakeSystem(), loadNarrator: async () => new Narrator(fakeSynth(), "film") }));
    speaker.speak("This is going to take a while. Quite a while.");
    await waitFor(() => player.played.length === 1, "playback to start");
    const started = Date.now();
    speaker.stop();
    await speaker.finished(5000);
    assert.ok(Date.now() - started < 1000);
    assert.deepEqual(player.aborted, [true]);
    assert.equal(player.played.length, 1);
  });

  it("falls back to the system voice if playback fails", async () => {
    const notices: string[] = [];
    const system = fakeSystem();
    const speaker = new Speaker(
      options({
        player: fakePlayer({ fail: true }),
        system,
        loadNarrator: async () => new Narrator(fakeSynth(), "film"),
        onNotice: (message) => notices.push(message),
      }),
    );
    speaker.speak("Good evening, sir.");
    await speaker.finished(5000);
    assert.equal(notices.length, 1);
    assert.match(notices[0]!, /film voice failed: no sound device\. Using espeak-ng \(en-gb\) instead/);
    assert.deepEqual(system.spoken, ["Good evening, sir."]);
    speaker.speak("Shall I try again?");
    await speaker.finished(1000);
    assert.deepEqual(system.spoken, ["Good evening, sir.", "Shall I try again?"]);
    assert.equal(speaker.engineName, "espeak-ng (en-gb)");
  });

  it("uses only the system voice when asked to, and stays quiet when muted", async () => {
    const system = fakeSystem();
    let loads = 0;
    const loadNarrator = async () => {
      loads++;
      return new Narrator(fakeSynth(), "film");
    };
    const speaker = new Speaker(options({ engine: "system", player: fakePlayer(), system, loadNarrator }));
    assert.equal(speaker.engineName, "espeak-ng (en-gb)");
    speaker.speak("Good evening, sir.");
    assert.deepEqual(system.spoken, ["Good evening, sir."]);

    const player = fakePlayer();
    const muted = new Speaker(options({ enabled: false, player, system, loadNarrator }));
    muted.speak("Should stay silent.");
    await muted.finished(1000);
    assert.equal(player.played.length, 0);
    assert.equal(loads, 0, "a muted voice isn't loaded");
    muted.enabled = true;
    muted.speak("Now I may speak.");
    await muted.finished(5000);
    assert.equal(player.played.length, 1);
    assert.equal(loads, 1);
  });
});

describe("detectPlayer", { skip: process.platform !== "linux" }, () => {
  function withFakePaplay(script: string) {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "paplay"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    const originalPath = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${originalPath}`;
    return { dir, restore: () => (process.env.PATH = originalPath) };
  }

  it("plays a WAV file and cleans up after itself", async () => {
    const fake = withFakePaplay(`cp "$1" "$(dirname "$0")/played.wav"\necho "$1" > "$(dirname "$0")/path"`);
    try {
      const player = detectPlayer()!;
      assert.equal(player.name, "paplay");
      const wav = encodeWav(tones([440], 0.1), RATE);
      await player.play(wav, new AbortController().signal);
      assert.deepEqual(fs.readFileSync(path.join(fake.dir, "played.wav")), wav);
      const played = fs.readFileSync(path.join(fake.dir, "path"), "utf8").trim();
      assert.equal(fs.existsSync(played), false, "the clip is deleted after playing");
      player.close();
      assert.equal(fs.existsSync(path.dirname(played)), false);
    } finally {
      fake.restore();
    }
  });

  it("stops playback when aborted, and reports a player that fails", async () => {
    const slow = withFakePaplay("exec sleep 10");
    try {
      const player = detectPlayer()!;
      const controller = new AbortController();
      const started = Date.now();
      const playing = player.play(encodeWav(tones([440], 0.1), RATE), controller.signal);
      setTimeout(() => controller.abort(), 100);
      await playing;
      assert.ok(Date.now() - started < 2000);
      player.close();
    } finally {
      slow.restore();
    }
    const broken = withFakePaplay("echo 'Connection refused' >&2\nexit 1");
    try {
      const player = detectPlayer()!;
      await assert.rejects(player.play(encodeWav(tones([440], 0.1), RATE), new AbortController().signal), /paplay couldn't play audio: Connection refused/);
      player.close();
    } finally {
      broken.restore();
    }
  });
});

const hasTool = (command: string) => spawnSync("/bin/sh", ["-c", `command -v ${command}`], { stdio: "ignore" }).status === 0;

describe("ensureVoiceModel", { skip: !hasTool("tar") || !hasTool("bzip2") }, () => {
  async function serve(handler: http.RequestListener) {
    const server = http.createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  }

  it("downloads the model once and unpacks only what the voice needs", async () => {
    const release = tempDir();
    const staging = tempDir();
    const layout = voiceModelPaths(staging);
    const folder = path.dirname(layout.model);
    fs.mkdirSync(layout.dataDir, { recursive: true });
    for (const [name, file] of Object.entries(layout)) {
      if (name !== "dataDir") fs.writeFileSync(file, name);
    }
    fs.writeFileSync(path.join(layout.dataDir, "phontab"), "phonemes");
    fs.writeFileSync(path.join(folder, "lexicon-zh.txt"), "not needed");
    fs.mkdirSync(path.join(release, "tts-models"));
    execFileSync("tar", ["-cjf", path.join(release, "tts-models", `${path.basename(folder)}.tar.bz2`), "-C", staging, path.basename(folder)]);

    const requests: string[] = [];
    const { server, baseUrl } = await serve((req, res) => {
      requests.push(req.url ?? "");
      const file = path.join(release, req.url ?? "");
      if (!fs.existsSync(file)) return void res.writeHead(404).end();
      res.writeHead(200, { "content-length": fs.statSync(file).size });
      fs.createReadStream(file).pipe(res);
    });
    try {
      const dir = tempDir();
      const progress: string[] = [];
      const paths = await ensureVoiceModel(dir, { baseUrl, onProgress: (m) => progress.push(m) });
      assert.equal(fs.readFileSync(paths.model, "utf8"), "model");
      assert.equal(fs.readFileSync(path.join(paths.dataDir, "phontab"), "utf8"), "phonemes");
      assert.equal(fs.existsSync(path.join(path.dirname(paths.model), "lexicon-zh.txt")), false);
      assert.deepEqual(fs.readdirSync(dir), [path.basename(folder)], "the archive is removed");
      assert.ok(progress.includes("Unpacking voice model"));
      await ensureVoiceModel(dir, { baseUrl });
      assert.deepEqual(requests, ["/tts-models/kokoro-int8-multi-lang-v1_0.tar.bz2"]);
    } finally {
      server.close();
    }
  });

  it("can be cancelled mid-download", async () => {
    const { server, baseUrl } = await serve((_req, res) => {
      res.writeHead(200, { "content-length": 1_000_000 });
      res.write(Buffer.alloc(1000));
    });
    try {
      const dir = tempDir();
      const controller = new AbortController();
      const download = ensureVoiceModel(dir, { baseUrl, signal: controller.signal });
      setTimeout(() => controller.abort(), 100);
      await assert.rejects(download, { name: "AbortError" });
      assert.deepEqual(fs.readdirSync(dir), [], "no partial download is left behind");
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});

describe("the HUD's voice", () => {
  interface Event {
    type: string;
    [key: string]: unknown;
  }

  async function startHud(film: ((modelsDir: string) => FilmVoice) | null) {
    const home = tempDir();
    const { config } = loadConfig([], { JARVIS_HOME: home });
    const web = await startWebServer(config, {
      port: 0,
      session: (ui) => new Session(config, ui, new Anthropic({ apiKey: "test", baseURL: "http://127.0.0.1:9" })),
      film: () => (film ? film(path.join(home, "models")) : null),
    });
    const events: Event[] = [];
    const response = await fetch(`${web.url}api/events`, { headers: { "x-jarvis-token": web.token } });
    const reader = response.body!.getReader();
    void (async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (block.startsWith("data: ")) events.push(JSON.parse(block.slice(6)) as Event);
        }
      }
    })().catch(() => {});
    const post = (route: string, body: object) =>
      fetch(`${web.url}api/${route}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-jarvis-token": web.token },
        body: JSON.stringify(body),
      });
    await waitFor(() => events.some((e) => e.type === "hello"), "the hello event");
    return { web, events, post };
  }

  const filmVoice = (modelsDir: string) =>
    new FilmVoice({ modelsDir, voice: "bm_fable", fx: "film", download: true, load: async () => new Narrator(fakeSynth(), "film") });

  it("streams the film voice to the page a sentence at a time", async () => {
    const { web, events, post } = await startHud(filmVoice);
    try {
      await waitFor(() => events.some((e) => e.type === "hello" && e.voice === "film voice · film"), "the voice to load");
      let finished = false;
      const speaking = web.ui.speak("Good evening, sir. All systems are online.").then(() => (finished = true));
      await waitFor(() => events.filter((e) => e.type === "speechAudio").length === 2, "the audio");
      const speak = events.find((e) => e.type === "speak")!;
      assert.equal(speak.chunks, 2);
      const audio = events.filter((e) => e.type === "speechAudio");
      assert.deepEqual(audio.map((e) => [e.id, e.index]), [[speak.id, 0], [speak.id, 1]]);
      assert.equal(Buffer.from(audio[0]!.wav as string, "base64").toString("ascii", 0, 4), "RIFF");
      assert.equal(finished, false, "waits for the page to finish playing");
      assert.equal((await post("speech", { id: speak.id })).status, 200);
      await speaking;
    } finally {
      await web.close();
    }
  });

  it("switches effects on request", async () => {
    const { web, events, post } = await startHud(filmVoice);
    try {
      await waitFor(() => events.some((e) => e.type === "hello" && e.voice), "the voice to load");
      assert.equal((await post("message", { text: "/voice helmet" })).status, 202);
      await waitFor(() => events.some((e) => e.type === "note" && e.text === "Voice effects: helmet."), "the change");
      await waitFor(() => events.some((e) => e.type === "hello" && e.voice === "film voice · helmet"), "the new hello");
      assert.equal(web.ui.film?.fx, "helmet");
    } finally {
      await web.close();
    }
  });

  it("leaves speech to the browser without the film voice", async () => {
    const { web, events, post } = await startHud(null);
    try {
      const speaking = web.ui.speak("Good evening, sir.");
      await waitFor(() => events.some((e) => e.type === "speak"), "the speak event");
      const speak = events.find((e) => e.type === "speak")!;
      assert.equal(speak.chunks, undefined);
      assert.equal(speak.text, "Good evening, sir.");
      await post("speech", { id: speak.id });
      await speaking;
    } finally {
      await web.close();
    }
  });
});

// ---------------------------------------------------------------------------
// With the real models: the film voice (a 132 MB download) and the speech recognizer,
// in JARVIS_TEST_MODELS or ~/.jarvis/models.

const modelsDir = process.env.JARVIS_TEST_MODELS ?? path.join(os.homedir(), ".jarvis", "models");
const speechModels = speechModelPaths(modelsDir);
const haveModels = [
  ...Object.values(voiceModelPaths(modelsDir)),
  speechModels.vad,
  ...Object.values(speechModels.asr),
  ...Object.values(speechModels.kws),
].every((file) => fs.existsSync(file));

describe("the film voice with real models", { skip: !haveModels }, () => {
  it("speaks intelligibly with every effects preset", async () => {
    const film = new FilmVoice({ modelsDir, voice: "bm_fable", fx: "film", download: false });
    const narrator = (await film.whenReady(60_000))!;
    assert.ok(narrator, "the voice loads");
    const engine = await createSherpaEngine(speechModels);
    const sherpa = createRequire(import.meta.url)("sherpa-onnx-node");
    for (const preset of FX_PRESETS) {
      narrator.fx = preset;
      const [samples] = await collect(narrator.render(["Good evening, sir. All systems are online."], new AbortController().signal));
      const heard = await engine.transcribe(new sherpa.LinearResampler(narrator.sampleRate, 16000).resample(samples, true));
      assert.match(heard, /good evening\W+sir\W+all systems are online/i, preset);
    }
  });
});
