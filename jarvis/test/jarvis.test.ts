import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { Jarvis, sanitizeForHistory, type TurnObserver } from "../src/jarvis.ts";
import { MemoryStore } from "../src/memory.ts";
import { Reminders } from "../src/reminders.ts";
import { localTools, serverTools, type ToolContext } from "../src/tools.ts";

// ---------------------------------------------------------------------------
// A tiny stand-in for the Messages API that replays scripted SSE streams.

type SseEvent = Record<string, unknown> & { type: string };
interface ScriptedBlock {
  start: Record<string, unknown>;
  deltas?: Record<string, unknown>[];
}

function streamOf(blocks: ScriptedBlock[], stopReason: string, deltaExtra: Record<string, unknown> = {}): SseEvent[] {
  return [
    {
      type: "message_start",
      message: {
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude-opus-5-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 50 },
      },
    },
    ...blocks.flatMap((block, index) => [
      { type: "content_block_start", index, content_block: block.start },
      ...(block.deltas ?? []).map((delta) => ({ type: "content_block_delta", index, delta })),
      { type: "content_block_stop", index },
    ]),
    {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null, ...deltaExtra },
      usage: { output_tokens: 42 },
    },
    { type: "message_stop" },
  ];
}

const text = (value: string): ScriptedBlock => ({
  start: { type: "text", text: "" },
  deltas: [{ type: "text_delta", text: value }],
});

const progress = (value: string): ScriptedBlock => ({
  start: { type: "thinking", thinking: "", signature: "" },
  deltas: [
    { type: "thinking_delta", thinking: value },
    { type: "signature_delta", signature: "sig-123" },
  ],
});

const toolUse = (id: string, name: string, input: unknown): ScriptedBlock => ({
  start: { type: "tool_use", id, name, input: {} },
  deltas: [{ type: "input_json_delta", partial_json: JSON.stringify(input) }],
});

interface RecordedRequest {
  url: string;
  headers: http.IncomingHttpHeaders;
  body: any;
}

class MockMessagesApi {
  readonly requests: RecordedRequest[] = [];
  readonly queue: SseEvent[][] = [];
  readonly #server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    this.requests.push({ url: req.url ?? "", headers: req.headers, body: JSON.parse(raw) });
    const events = this.queue.shift();
    if (!events) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "no scripted response" } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
  });

  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.#server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.#server.close(() => resolve()));
  }
}

function recordingObserver() {
  const log: string[] = [];
  const observer: TurnObserver = {
    waiting: () => log.push("waiting"),
    text: (delta) => log.push(`text:${delta}`),
    progress: (delta) => log.push(`progress:${delta}`),
    blockEnd: () => {},
    tool: (label) => log.push(`tool:${label}`),
    notice: (message) => log.push(`notice:${message}`),
  };
  return { log, observer };
}

// ---------------------------------------------------------------------------

