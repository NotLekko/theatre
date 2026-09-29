import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EFFORT_LEVELS, isEffort, type Config } from "./config.ts";
import type { Confirmation } from "./listen/wake.ts";
import { greeting } from "./persona.ts";
import { Session, type SessionUI } from "./session.ts";
import { FX_PRESETS, isFxPreset } from "./speech/fx.ts";
import { DEFAULT_NEURAL_VOICE, type NeuralVoiceName } from "./speech/kokoro.ts";
import { FilmVoice, speechChunks } from "./speech/narrator.ts";
import { encodeWav } from "./speech/wav.ts";
import { openInBrowser, systemSnapshot } from "./tools.ts";

const HUD_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "web", "hud.html");

/** Everything the server tells the page, as server-sent events. */
export type WebEvent =
  | {
      type: "hello";
      model: string;
      effort: string;
      honorific: string;
      listening: boolean;
      microphone?: string;
      busy: boolean;
      memories: number;
      /** The film voice, when the server is rendering speech. */
      voice?: string;
    }
  | { type: "user"; text: string; spoken: boolean }
  | { type: "waiting" }
  | { type: "text"; delta: string }
  | { type: "progress"; delta: string }
  | { type: "blockEnd" }
  | { type: "tool"; label: string }
  | { type: "notice"; message: string }
  | { type: "say"; text: string }
  | { type: "note"; text: string }
  | { type: "error"; text: string }
  | { type: "reminder"; text: string }
  | { type: "acknowledge"; text: string }
  | { type: "voiceStatus"; text: string | null }
  | { type: "voiceInput"; on: boolean; microphone?: string }
  | { type: "turnStarted"; input: string }
  | { type: "turnEnded"; outcome: string }
  /** With `chunks`, the film voice follows as that many speechAudio events; otherwise the page speaks. */
  | { type: "speak"; id: string; text: string; chunks?: number }
  | { type: "speechAudio"; id: string; index: number; wav: string }
  | { type: "stopSpeaking" }
  | { type: "approval"; id: string; question: string }
  | { type: "approvalClosed"; id: string; answer?: Confirmation; byVoice?: boolean };

/** Rough speaking time, so a reply still finishes if no page reports back. */
const speakingTimeMs = (text: string) => 6000 + text.split(/\s+/).length * 450;

// How long a reply waits for the film voice to load from disk before the browser's voice stands in.
const LOAD_WAIT_MS = 20_000;

/** The session's face in a browser: events out over SSE, answers back over POST. */
class WebUI implements SessionUI {
  /** Renders the film voice for the page to play, once it has loaded. */
  film: FilmVoice | null = null;
  readonly #clients = new Set<http.ServerResponse>();
  readonly #speeches = new Map<string, () => void>();
  readonly #approvals = new Map<string, (answer: Confirmation) => void>();
  #pendingApproval: { id: string; question: string } | null = null;

