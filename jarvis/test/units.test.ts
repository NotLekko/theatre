import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { loadConfig } from "../src/config.ts";
import { MemoryStore } from "../src/memory.ts";
import { buildSystemPrompt, greeting } from "../src/persona.ts";
import { Reminders } from "../src/reminders.ts";
import { formatBytes, localTools, runCommand, toApiTool, truncateMiddle } from "../src/tools.ts";
import { toSpeech } from "../src/voice.ts";

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-unit-"));

describe("loadConfig", () => {
  it("uses sensible defaults", () => {
    const { config, prompt, help } = loadConfig([], {});
    assert.equal(config.model, "claude-opus-5-5");
    assert.equal(config.effort, "medium");
    assert.equal(config.voice, true);
    assert.equal(config.honorific, "sir");
    assert.equal(prompt, undefined);
    assert.equal(help, false);
  });

  it("reads flags, environment and a one-shot prompt", () => {
    const { config, prompt } = loadConfig(["--no-voice", "--effort", "low", "what", "time?"], {
      JARVIS_HONORIFIC: "ma'am",
      JARVIS_USER_NAME: "Pepper",
      JARVIS_COUNTRY: "US",
    });
    assert.equal(config.voice, false);
    assert.equal(config.effort, "low");
    assert.equal(config.honorific, "ma'am");
    assert.equal(config.userName, "Pepper");
    assert.equal(config.location.country, "US");
    assert.equal(prompt, "what time?");
  });

  it("lets JARVIS_VOICE=off mute by default", () => {
    assert.equal(loadConfig([], { JARVIS_VOICE: "off" }).config.voice, false);
    assert.equal(loadConfig(["--voice"], { JARVIS_VOICE: "off" }).config.voice, true);
  });

  it("turns on voice input from the flag or the environment", () => {
    assert.equal(loadConfig([], {}).config.listen, false);
    assert.equal(loadConfig(["--listen"], {}).config.listen, true);
    assert.equal(loadConfig([], { JARVIS_LISTEN: "on" }).config.listen, true);
    assert.equal(loadConfig(["--no-listen"], { JARVIS_LISTEN: "on" }).config.listen, false);
    assert.equal(loadConfig([], {}).config.micDevice, -1);
    assert.equal(loadConfig([], { JARVIS_MIC_DEVICE: "2" }).config.micDevice, 2);
    assert.throws(() => loadConfig([], { JARVIS_MIC_DEVICE: "usb" }), /device index/);
  });

  it("chooses the film voice by default, and checks voice settings", () => {
    const { config } = loadConfig([], {});
    assert.equal(config.voiceEngine, "neural");
    assert.equal(config.voiceName, undefined);
    assert.equal(config.voiceFx, "film");
    const chosen = loadConfig([], { JARVIS_VOICE_NAME: "bm_george", JARVIS_VOICE_FX: "Helmet" }).config;
    assert.equal(chosen.voiceName, "bm_george");
    assert.equal(chosen.voiceFx, "helmet");
    assert.equal(loadConfig([], { JARVIS_VOICE_ENGINE: "system", JARVIS_VOICE_NAME: "Daniel" }).config.voiceName, "Daniel");
    assert.throws(() => loadConfig([], { JARVIS_VOICE_NAME: "Daniel" }), /isn't one of the film voices.*JARVIS_VOICE_ENGINE=system/);
    assert.throws(() => loadConfig([], { JARVIS_VOICE_ENGINE: "robot" }), /JARVIS_VOICE_ENGINE must be one of neural, system/);
    assert.throws(() => loadConfig([], { JARVIS_VOICE_FX: "echo" }), /JARVIS_VOICE_FX must be one of film, helmet, clean/);
  });

  it("rejects an unknown effort level", () => {
    assert.throws(() => loadConfig(["--effort", "ludicrous"], {}), /Unknown effort level/);
  });
});

describe("MemoryStore", () => {
  it("persists, lists and removes memories", () => {
    const file = path.join(tempDir(), "nested", "memory.json");
    const store = new MemoryStore(file);
    assert.equal(store.add("Prefers metric units").id, "m1");
    assert.equal(store.add("Works on the Mark 85").id, "m2");

    const reloaded = new MemoryStore(file);
    assert.deepEqual(
      reloaded.list().map((m) => m.fact),
      ["Prefers metric units", "Works on the Mark 85"],
    );
    assert.equal(reloaded.remove("m1")?.fact, "Prefers metric units");
    assert.equal(reloaded.remove("m1"), undefined);
    assert.equal(reloaded.add("Allergic to strawberries").id, "m3");
    assert.deepEqual(
      new MemoryStore(file).list().map((m) => m.id),
      ["m2", "m3"],
    );
  });

  it("refuses to load a corrupt file rather than overwrite it", () => {
    const file = path.join(tempDir(), "memory.json");
    fs.writeFileSync(file, "{not json");
    assert.throws(() => new MemoryStore(file), /not valid JSON/);
  });
});

describe("Reminders", () => {
  it("fires, lists and cancels reminders", async () => {
    const fired: string[] = [];
    const reminders = new Reminders((r) => fired.push(r.message));
    reminders.add("later", 60_000);
    const soon = reminders.add("soon", 20);
    assert.deepEqual(
      reminders.list().map((r) => r.id),
      [soon.id, "r1"],
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(fired, ["soon"]);
    assert.equal(reminders.cancel("r1")?.message, "later");
    assert.equal(reminders.list().length, 0);
  });
});

describe("persona", () => {
  it("includes the honorific and saved memories in the system prompt", () => {
    const prompt = buildSystemPrompt({
      honorific: "ma'am",
      userName: "Pepper",
      memories: [{ id: "m4", fact: "Runs Stark Industries", savedAt: "2026-01-01T00:00:00Z" }],
    });
    assert.match(prompt, /Address them as "ma'am"/);
    assert.match(prompt, /- \[m4\] Runs Stark Industries/);
  });

  it("greets according to the time of day", () => {
    assert.match(greeting("sir", new Date(2026, 0, 1, 9)), /^Good morning, sir/);
    assert.match(greeting("sir", new Date(2026, 0, 1, 21)), /^Good evening, sir/);
    assert.match(greeting("sir", new Date(2026, 0, 1, 3)), /midnight oil/);
  });
});

describe("toSpeech", () => {
  it("strips markdown so it reads naturally", () => {
    assert.equal(toSpeech("**Good** news, _sir_: see [the docs](https://x.io)."), "Good news, sir: see the docs.");
    assert.equal(toSpeech("# Status\n- CPU fine\n- Memory fine"), "Status. CPU fine. Memory fine");
    assert.equal(toSpeech("Run this:\n```sh\nls -la\n```"), "Run this: I've put the details on screen.");
    assert.equal(toSpeech("Check my_file_name and `ls`."), "Check my_file_name and ls.");
    assert.equal(toSpeech("Visit https://example.com today"), "Visit the link on screen today");
  });
});

describe("tools", () => {
  it("exposes every local tool as a JSON-schema tool", () => {
    for (const tool of localTools) {
      const api = toApiTool(tool);
      assert.equal(api.name, tool.name);
      assert.equal(api.input_schema.type, "object");
      assert.equal((api.input_schema as Record<string, unknown>).$schema, undefined);
      assert.equal(api.eager_input_streaming, true);
    }
    const names = localTools.map((t) => t.name);
    assert.equal(new Set(names).size, names.length, "tool names are unique");
  });

  it("formats sizes and trims long output", () => {
    assert.equal(formatBytes(512), "512 B");
    assert.equal(formatBytes(1536), "1.5 KB");
    assert.equal(formatBytes(16 * 1024 ** 3), "16 GB");
    const trimmed = truncateMiddle("a".repeat(50) + "b".repeat(50), 20);
    assert.ok(trimmed.startsWith("a".repeat(10)));
    assert.ok(trimmed.endsWith("b".repeat(10)));
    assert.match(trimmed, /80 characters omitted/);
  });

  it("stops a command that runs past its timeout", { skip: process.platform === "win32" }, async () => {
    const started = Date.now();
    const result = await runCommand("sleep 5; echo never", 200, new AbortController().signal);
    assert.equal(result.timed_out, true);
    assert.equal(result.stdout, "");
    assert.ok(Date.now() - started < 3000);
  });

  it("captures stderr and exit codes", { skip: process.platform === "win32" }, async () => {
    const result = await runCommand("echo oops >&2; exit 3", 5000, new AbortController().signal);
    assert.equal(result.exit_code, 3);
    assert.equal(result.stderr.trim(), "oops");
  });

  it("validates tool input with the zod schema", () => {
    const shell = localTools.find((t) => t.name === "run_shell_command")!;
    assert.equal(shell.schema.safeParse({ command: "ls" }).success, false);
    assert.equal(shell.schema.safeParse({ command: "ls", reason: "Look around." }).success, true);
    assert.equal(shell.schema.safeParse({ command: "ls", reason: "x", timeout_seconds: 9999 }).success, false);
  });
});

describe("Voice", { skip: process.platform !== "linux" }, () => {
  it("pipes cleaned-up text to espeak-ng on stdin", async () => {
    const dir = tempDir();
    const fake = path.join(dir, "espeak-ng");
    fs.writeFileSync(fake, `#!/bin/sh\necho "$@" > "${dir}/args"\ncat > "${dir}/spoken"\n`, { mode: 0o755 });
    const originalPath = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${originalPath}`;
    try {
      const { Voice } = await import("../src/voice.ts");
      const voice = new Voice(true, undefined);
      assert.equal(voice.engineName, "espeak-ng (en-gb)");
      voice.speak("**Good evening**, sir. See `ls` output.");
      await voice.finished(5000);
      assert.equal(fs.readFileSync(path.join(dir, "spoken"), "utf8"), "Good evening, sir. See ls output.");
      assert.equal(fs.readFileSync(path.join(dir, "args"), "utf8").trim(), "-v en-gb -s 165");

      voice.enabled = false;
      voice.speak("Should stay silent");
      await voice.finished(1000);
      assert.equal(fs.readFileSync(path.join(dir, "spoken"), "utf8"), "Good evening, sir. See ls output.");
    } finally {
      process.env.PATH = originalPath;
    }
  });
});
