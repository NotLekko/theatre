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

- **Talks like JARVIS.** Calm, precise, dry British wit, read aloud in a film-style voice: a neural British voice that runs on your computer, processed to sound like the assistant in the films. See [His voice](#his-voice).
- **Answers to "Hey JARVIS".** Optional hands-free voice input, with speech recognized on your own machine.
- **Knows what's going on.** Web search and page fetching for news, weather, and anything current.
- **Runs your machine, with your approval.** Shell commands (you approve each one), system diagnostics (CPU, memory, disk, uptime), and opening web pages.
- **Remembers you.** Long-term memory across sessions in `~/.jarvis/memory.json`. Tell it your name, preferences, or projects, or ask it to remember something.
- **Keeps time.** The date and time, plus reminders that interrupt you with a spoken alert.
- **Shows its work.** Streams answers live, with short progress notes and a status line for each tool it uses. Ctrl+C interrupts at any point.
- **Looks the part.** `npm run web` opens the holographic display from the films in your browser: an animated arc reactor that reacts as he listens, thinks and speaks, with live diagnostics, an activity log and the conversation.

## Quick start

Requires **Node.js 22.18 or newer** (it runs the TypeScript source directly, with no build step) and a Claude API key from [console.anthropic.com](https://console.anthropic.com).

```bash
cd jarvis
npm install
export ANTHROPIC_API_KEY=sk-ant-...   # or put it in jarvis/.env
npm start
```

For the holographic display in your browser (see [The HUD](#the-hud)):

```bash
npm run web
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
| `/voice film\|helmet\|clean` | how his voice is processed (see [His voice](#his-voice)) |
| `/effort [level]` | show or set thinking effort: `low`, `medium` (default), `high`, `xhigh`, `max` |
| `/memory` | list what JARVIS remembers about you |
| `/forget <id>` | delete a memory |
| `/reminders` | list pending reminders |
| `/clear` | start a fresh conversation (memories carry over) |
| `/usage` | tokens used this session |
| `/exit`, Ctrl+D | power down |
| Ctrl+C | interrupt the current answer (or exit at the prompt) |

When JARVIS wants to run a shell command, you're asked `[y]es / [N]o / [a]lways this session`. Anything other than `y` or `a` declines. With voice input on, you can also answer out loud.

## His voice

JARVIS speaks with a neural voice, [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M)'s British "Fable", run on your computer through sherpa-onnx with Received Pronunciation. It's then put through a small effects chain for the polished, faintly synthetic sound of the assistant in the films. It's a British voice styled after the character, not a copy of the actor's.

- **`film`** (the default) trims the low rumble, lifts presence and air, adds a faint drifting double and a touch of room, and evens out the level.
- **`helmet`** is JARVIS inside the suit: narrower, drier and slightly driven.
- **`clean`** is the plain voice.

Switch with `/voice film`, `/voice helmet` or `/voice clean`, or set `JARVIS_VOICE_FX`. Three other British voices are available with `JARVIS_VOICE_NAME`: `bm_daniel`, `bm_george` and `bm_lewis`.

**First use** downloads the voice model (132 MB) from sherpa-onnx's GitHub releases into `~/.jarvis/models`. It happens in the background: JARVIS speaks with your system's voice until it's ready, then says so. A one-off question (`npm start -- "..."`) doesn't start the download.

He speaks a sentence at a time, preparing the next while the current one plays, so he starts talking within a second or two of an answer arriving. Where your computer makes speech faster than he speaks, as most recent ones should, there are no pauses; on a slow computer there can be a short gap before a long sentence.

**Playing sound** uses `afplay` on macOS and the built-in player on Windows. On Linux it uses the first of `paplay`, `pw-play`, `aplay`, `play` (SoX) or `ffplay` it finds; most desktops have `paplay` or `pw-play`.

**Your system's voice** stands in while the film voice downloads, or if it can't load (for example if sherpa-onnx isn't installed). To always use it, set `JARVIS_VOICE_ENGINE=system`:

- **macOS:** works out of the box. For the most JARVIS-like voice, install *Daniel (Enhanced)* under System Settings → Accessibility → Spoken Content.
- **Linux:** install espeak-ng (`sudo apt install espeak-ng`).
- **Windows:** uses the built-in speech synthesizer through PowerShell.

Without either, JARVIS runs in text-only mode.

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
- **Interrupting.** Say "Hey JARVIS" while he's talking and he stops mid-sentence. "Hey JARVIS, what about tomorrow?" gets a new answer; "Hey JARVIS, stop" (or "never mind", "that's enough") just silences him. It works the same while he's working on a request: he drops it and takes the new one.
- **Approvals.** When a shell command needs your OK, JARVIS asks out loud. Say "yes" or "go ahead" to allow it, or "always" to allow all commands this session. Anything else, or anything unclear, declines.
- **The keyboard still works.** Type at any time. Ctrl+C interrupts as usual.
- A pause of about half a second ends a request.

**Private by design.** Speech recognition runs entirely on your computer, with [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx), the [Silero](https://github.com/snakers4/silero-vad) voice activity detector and the [Moonshine Tiny](https://github.com/usefulsensors/moonshine) English speech recognizer. Audio never leaves your machine; only the text of a request goes to Claude. While voice input is on, the microphone stays open, so your OS may show its recording indicator. JARVIS only processes the audio while he's waiting for you. While he's speaking he listens for "Hey JARVIS" alone, so he doesn't take his own words for yours. `/listen off` closes the microphone.

**First use** downloads about 130 MB of speech models from sherpa-onnx's GitHub releases into `~/.jarvis/models`, including a small keyword-spotting model that listens for "Hey JARVIS" while he talks. This happens once.

**Interrupting through speakers.** When JARVIS talks through speakers, your microphone hears him as well as you, and there's no echo cancellation. Interrupting works reliably with headphones. Through speakers it works when you're clearly louder than him at the microphone. In tests with synthesized voices, it caught about 11 in 12 interruptions when his voice was a third as loud as yours, about 3 in 4 at 60%, and about half at 80%. Turning his volume down, or speaking up, helps. He never mistook his own speech for the wake phrase in testing.

**Microphone.** Recording uses the bundled PvRecorder library, so there's nothing to install on macOS, Windows or Linux. On macOS, allow your terminal app under System Settings → Privacy & Security → Microphone. If PvRecorder can't open a device, JARVIS falls back to `sox` or `arecord` if either is installed. To use a microphone other than the default, set `JARVIS_MIC_DEVICE` to its index.

**Limitations.** English only. Headphones help in noisy rooms, and keep his own voice away from the microphone.

## The HUD

`npm run web` serves the display at http://127.0.0.1:4242 and opens it in your browser. It's the same JARVIS as the terminal version, with the same tools, memory and reminders, just a different face:

- **The arc reactor** in the middle shows his state. It breathes on standby, sweeps while he processes, flashes amber when he uses a tool, and traces his voice while he speaks.
- **The conversation** streams in below it. When he wants to run a command, an approval card appears; choose Proceed, Decline or Allow all this session.
- **Readouts** on the left show live CPU, memory and disk figures for your computer. The activity log on the right lists every tool he's used and every alert.
- **Voice.** Replies are spoken in [his film voice](#his-voice), made on your computer and played by the page. Until the voice has downloaded, your browser speaks instead. The speaker button mutes him. Browsers only allow sound after you've interacted with the page, so click it once if he's silent. To change the effects, type `/voice helmet` (or `film`, `clean`). The microphone button turns on "Hey JARVIS" listening, which works as described in [Voice input](#voice-input): recognition runs on your computer, and you can interrupt him mid-sentence.

The server only accepts connections from your own computer. Each run makes a new access token that only the page it serves knows, and it rejects requests from other websites, so a page you visit elsewhere can't instruct JARVIS. Use `--port` (or `JARVIS_PORT`) to pick a different port.

The same page also runs as a hosted artifact on claude.ai, with no setup. There it talks to Claude through your Claude account and keeps its memories in that browser. It speaks with your browser's best British male voice: Microsoft's natural "Ryan" or "Thomas" in Edge, Daniel on Apple devices, or Google UK English Male in Chrome. Browsers don't give hosted pages the microphone, so it takes typed instructions only, and it can't run commands or search the web.

## Configuration

| Flag / variable | Default | Purpose |
| --- | --- | --- |
| `--no-voice` / `JARVIS_VOICE=off` | voice on | start muted |
| `--listen` / `JARVIS_LISTEN=on` | off | listen for "Hey JARVIS" from the start |
| `JARVIS_MIC_DEVICE` | system default | microphone device index for voice input |
| `--effort` / `JARVIS_EFFORT` | `medium` | thinking effort. `low` is snappier, `high` is more thorough |
| `--model` / `JARVIS_MODEL` | `claude-opus-5-5` | Claude model (tuned for Opus 5.5; `claude-sonnet-5-5` also works) |
| `--fast` | off | skip the boot animation |
| `--web` (`npm run web`) | off | serve the HUD in your browser instead of using the terminal |
| `--port` / `JARVIS_PORT` | `4242` | port for the HUD |
| `JARVIS_HONORIFIC` | `sir` | how JARVIS addresses you (`ma'am`, `boss`, ...) |
| `JARVIS_USER_NAME` | none | your name |
| `JARVIS_VOICE_ENGINE` | `neural` | `neural` for the film voice, `system` for your operating system's text-to-speech |
| `JARVIS_VOICE_NAME` | `bm_fable` | the film voice (`bm_fable`, `bm_daniel`, `bm_george`, `bm_lewis`), or with the system engine an OS voice such as `Daniel` (macOS) or `en-gb` (espeak) |
| `JARVIS_VOICE_FX` | `film` | how the film voice is processed: `film`, `helmet` or `clean` |
| `JARVIS_CITY`, `JARVIS_REGION`, `JARVIS_COUNTRY` | none | approximate location for local search results (country is a two-letter code, e.g. `GB`) |
| `JARVIS_HOME` | `~/.jarvis` | where memories and voice models are stored |

## How it works

```
src/
  index.ts      command line: picks the terminal or the web front end
  session.ts    one conversation: approvals, voice input, interruptions, reminders
  terminal.ts   the terminal front end: boot sequence, prompts, slash commands
  web.ts        the web front end: a local server for the HUD
  jarvis.ts     the conversation engine: streams Claude's reply, runs tools, loops
  tools.ts      local tools (time, diagnostics, shell, memory, reminders, browser)
                plus Anthropic-hosted web search and web fetch
  persona.ts    the system prompt that gives JARVIS his character
  hud.ts        terminal colours, ASCII arc reactor, spinner, streaming renderer
  voice.ts      the system voice (text goes to the engine on stdin, never through a shell)
  memory.ts     persistent memory file
  reminders.ts  in-session timers
  models.ts     downloads the voice and speech models on first use
  speech/
    speaker.ts        his voice in the terminal: the film voice, or the system voice standing in
    narrator.ts       splits replies into sentences and renders them, one ahead of playback
    kokoro.ts         the neural voice model
    fx.ts             the effects chain: film, helmet, clean
    player.ts         plays audio with afplay, paplay, aplay and friends
    wav.ts            WAV encoding
  listen/
    wake.ts           the "Hey JARVIS" wake phrase, and spoken yes/no answers
    voiceInput.ts     the conversation flow: wake phrase, "Yes, sir?", request
    ears.ts           microphone audio to text; hears "Hey JARVIS" while he talks
    engine.ts         the speech models: Silero VAD, Moonshine, keyword spotter
    microphone.ts     PvRecorder (on a worker thread), or sox/arecord
    recorderWorker.ts the worker thread that reads the microphone
web/
  hud.html      the holographic display, for both the local server and claude.ai
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

The film voice's tests run without the model, using a stand-in synthesizer and player. With the voice and speech models present (see below), a further test checks that every effects preset stays intelligible to the speech recognizer.

The voice-input tests that use the real speech models run when the models are present (in `~/.jarvis/models`, or wherever `JARVIS_TEST_MODELS` points) and `espeak-ng` is installed to synthesize test speech. Otherwise they're skipped. The interruption test also needs two Piper voices from [sherpa-onnx's tts-models release](https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models) (`vits-piper-en_GB-alan-medium` and `vits-piper-en_US-amy-low`) unpacked in the folder `JARVIS_TEST_VOICES` points to, because the keyword spotter doesn't recognize espeak-ng's robotic voice. The listening logic itself is also tested without any models, using a fake speech engine.