  addClient(res: http.ServerResponse, hello: WebEvent): void {
    this.#clients.add(res);
    res.on("close", () => this.#clients.delete(res));
    this.#send(res, hello);
    if (this.#pendingApproval) this.#send(res, { type: "approval", ...this.#pendingApproval });
  }

  get clientCount(): number {
    return this.#clients.size;
  }

  #send(res: http.ServerResponse, event: WebEvent): void {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  broadcast(event: WebEvent): void {
    for (const client of this.#clients) this.#send(client, event);
  }

  // Streaming output of a turn.
  waiting = () => this.broadcast({ type: "waiting" });
  text = (delta: string) => this.broadcast({ type: "text", delta });
  progress = (delta: string) => this.broadcast({ type: "progress", delta });
  blockEnd = () => this.broadcast({ type: "blockEnd" });
  tool = (label: string) => this.broadcast({ type: "tool", label });
  notice = (message: string) => this.broadcast({ type: "notice", message });

  say = (text: string) => this.broadcast({ type: "say", text });
  note = (text: string) => this.broadcast({ type: "note", text });
  error = (text: string) => this.broadcast({ type: "error", text });
  reminder = (text: string) => this.broadcast({ type: "reminder", text });
  heard = (text: string) => this.broadcast({ type: "user", text, spoken: true });
  acknowledge = (text: string) => this.broadcast({ type: "acknowledge", text });
  voiceStatus = (text: string | null) => this.broadcast({ type: "voiceStatus", text });
  voiceInputChanged = (on: boolean, microphone?: string) => this.broadcast({ type: "voiceInput", on, microphone });
  turnStarted = (input: string) => this.broadcast({ type: "turnStarted", input });
  turnEnded = (outcome: string) => this.broadcast({ type: "turnEnded", outcome });

  /** The page speaks (in the film voice, rendered here, when it's ready) and reports back when it's done. */
  speak(text: string): Promise<void> {
    if (this.#clients.size === 0 || !text.trim()) return Promise.resolve();
    for (const end of [...this.#speeches.values()]) end();
    const id = randomUUID();
    const rendering = new AbortController();
    return new Promise((resolve) => {
      const timer = setTimeout(done, speakingTimeMs(text));
      function done() {
        clearTimeout(timer);
        rendering.abort();
        resolve();
      }
      this.#speeches.set(id, () => {
        this.#speeches.delete(id);
        done();
      });
      void this.#narrate(id, text, rendering.signal);
    });
  }

  /** Sends a line to the page: as film-voice audio, or as text for the browser's own voice. */
  async #narrate(id: string, text: string, signal: AbortSignal): Promise<void> {
    const film = this.film;
    const narrator = film?.narrator ?? (await film?.whenReady(LOAD_WAIT_MS)) ?? null;
    if (signal.aborted) return;
    if (!narrator) {
      this.broadcast({ type: "speak", id, text });
      return;
    }
    const chunks = speechChunks(text);
    this.broadcast({ type: "speak", id, text, chunks: chunks.length });
    try {
      let index = 0;
      for await (const samples of narrator.render(chunks, signal)) {
        const wav = encodeWav(samples, narrator.sampleRate).toString("base64");
        this.broadcast({ type: "speechAudio", id, index: index++, wav });
      }
    } catch (err) {
      if (signal.aborted) return;
      film?.fail();
      this.note(`🔊 My film voice failed (${(err as Error).message}). The browser's voice will stand in.`);
      this.broadcast({ type: "speak", id, text });
    }
  }

  speechEnded(id: string): void {
    this.#speeches.get(id)?.();
  }

  stopSpeaking(): void {
    for (const end of [...this.#speeches.values()]) end();
    this.broadcast({ type: "stopSpeaking" });
  }

  askApproval(question: string, signal: AbortSignal): Promise<Confirmation> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const close = (answer?: Confirmation) => {
        this.#approvals.delete(id);
        this.#pendingApproval = null;
        signal.removeEventListener("abort", onAbort);
        this.broadcast({ type: "approvalClosed", id, answer });
      };
      const onAbort = () => {
        close();
        reject(signal.reason);
      };
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      this.#approvals.set(id, (answer) => {
        close(answer);
        resolve(answer);
      });
      this.#pendingApproval = { id, question };
      this.broadcast({ type: "approval", id, question });
    });
  }

  answerApproval(id: string, answer: Confirmation): boolean {
    const answerIt = this.#approvals.get(id);
    answerIt?.(answer);
    return answerIt !== undefined;
  }

  approvedByVoice(answer: Confirmation): void {
    this.note(`Approval answered out loud: ${answer}`);
  }
}

/** Typed requests from the page, handed to the session one at a time. */
class Inbox {
  readonly #queue: string[] = [];
  #waiting: { resolve: (text: string) => void } | null = null;

  push(text: string): void {
    if (this.#waiting) {
      const { resolve } = this.#waiting;
      this.#waiting = null;
      resolve(text);
    } else {
      this.#queue.push(text);
    }
  }