describe("Jarvis turn loop", () => {
  const api = new MockMessagesApi();
  let baseURL = "";
  let home = "";
  let jarvis: Jarvis;
  let memory: MemoryStore;
  let confirmations: string[];
  let approve: boolean;

  before(async () => {
    baseURL = await api.start();
  });
  after(() => api.stop());

  beforeEach(() => {
    api.requests.length = 0;
    api.queue.length = 0;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-test-"));
    memory = new MemoryStore(path.join(home, "memory.json"));
    confirmations = [];
    approve = false;
    jarvis = new Jarvis({
      client: new Anthropic({ apiKey: "test-key", baseURL, maxRetries: 0 }),
      model: "claude-opus-5-5",
      effort: "medium",
      system: "You are JARVIS.",
      localTools,
      serverTools: serverTools({ timezone: "Europe/London" }),
    });
  });

  function context(): ToolContext {
    return {
      memory,
      reminders: new Reminders(() => {}),
      signal: new AbortController().signal,
      confirm: async (question) => {
        confirmations.push(question);
        return approve;
      },
    };
  }

  it("sends the configured request and runs a local tool round trip", async () => {
    api.queue.push(
      streamOf([progress("Checking the clock."), toolUse("toolu_1", "get_datetime", {})], "tool_use"),
      streamOf([text("It is teatime, sir.")], "end_turn"),
    );
    const { log, observer } = recordingObserver();

    const result = await jarvis.respond("What time is it?", observer, context());

    assert.deepEqual(result, { kind: "answered", text: "It is teatime, sir.", truncated: false });
    assert.equal(api.requests.length, 2);

    const first = api.requests[0]!;
    assert.match(first.url, /^\/v1\/messages/);
    const betas = String(first.headers["anthropic-beta"]);
    assert.ok(betas.includes("server-side-fallback-2026-07-01"));
    assert.ok(betas.includes("thinking-display-updates-2026-08-18"));
    assert.equal(first.body.model, "claude-opus-5-5");
    assert.equal(first.body.fallbacks, "default");
    assert.equal(first.body.stream, true);
    assert.deepEqual(first.body.thinking, { type: "adaptive", display: "updates" });
    assert.deepEqual(first.body.output_config, { effort: "medium" });
    const toolNames = first.body.tools.map((tool: { name: string }) => tool.name);
    assert.ok(toolNames.includes("get_datetime"));
    assert.ok(toolNames.includes("run_shell_command"));
    assert.ok(toolNames.includes("web_search"));
    for (const tool of first.body.tools.filter((t: { type?: string }) => !t.type)) {
      assert.equal(tool.eager_input_streaming, true);
      assert.equal(tool.input_schema.type, "object");
      assert.equal(tool.input_schema.$schema, undefined);
    }

    // The follow-up replays the assistant turn unchanged (thinking signature included)
    // and answers the tool call.
    const followUp = api.requests[1]!.body.messages;
    assert.equal(followUp.length, 3);
    assert.deepEqual(followUp[0], { role: "user", content: "What time is it?" });
    assert.equal(followUp[1].role, "assistant");
    assert.deepEqual(
      followUp[1].content.map((block: { type: string }) => block.type),
      ["thinking", "tool_use"],
    );
    assert.equal(followUp[1].content[0].signature, "sig-123");
    const toolResult = followUp[2].content[0];
    assert.equal(toolResult.type, "tool_result");
    assert.equal(toolResult.tool_use_id, "toolu_1");
    assert.ok(JSON.parse(toolResult.content).iso);

    assert.ok(log.includes("progress:Checking the clock."));
    assert.ok(log.includes("tool:Checking the clock"));
    assert.ok(log.includes("text:It is teatime, sir."));
    assert.equal(jarvis.history.length, 4);
    assert.equal(jarvis.usage.requests, 2);
    assert.equal(jarvis.usage.output, 84);
  });

  it("rolls back the turn when the request is refused", async () => {
    api.queue.push(streamOf([text("Good evening.")], "end_turn"));
    await jarvis.respond("Hello", recordingObserver().observer, context());
    assert.equal(jarvis.history.length, 2);

    api.queue.push(
      streamOf([text("Well")], "refusal", {
        stop_details: { type: "refusal", category: "cyber", explanation: "declined" },
      }),
    );
    const result = await jarvis.respond("Something dubious", recordingObserver().observer, context());

    assert.deepEqual(result, { kind: "refused", category: "cyber" });
    assert.equal(jarvis.history.length, 2, "the refused exchange is not kept");
  });

  it("rolls back the turn when the API fails", async () => {
    // Nothing queued: the mock answers 500.
    await assert.rejects(
      jarvis.respond("Hello", recordingObserver().observer, context()),
      (err) => err instanceof Anthropic.InternalServerError,
    );
    assert.equal(jarvis.history.length, 0);
  });

  it("rejects invalid tool input without running the tool", async () => {
    api.queue.push(
      streamOf([toolUse("toolu_2", "remember", { note: "wrong field" })], "tool_use"),
      streamOf([text("Let me try that again.")], "end_turn"),
    );
    await jarvis.respond("Remember I like tea", recordingObserver().observer, context());

    const toolResult = api.requests[1]!.body.messages[2].content[0];
    assert.equal(toolResult.is_error, true);
    assert.match(toolResult.content, /INVALID_JSON/);
    assert.equal(memory.list().length, 0);
  });

  it("re-issues a turn whose tool input isn't valid JSON", async () => {
    api.queue.push(
      streamOf([{ start: { type: "tool_use", id: "toolu_x", name: "remember", input: {} }, deltas: [{ type: "input_json_delta", partial_json: "][" }] }], "tool_use"),
      streamOf([text("Second time lucky.")], "end_turn"),
    );
    const { log, observer } = recordingObserver();
    const result = await jarvis.respond("Remember I like tea", observer, context());

    assert.deepEqual(result, { kind: "answered", text: "Second time lucky.", truncated: false });
    assert.equal(api.requests.length, 2);
    assert.equal(api.requests[1]!.body.messages.length, 1, "the garbled turn is not replayed");
    assert.ok(log.includes("notice:Garbled tool request; retrying"));
  });

  it("saves memories through the remember tool", async () => {
    api.queue.push(
      streamOf([toolUse("toolu_3", "remember", { fact: "Takes tea with milk" })], "tool_use"),
      streamOf([text("Noted, sir.")], "end_turn"),
    );
    await jarvis.respond("I take my tea with milk", recordingObserver().observer, context());

    assert.deepEqual(
      memory.list().map((m) => m.fact),
      ["Takes tea with milk"],
    );
    assert.equal(api.requests[1]!.body.messages[2].content[0].content, "Saved as m1.");
  });

  it("asks before running a shell command and respects a refusal", async () => {
    api.queue.push(
      streamOf([toolUse("toolu_4", "run_shell_command", { command: "echo hi", reason: "Saying hello." })], "tool_use"),
      streamOf([text("As you wish.")], "end_turn"),
    );
    await jarvis.respond("Say hi in the shell", recordingObserver().observer, context());

    assert.deepEqual(confirmations, ["Saying hello."]);
    assert.equal(api.requests[1]!.body.messages[2].content[0].content, "The user declined to run this command.");
  });

  it("runs an approved shell command", { skip: process.platform === "win32" }, async () => {
    approve = true;
    api.queue.push(
      streamOf([toolUse("toolu_5", "run_shell_command", { command: "echo online", reason: "Testing." })], "tool_use"),
      streamOf([text("Done.")], "end_turn"),
    );
    await jarvis.respond("Echo something", recordingObserver().observer, context());

    const output = JSON.parse(api.requests[1]!.body.messages[2].content[0].content);
    assert.equal(output.exit_code, 0);
    assert.equal(output.stdout.trim(), "online");
  });

  it("continues a paused server-tool turn", async () => {
    api.queue.push(
      streamOf(
        [
          {
            start: { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} },
            deltas: [{ type: "input_json_delta", partial_json: '{"query":"London weather"}' }],
          },
        ],
        "pause_turn",
      ),
      streamOf([text("Drizzle, naturally.")], "end_turn"),
    );
    const { log, observer } = recordingObserver();
    const result = await jarvis.respond("Weather?", observer, context());

    assert.equal(result.kind, "answered");
    assert.equal(api.requests.length, 2);
    const resumed = api.requests[1]!.body.messages;
    assert.equal(resumed.length, 2);
    assert.equal(resumed[1].role, "assistant");
    assert.equal(resumed[1].content[0].type, "server_tool_use");
    assert.ok(log.includes("tool:Searching the web: London weather"));
  });

  it("reports a fallback to another model", async () => {
    api.queue.push(
      streamOf(
        [
          { start: { type: "fallback", from: { model: "claude-opus-5-5" }, to: { model: "claude-opus-4-8" } } },
          text("Handled by the backup."),
        ],
        "end_turn",
      ),
    );
    const { log, observer } = recordingObserver();
    const result = await jarvis.respond("Hello", observer, context());

    assert.equal(result.kind, "answered");
    assert.ok(log.includes("notice:Rerouting to claude-opus-4-8"));
  });
});

