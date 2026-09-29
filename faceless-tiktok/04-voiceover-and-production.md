# 04 — Voiceover & Video Production

## Part A — Voiceover

### Pick your voice (decide once, never change it)

| Option | Cost | Originality | Recommendation |
|---|---|---|---|
| **A. Clone your own voice** in ElevenLabs (record 1–3 min once, then type scripts forever) | Paid tier | ★★★ No other account has this voice | **Recommended.** Faceless doesn't have to mean voiceless, and a unique voice is a brand asset. |
| B. ElevenLabs **library voice** | Paid tier (free tier for testing) | ★★ Others may use the same voice | Fine if you don't want your voice used. **Avoid the most-used defaults**; viewers recognise them as "AI slop." |
| C. Record yourself on your phone | $0 | ★★★ | Most authentic. Record inside a wardrobe or closet (clothes absorb echo). Takes ~10 extra min per video. |
| D. CapCut / TikTok built-in text-to-speech | $0 | ★ Instantly recognisable | Emergency only |

At scale, cheaper API voices (e.g. OpenAI's) cost roughly a tenth of ElevenLabs, but the quality gap is still audible for narration-led content. Start with ElevenLabs.

### Casting brief (paste into ElevenLabs "Voice Design" or use to choose a library voice)

> Warm, confident, conversational narrator in their late 20s–30s. Mid-to-low pitch, **American** accent, speaks like a friend sharing a secret they're a bit excited about. Pace ~170 words per minute. Clear consonants, slight smile in the voice, emphasises numbers and results. Not a radio announcer, not hype.

### ElevenLabs starting settings

These are starting points. The UI and model names change, so tune by ear.

| Setting | Start at | Why |
|---|---|---|
| Model | Newest expressive model (v3 at time of writing); fall back to Multilingual v2 if takes are inconsistent | v3 supports inline tags like `[excited]`, `[whispers]`, `[pause]` |
| Stability | ~45% | Lower = more emotion; below ~35% gets erratic |
| Similarity | ~75–80% | Keeps the voice consistent video to video |
| Style exaggeration | ~10–20% | A little flair; more gets theatrical |
| Speed | 1.05–1.10× | Short-form pace |
| Speaker boost | On | |

### Writing for text-to-speech (TTS)

- **Write numbers the way they're said:** `$14.99` → "fourteen ninety-nine"; `2x` → "twice as fast".
- **Spell out tricky names:** "NotebookLM" → "Notebook L M"; "SaaS" → "sass".
- **Short sentences.** One idea per line. An em dash (—) or `[pause]` adds a beat before the payoff.
- **Generate the hook separately, 3–5 takes**, and keep the best one. The first two seconds decide the video.
- Generate the body in 2–3 chunks rather than one long take. Regenerating a chunk is cheaper than regenerating everything.
- Export **WAV or 44.1 kHz MP3**.

### Audio mix (in CapCut)

| Layer | Level | Notes |
|---|---|---|
| Voiceover | Loudest: normalise, apply "Enhance voice" | Keep it dry, no reverb |
| Music | ~10–15% volume (well under the voice) | Lo-fi / minimal tech beat from **TikTok's or CapCut's licensed library** only |
| Sound effects | Subtle | "Whoosh" on zooms, "click" on clicks, a soft "ding" on the result |

### AI label (important)

When the voiceover is synthetic, including a clone of your own voice, turn on **"AI-generated content"** in *More options* before posting. TikTok's 2026 policy covers voice clones, and C2PA metadata can flag them anyway. Labelling doesn't block monetization; hiding it risks strikes.

---

## Part B — Video production

### Tool stack

| Job | Free | Paid upgrade |
|---|---|---|
| Desktop screen recording | **OBS Studio** (record at 1440p or higher so zooms stay sharp) | Screen Studio (Mac; automatic zooms + smooth cursor) |
| Phone screen recording | Built-in iOS / Android screen recorder (already 9:16) | — |
| Editing + auto-captions | **CapCut desktop** | CapCut Pro |
| Alternative editor | DaVinci Resolve | — |
| Covers | Ready-made for #001–#014 in [`brand/covers/`](brand/covers/). For new ones, open [`brand/cover-maker.html`](brand/cover-maker.html) in any browser, type the hook, and download the PNG. | — |
| Stock b-roll (rarely needed) | Pexels, Pixabay | Storyblocks |

### Build the master template once (≈45 min), then duplicate it for every video

- **Canvas:** 9:16, 1080×1920, 30 fps (60 fps if there's a lot of scrolling).
- **Background:** Ink `#0B0B0F`.
- **Screen recording:** fills the width, sits slightly above centre. Add rounded corners and a subtle shadow.
- **Series tag:** lime pill, top-left, "SHORTCUT #0XX", visible the whole video.
- **Hook box:** lime background, ink Montserrat Black, top third, first ~2s only.
- **Captions:** CapCut auto-captions, white bold, 2–4 words per line, keywords recoloured lime, in the lower third.
- **Safe zones.** Drop [`brand/safe-zones-overlay.png`](brand/safe-zones-overlay.png) on the top track while editing (delete it before export). TikTok's buttons and caption cover parts of the screen, so keep all text out of:
  - top ~150 px
  - bottom ~400 px
  - right ~140 px

```
┌──────────────────────┐
│   (top 150px clear)  │
│ [SHORTCUT #007]      │
│ ┌──────────────────┐ │
│ │  HOOK TEXT BOX   │ │ ← first 2s only
│ └──────────────────┘ │
│ ┌──────────────────┐ │
│ │                  │ │
│ │ SCREEN RECORDING │ │
│ │  (zoomed 150%+)  │ │
│ │                  │ │
│ └──────────────────┘ │
│   caption words      │ ← lower third
│                  ░░░ │ ← right 140px clear
│ (bottom 400px clear) │
└──────────────────────┘
```

### Per-video workflow (~40 min once practiced)

1. **Script** (5 min): pull from [`scripts/`](scripts/) and run `python3 faceless-tiktok/tools/script_length.py`.
2. **Voiceover** (5 min): generate in ElevenLabs, hook first (3–5 takes).
3. **Record the demo** (10 min): follow the shot list. Do the demo for real. If the tool behaves differently than the script says, **change the script to match the screen**.
4. **Edit** (15–20 min): duplicate the template → drop in the voiceover → cut the demo to match it → zoom on every click → auto-captions and recolour keywords → sound effects and music → blur personal info → remove silences.
5. **Cover + export** (3 min): cover frame from the template; export 1080×1920, H.264, "Higher" bitrate, **no watermark**.
6. **Upload** (5 min): caption, 3–5 hashtags, cover, **AI label on**, **content disclosure on** if the video contains an affiliate link or sponsor, then schedule.

### Quality checklist before every upload

- [ ] Hook text and first spoken line match, and both show up in under 1.5s
- [ ] The main keyword is said aloud in the first 8 seconds
- [ ] Runs longer than 60s, and nothing is padding
- [ ] Visual changes at least every 3 seconds
- [ ] Every click is zoomed; every word is captioned
- [ ] No personal info visible (email, bank numbers, names)
- [ ] Nothing important sits under the TikTok UI (check the safe zones)
- [ ] The CTA teases the next video
- [ ] AI label toggled; affiliate disclosure included if needed
