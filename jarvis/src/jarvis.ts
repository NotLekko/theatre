import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Effort } from "./config.ts";
import { toApiTool, type LocalTool, type ToolContext } from "./tools.ts";

type MessageParam = Anthropic.Beta.BetaMessageParam;
type ContentBlock = Anthropic.Beta.BetaContentBlock;
type ContentBlockParam = Anthropic.Beta.BetaContentBlockParam;
type ToolUseBlock = Anthropic.Beta.BetaToolUseBlock;
type ToolResult = Anthropic.Beta.BetaToolResultBlockParam;

const BETAS: Anthropic.Beta.AnthropicBeta[] = [
  // `fallbacks: "default"`: if a safety classifier declines a request, the API retries it
  // on Anthropic's recommended fallback model instead of returning the refusal.
  "server-side-fallback-2026-07-01",
  // `display: "updates"`: the short notes Claude writes between tool calls come back as
  // readable text ("Checking the disk now..."), while its reasoning stays hidden.
  "thinking-display-updates-2026-08-18",
];

/** Receives a turn's output as it streams in. */
export interface TurnObserver {
  /** A request is in flight and nothing has arrived yet. */
  waiting(): void;
  text(delta: string): void;
  /** A progress note written between tool calls. */
  progress(delta: string): void;
  blockEnd(): void;
  tool(label: string): void;
  notice(message: string): void;
}

export type TurnResult =
  | { kind: "answered"; text: string; truncated: boolean }
  | { kind: "refused"; category: string | null };