describe("sanitizeForHistory", () => {
  type Blocks = Anthropic.Beta.BetaContentBlock[];

  it("returns the content unchanged when no fallback happened", () => {
    const content = [{ type: "text", text: "hi", citations: null }] as Blocks;
    assert.equal(sanitizeForHistory(content), content);
  });

  it("keeps only text and answered server-tool calls before the last fallback", () => {
    const content = [
      { type: "thinking", thinking: "", signature: "s" },
      { type: "text", text: "Partial", citations: null },
      { type: "server_tool_use", id: "srv_1", name: "web_search", input: { query: "q" } },
      { type: "web_search_tool_result", tool_use_id: "srv_1", content: [] },
      { type: "server_tool_use", id: "srv_2", name: "web_search", input: { query: "q2" } },
      { type: "tool_use", id: "toolu_1", name: "get_datetime", input: {} },
      { type: "fallback", from: { model: "claude-opus-5-5" }, to: { model: "claude-opus-4-8" } },
      { type: "thinking", thinking: "", signature: "t" },
      { type: "text", text: "Rest", citations: null },
    ] as unknown as Blocks;

    const kept = sanitizeForHistory(content).map((block) =>
      block.type === "server_tool_use" ? `${block.type}:${block.id}` : block.type,
    );
    assert.deepEqual(kept, [
      "text",
      "server_tool_use:srv_1",
      "web_search_tool_result",
      "fallback",
      "thinking",
      "text",
    ]);
  });
});
