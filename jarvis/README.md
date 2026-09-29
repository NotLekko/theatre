# J.A.R.V.I.S.

*Just A Rather Very Intelligent System*: a terminal assistant modelled on Tony Stark's AI butler from the Iron Man films, powered by Claude.

```
You ▸ How's the machine holding up?
  › I'll run a quick diagnostic.
  ⟡ Running diagnostics
JARVIS ▸ All systems nominal, sir. CPU is idling at 4%, memory is 61% used, and you
         have 212 GB free on the main drive. Rather more than the Mark II ever had.

You ▸ Remind me to call Pepper in 20 minutes.
  ⟡ Reminder in 20 min: Call Pepper
JARVIS ▸ Done. I'll interrupt you at 18:42, sir.
```

## What it does

- **Talks like JARVIS.** Calm, precise, dry British wit. Replies are read aloud (macOS `say` with the British "Daniel" voice, `espeak-ng` on Linux, or Windows speech).
- **Answers to "Hey JARVIS".** Optional hands-free voice input, with speech recognized on your own machine.
- **Knows what's going on.** Web search and page fetching for news, weather, and anything current.
- **Runs your machine, with your approval.** Shell commands (you approve each one), system diagnostics (CPU, memory, disk, uptime), and opening web pages.
- **Remembers you.** Long-term memory across sessions in `~/.jarvis/memory.json`. Tell it your name, preferences, or projects, or ask it to remember something.
- **Keeps time.** The date and time, plus reminders that interrupt you with a spoken alert.
- **Shows its work.** Streams answers live, with short progress notes and a status line for each tool it uses. Ctrl+C interrupts at any point.

## Quick start