  next(signal: AbortSignal): Promise<string> {
    const queued = this.#queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.#waiting = null;
        reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.#waiting = {
        resolve: (text) => {
          signal.removeEventListener("abort", onAbort);
          resolve(text);
        },
      };
    });
  }
}

const ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="14" fill="#02070d" stroke="#4fd4ff" stroke-width="2"/>' +
  '<circle cx="16" cy="16" r="8" fill="none" stroke="#4fd4ff" stroke-width="3" stroke-dasharray="4 2.3"/><circle cx="16" cy="16" r="4" fill="#e2f8ff"/></svg>';

/** The page's HTML is written as an artifact body; give it a document around it here. */
function renderPage(token: string): string {
  const hud = fs.readFileSync(HUD_FILE, "utf8");
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
    `<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(ICON)}">` +
    `<script>window.JARVIS_LOCAL = ${JSON.stringify({ token })};</script>` +
    "<style>html,body{margin:0;height:100%}</style></head><body>" +
    hud +
    "</body></html>"
  );
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 64_000) throw new Error("Request too large");
  }
  const body: unknown = JSON.parse(raw || "{}");
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("Expected a JSON object");
  return body as Record<string, unknown>;
}

/** Loads the film voice for the page, unless speech is off or the system voice was chosen. */
function startFilmVoice(config: Config, ui: WebUI, announce: () => void): FilmVoice | null {
  if (!config.voice || config.voiceEngine !== "neural") return null;
  return new FilmVoice({
    modelsDir: path.join(config.home, "models"),
    voice: (config.voiceName as NeuralVoiceName | undefined) ?? DEFAULT_NEURAL_VOICE,
    fx: config.voiceFx,
    download: true,
    onReady: (downloaded) => {
      if (downloaded) ui.note("🔊 My film voice is ready.");
      announce();
    },
    onError: (err) => ui.note(`🔊 I couldn't load my film voice (${err.message}). The browser's voice will stand in.`),
  });
}