export interface Usage {
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface JarvisOptions {
  client: Anthropic;
  model: string;
  effort: Effort;
  system: string;
  localTools: LocalTool[];
  serverTools: Anthropic.Beta.BetaToolUnion[];
}

/**
 * What goes back into the history from an assistant turn. Normally that's the content
 * unchanged. When a fallback model took over part-way through, the declined model's
 * partial output before the last `fallback` marker is trimmed to what the fallback
 * model can use: text, plus server-tool calls that have their results.
 */
export function sanitizeForHistory(content: ContentBlock[]): ContentBlockParam[] {
  const boundary = content.findLastIndex((block) => block.type === "fallback");
  if (boundary === -1) return content;
  const answered = new Set<string>();
  for (const block of content) {
    if ("tool_use_id" in block && typeof block.tool_use_id === "string") answered.add(block.tool_use_id);
  }
  return content.filter((block, index) => {
    if (index >= boundary) return true;
    if (block.type === "text") return true;
    if (block.type === "server_tool_use") return answered.has(block.id);
    // Server-tool results; the call each one answers is kept above.
    return "tool_use_id" in block;
  });
}

function describeServerTool(block: Anthropic.Beta.BetaServerToolUseBlock): string {
  const input = (block.input ?? {}) as Record<string, unknown>;
  switch (block.name) {
    case "web_search":
      return `Searching the web: ${String(input.query ?? "")}`;
    case "web_fetch":
      return `Reading ${String(input.url ?? "a web page")}`;
    default:
      return "Analysing the results";
  }
}

function isToolUse(block: ContentBlockParam): block is ToolUseBlock {
  return block.type === "tool_use";
}

export class Jarvis {
  readonly #client: Anthropic;
  readonly #tools: Map<string, LocalTool>;
  readonly #apiTools: Anthropic.Beta.BetaToolUnion[];
  #system: string;
  #messages: MessageParam[] = [];
  model: string;
  effort: Effort;
  readonly usage: Usage = { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  constructor(options: JarvisOptions) {
    this.#client = options.client;
    this.model = options.model;
    this.effort = options.effort;
    this.#system = options.system;
    this.#tools = new Map(options.localTools.map((tool) => [tool.name, tool]));
    // Tools are fixed for the whole session: changing them mid-conversation would
    // invalidate the prompt cache and the thinking blocks already in the history.
    this.#apiTools = [...options.localTools.map(toApiTool), ...options.serverTools];
  }

  /** The conversation so far, as sent to the API. */
  get history(): readonly MessageParam[] {
    return this.#messages;
  }

  /** Starts a fresh conversation, optionally with a new system prompt. */
  reset(system?: string): void {
    this.#messages = [];
    if (system !== undefined) this.#system = system;
  }

  async respond(userText: string, observer: TurnObserver, ctx: ToolContext): Promise<TurnResult> {
    const checkpoint = this.#messages.length;
    this.#messages.push({ role: "user", content: userText });
    try {
      const result = await this.#runTurn(observer, ctx);
      if (result.kind === "refused") this.#messages.length = checkpoint;
      return result;
    } catch (err) {
      // Drop the unfinished turn. Only trailing messages go, so everything earlier -
      // including replayed thinking blocks - stays exactly as the API last saw it.
      this.#messages.length = checkpoint;
      throw err;
    }
  }

  async #runTurn(observer: TurnObserver, ctx: ToolContext): Promise<TurnResult> {
    let spoken: string[] = [];
    let parseRetries = 0;

    while (true) {
      ctx.signal.throwIfAborted();
      observer.waiting();
      const stream = this.#client.beta.messages.stream(
        {
          model: this.model,
          max_tokens: 64000,
          betas: BETAS,
          fallbacks: "default",
          thinking: { type: "adaptive", display: "updates" },
          output_config: { effort: this.effort },
          cache_control: { type: "ephemeral" },
          system: this.#system,
          tools: this.#apiTools,
          messages: this.#messages,
        },
        { signal: ctx.signal },
      );

      let toolInputStarted = false;
      stream.on("streamEvent", (event) => {
        switch (event.type) {
          case "content_block_start":
            if (event.content_block.type === "tool_use") toolInputStarted = true;
            if (event.content_block.type === "fallback") {
              observer.notice(`Rerouting to ${event.content_block.to.model}`);
            }
            break;
          case "content_block_delta":
            if (event.delta.type === "text_delta") observer.text(event.delta.text);
            else if (event.delta.type === "thinking_delta" && event.delta.thinking) observer.progress(event.delta.thinking);
            break;
          case "content_block_stop":
            observer.blockEnd();
            break;
        }
      });
      stream.on("contentBlock", (block) => {
        if (block.type === "server_tool_use") observer.tool(describeServerTool(block));
      });

      let message: Anthropic.Beta.BetaMessage;
      try {
        message = await stream.finalMessage();
        parseRetries = 0;
      } catch (err) {
        // With eager input streaming, a tool input that isn't valid JSON rejects the
        // stream when its block closes. That turn never entered the history, so
        // re-issue it (a couple of times at most). API errors - including a user
        // abort - and failures before any tool input streamed propagate.
        const unparsableToolInput = toolInputStarted && !(err instanceof Anthropic.APIError);
        if (!unparsableToolInput || parseRetries++ >= 2) throw err;
        observer.notice("Garbled tool request; retrying");
        continue;
      }
      this.#track(message.usage);

      // A refusal can arrive mid-stream and cut a tool call off; never run its tools.
      if (message.stop_reason === "refusal") {
        return { kind: "refused", category: message.stop_details?.category ?? null };
      }

      const content = sanitizeForHistory(message.content);
      const toolUses = content.filter(isToolUse);
      for (const block of content) if (block.type === "text") spoken.push(block.text);

      if (message.stop_reason === "pause_turn") {
        // A long server-side tool run paused; send the turn back to let it continue.
        this.#messages.push({ role: "assistant", content });
        continue;
      }

      if (toolUses.length > 0) {
        // A tool input cut off at max_tokens can still look valid, so don't run it.
        if (message.stop_reason !== "tool_use") {
          throw new Error(`My instructions were cut off (stop reason: ${message.stop_reason}). Please try again.`);
        }
        this.#messages.push({ role: "assistant", content });
        const results: ToolResult[] = [];
        for (const block of toolUses) results.push(await this.#execute(block, observer, ctx));
        // All results go back together, in one user message.
        this.#messages.push({ role: "user", content: results });
        spoken = [];
        continue;
      }

      this.#messages.push({ role: "assistant", content });
      return {
        kind: "answered",
        text: spoken.join(""),
        truncated: message.stop_reason === "max_tokens" || message.stop_reason === "model_context_window_exceeded",
      };
    }
  }

  async #execute(block: ToolUseBlock, observer: TurnObserver, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.#tools.get(block.name);
    if (!tool) {
      return { type: "tool_result", tool_use_id: block.id, is_error: true, content: `Unknown tool: ${block.name}` };
    }
    // Streamed tool input is parsed leniently, so validate it before acting on it.
    const parsed = tool.schema.safeParse(block.input);
    if (!parsed.success) {
      return {
        type: "tool_result",
        tool_use_id: block.id,
        is_error: true,
        content: JSON.stringify({ INVALID_JSON: JSON.stringify(block.input), problems: z.prettifyError(parsed.error) }),
      };
    }
    observer.tool(tool.label(parsed.data));
    try {
      return { type: "tool_result", tool_use_id: block.id, content: await tool.run(parsed.data, ctx) };
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      const message = err instanceof Error ? err.message : String(err);
      return { type: "tool_result", tool_use_id: block.id, is_error: true, content: message };
    }
  }

  #track(usage: Anthropic.Beta.BetaUsage): void {
    this.usage.requests++;
    this.usage.input += usage.input_tokens;
    this.usage.output += usage.output_tokens;
    this.usage.cacheRead += usage.cache_read_input_tokens ?? 0;
    this.usage.cacheWrite += usage.cache_creation_input_tokens ?? 0;
  }
}