Requires **Node.js 22.18 or newer** (it runs the TypeScript source directly, with no build step) and a Claude API key from [console.anthropic.com](https://console.anthropic.com).

```bash
cd jarvis
npm install
export ANTHROPIC_API_KEY=sk-ant-...   # or put it in jarvis/.env
npm start
```

To talk to JARVIS instead of typing, start it with `--listen` (see [Voice input](#voice-input)):

```bash
npm start -- --listen
```

For a one-off question, pass it as an argument. JARVIS answers and exits:

```bash
npm start -- "what's the weather like in London?"
```

The key can also go in `jarvis/.env` (gitignored), which is loaded automatically:

```
ANTHROPIC_API_KEY=sk-ant-...
JARVIS_USER_NAME=Tony
```

## Commands

| Input | Effect |
| --- | --- |
| `/listen [on\|off]` | toggle voice input ("Hey JARVIS") |
| `/voice [on\|off]` | toggle speech |
| `/effort [level]` | show or set thinking effort: `low`, `medium` (default), `high`, `xhigh`, `max` |
| `/memory` | list what JARVIS remembers about you |
| `/forget <id>` | delete a memory |
| `/reminders` | list pending reminders |
| `/clear` | start a fresh conversation (memories carry over) |
| `/usage` | tokens used this session |
| `/exit`, Ctrl+D | power down |
| Ctrl+C | interrupt the current answer (or exit at the prompt) |

When JARVIS wants to run a shell command, you're asked `[y]es / [N]o / [a]lways this session`. Anything other than `y` or `a` declines. With voice input on, you can also answer out loud.

## Voice input

Start with `--listen` (or type `/listen` during a session), then speak:

```
You ▸ What time is it?  🎙                  ← you said "Hey JARVIS, what time is it?"
JARVIS ▸ It's a quarter past four, sir.

JARVIS ▸ Yes, sir?                         ← you said "Hey JARVIS" and paused
  🎙 Listening...
You ▸ Run a system diagnostic.  🎙
```

- **Wake phrase.** Say "Hey JARVIS" (or "Hi"/"OK JARVIS") at the start of a sentence, followed by your request in the same breath. If you say just "Hey JARVIS", he answers "Yes, sir?" and takes the next thing you say as the request. Other speech is ignored, including sentences that merely mention JARVIS.
- **Approvals.** When a shell command needs your OK, JARVIS asks out loud. Say "yes" or "go ahead" to allow it, or "always" to allow all commands this session. Anything else, or anything unclear, declines.
- **The keyboard still works.** Type at any time. Ctrl+C interrupts as usual.
- A pause of about half a second ends a request.

**Private by design.** Speech recognition runs entirely on your computer, with [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx), the [Silero](https://github.com/snakers4/silero-vad) voice activity detector and the [Moonshine Tiny](https://github.com/usefulsensors/moonshine) English speech recognizer. Audio never leaves your machine; only the text of a request goes to Claude. While voice input is on, the microphone stays open, so your OS may show its recording indicator. JARVIS only processes the audio while he's waiting for you, and ignores it while he speaks, so he doesn't hear himself. `/listen off` closes the microphone.

**First use** downloads about 110 MB of speech models from sherpa-onnx's GitHub releases into `~/.jarvis/models`. This happens once.

**Microphone.** Recording uses the bundled PvRecorder library, so there's nothing to install on macOS, Windows or Linux. On macOS, allow your terminal app under System Settings → Privacy & Security → Microphone. If PvRecorder can't open a device, JARVIS falls back to `sox` or `arecord` if either is installed. To use a microphone other than the default, set `JARVIS_MIC_DEVICE` to its index.

**Limitations.** English only. JARVIS can't be interrupted by voice while he's talking (type something, or press Ctrl+C). Headphones help in noisy rooms, and stop his own voice from reaching the microphone.

## Configuration

| Flag / variable | Default | Purpose |
| --- | --- | --- |
| `--no-voice` / `JARVIS_VOICE=off` | voice on | start muted |
| `--listen` / `JARVIS_LISTEN=on` | off | listen for "Hey JARVIS" from the start |
| `JARVIS_MIC_DEVICE` | system default | microphone device index for voice input |
| `--effort` / `JARVIS_EFFORT` | `medium` | thinking effort. `low` is snappier, `high` is more thorough |
| `--model` / `JARVIS_MODEL` | `claude-opus-5-5` | Claude model (tuned for Opus 5.5; `claude-sonnet-5-5` also works) |
| `--fast` | off | skip the boot animation |
| `JARVIS_HONORIFIC` | `sir` | how JARVIS addresses you (`ma'am`, `boss`, ...) |
| `JARVIS_USER_NAME` | none | your name |
| `JARVIS_VOICE_NAME` | `Daniel` (macOS), `en-gb` (espeak) | text-to-speech voice |
| `JARVIS_CITY`, `JARVIS_REGION`, `JARVIS_COUNTRY` | none | approximate location for local search results (country is a two-letter code, e.g. `GB`) |
| `JARVIS_HOME` | `~/.jarvis` | where memories and speech models are stored |

### Voice

- **macOS:** works out of the box. For the most JARVIS-like voice, install *Daniel (Enhanced)* under System Settings → Accessibility → Spoken Content.
- **Linux:** install espeak-ng (`sudo apt install espeak-ng`).
- **Windows:** uses the built-in speech synthesizer through PowerShell.

Without an engine, JARVIS runs in text-only mode.

## How it works

```
src/
  index.ts      terminal REPL: boot sequence, slash commands, approvals, Ctrl+C
  jarvis.ts     the conversation engine: streams Claude's reply, runs tools, loops
  tools.ts      local tools (time, diagnostics, shell, memory, reminders, browser)
                plus Anthropic-hosted web search and web fetch
  persona.ts    the system prompt that gives JARVIS his character
  hud.ts        colours, arc reactor, spinner, streaming renderer
  voice.ts      text-to-speech (text goes to the engine on stdin, never through a shell)
  memory.ts     persistent memory file
  reminders.ts  in-session timers
  listen/
    wake.ts           the "Hey JARVIS" wake phrase, and spoken yes/no answers
    voiceInput.ts     the conversation flow: wake phrase, "Yes, sir?", request
    ears.ts           microphone audio to text: voice activity detection + Moonshine
    microphone.ts     PvRecorder (on a worker thread), or sox/arecord
    recorderWorker.ts the worker thread that reads the microphone
    models.ts         downloads the speech models on first use
```

Each turn streams a request to the Claude Messages API with JARVIS's tools. When Claude calls a local tool, JARVIS validates the input against the tool's zod schema, runs it, sends the result back, and repeats until Claude answers. Web search and fetch run on Anthropic's side.

A few API features in use:

- **Adaptive thinking** at a configurable effort, with `display: "updates"`, so the short notes Claude writes between tool calls show up as `›` progress lines.
- **Refusal fallback** (`fallbacks: "default"`): if a safety classifier declines a request, the API retries it on Anthropic's recommended fallback model instead of failing.
- **Prompt caching** on the conversation prefix. The system prompt and tool list stay fixed for the whole conversation, and history is only ever appended to. An interrupted or refused turn is dropped from the end.

## Safety notes

- Shell commands always need your approval, unless you answer `a` ("always this session"). They run without stdin, in the current directory, with a timeout.
- Anything JARVIS reads, from command output to web pages to memories, is sent to the Claude API as part of the conversation.
- `open_url` only opens `http`/`https` links, and doesn't ask first.
- Voice input is off unless you turn it on. When it's on, audio stays on your machine, and only your transcribed requests are sent to Claude.
- Memories live in plain JSON at `~/.jarvis/memory.json` (readable only by you). JARVIS is told never to store secrets there.

## Adding a tool

Add a `defineTool({...})` entry to `localTools` in `src/tools.ts`. Give it a name, a description Claude reads to decide when to use it, a zod schema, a status label, and a `run` function that returns a string. For example:

```ts
const flipCoin = defineTool({
  name: "flip_coin",
  description: "Flip a fair coin.",
  schema: z.object({}),
  label: () => "Flipping a coin",
  async run() {
    return Math.random() < 0.5 ? "heads" : "tails";
  },
});
```

## Development

```bash
npm test          # unit tests + a streaming integration test against a mock Messages API
npm run typecheck
```

The voice-input tests that use the real speech models run when the models are present (in `~/.jarvis/models`, or wherever `JARVIS_TEST_MODELS` points) and `espeak-ng` is installed to synthesize test speech. Otherwise they're skipped.