/** Serves the HUD on this machine only, backed by a full JARVIS session. */
export async function startWebServer(
  config: Config,
  options: { port: number; session?: (ui: SessionUI) => Session; film?: (ui: WebUI) => FilmVoice | null },
) {
  const ui = new WebUI();
  const session = options.session?.(ui) ?? new Session(config, ui);
  ui.film = options.film ? options.film(ui) : startFilmVoice(config, ui, () => ui.broadcast(hello()));
  const inbox = new Inbox();
  const token = randomBytes(24).toString("hex");
  let stopped = false;

  const hello = (): WebEvent => ({
    type: "hello",
    model: session.jarvis.model,
    effort: session.jarvis.effort,
    honorific: config.honorific,
    listening: session.listening,
    busy: session.busy,
    memories: session.memory.list().length,
    voice: ui.film?.narrator ? `film voice · ${ui.film.fx}` : undefined,
  });

  /** A few commands the page can send as text, as in the terminal. */
  async function command(text: string): Promise<void> {
    const [name = "", ...rest] = text.slice(1).trim().split(/\s+/);
    const arg = rest.join(" ");
    switch (name.toLowerCase()) {
      case "listen":
        if (arg === "off" || (!arg && session.listening)) session.stopListening();
        else await session.startListening();
        break;
      case "effort":
        if (isEffort(arg)) session.jarvis.effort = arg;
        else ui.error(`Unknown effort level. Use one of: ${EFFORT_LEVELS.join(", ")}.`);
        break;
      case "clear":
        session.reset();
        ui.note("Fresh conversation. Long-term memory carried over.");
        break;
      case "voice":
        if (!isFxPreset(arg)) ui.error(`Choose how the film voice sounds: ${FX_PRESETS.join(", ")}.`);
        else if (!ui.film?.usable) ui.error("Effects apply to the film voice, which isn't in use.");
        else {
          ui.film.fx = arg;
          ui.note(`Voice effects: ${arg}.`);
        }
        break;
      default:
        ui.error(`Unknown command /${name}.`);
    }
    ui.broadcast(hello());
  }

  const allowedHosts = new Set<string>();
  const server = http.createServer(async (req, res) => {
    const reply = (status: number, body: unknown = { ok: status < 400 }) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    try {
      // Only this machine may talk to JARVIS. Checking Host blocks DNS rebinding; the token
      // and Origin checks stop other websites open in the same browser.
      if (!allowedHosts.has(req.headers.host ?? "")) return reply(421, { error: "Unknown host" });
      const origin = req.headers.origin;
      if (origin && !allowedHosts.has(origin.replace(/^http:\/\//, ""))) return reply(403, { error: "Cross-origin request" });

      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "content-security-policy":
            "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
            "font-src https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data:",
        });
        res.end(renderPage(token));
        return;
      }

      if (!url.pathname.startsWith("/api/")) return reply(404, { error: "Not found" });
      const given = req.headers["x-jarvis-token"] ?? url.searchParams.get("token");
      if (given !== token) return reply(401, { error: "Missing or wrong token" });

      if (req.method === "GET" && url.pathname === "/api/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        ui.addClient(res, hello());
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/stats") {
        const reminders = session.reminders.list().map((r) => ({
          id: r.id,
          message: r.message,
          due: r.dueAt.toLocaleTimeString("en-GB", { hour12: false }),
        }));
        return reply(200, { ...(await systemSnapshot()), reminders });
      }

      if (req.method !== "POST") return reply(405, { error: "Method not allowed" });
      if (!req.headers["content-type"]?.startsWith("application/json")) return reply(415, { error: "Send JSON" });
      const body = await readJson(req);

      switch (url.pathname) {
        case "/api/message": {
          const text = typeof body.text === "string" ? body.text.trim() : "";
          if (!text) return reply(400, { error: "Say something" });
          if (text.length > 20_000) return reply(413, { error: "That message is too long" });
          if (session.busy) return reply(409, { error: "JARVIS is still working on the last request" });
          inbox.push(text);
          return reply(202);
        }
        case "/api/approval": {
          const answer = body.answer;
          if (typeof body.id !== "string" || (answer !== "yes" && answer !== "no" && answer !== "always")) {
            return reply(400, { error: "Expected an id and yes, no or always" });
          }
          return ui.answerApproval(body.id, answer) ? reply(200) : reply(404, { error: "No such question" });
        }
        case "/api/speech":
          if (typeof body.id === "string") ui.speechEnded(body.id);
          return reply(200);
        case "/api/stop":
          session.cancelTurn();
          ui.stopSpeaking();
          return reply(200);
        default:
          return reply(404, { error: "Not found" });
      }
    } catch (err) {
      reply(400, { error: (err as Error).message });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  for (const host of ["127.0.0.1", "localhost"]) allowedHosts.add(`${host}:${port}`);

  // The conversation loop: typed requests from the page, or "Hey JARVIS" when listening.
  const loop = (async () => {
    while (!stopped) {
      const request = await session.nextRequest((signal) => inbox.next(signal));
      if (!request || stopped) continue;
      if (request.text.startsWith("/") && !request.spoken) {
        await command(request.text);
        continue;
      }
      ui.broadcast({ type: "user", text: request.text, spoken: request.spoken });
      await session.converse(request.text);
    }
  })();

  return {
    url: `http://127.0.0.1:${port}/`,
    token,
    session,
    ui,
    async close() {
      stopped = true;
      session.interrupt();
      session.close();
      ui.film?.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await loop;
    },
  };
}

/** `npm run web`: serve the HUD and open it in the browser. */
export async function runWeb(config: Config, port: number): Promise<void> {
  const web = await startWebServer(config, { port });
  console.log(`J.A.R.V.I.S. is online at ${web.url}`);
  console.log(greeting(config.honorific));
  if (config.listen) await web.session.startListening();
  openInBrowser(web.url).catch(() => console.log("Open that address in your browser."));
  const shutdown = async () => {
    console.log("\nPowering down.");
    await web.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
