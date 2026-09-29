# 03 — Content Playbook

## Five content pillars

| Pillar | Share | What it is | Why it's in the mix |
|---|---|---|---|
| 💸 **AI Money Moves** | 30% | Use AI to cut bills, find forgotten subscriptions, claim refunds, budget | Finance-intent viewers are the ones advertisers pay most for. Most saved and shared. |
| 🧰 **Tool Drop** | 25% | One tool, one job, shown working on screen | Drives affiliate income and sponsor interest |
| ⚙️ **Workflow Rebuild** | 20% | Before/after: "this took me 2 hours, now it takes 4 minutes" | Visible transformation, high completion rate |
| ✍️ **Prompt Fix** | 15% | "You're using ChatGPT wrong": bad prompt vs. fixed prompt | Cheapest to make; comments pour in ("send the prompt") |
| 📱 **Hidden Features** | 10% | AI features already on your phone or laptop | Broadest reach; pulls in non-techy viewers |

After 2 weeks, check which pillar's **median** views are highest and shift 10% of the mix toward it every week (see 05 → Decision rules).

---

## The video formula (65–75 seconds)

Videos **must run over 60 seconds** to earn Creator Rewards, so every "anchor" video is built to hold attention for about 70 seconds. Short "reach" cut-downs (25–40s) come in Week 3 to grow followers (see 05).

| Time | Beat | What's on screen | Rule |
|---|---|---|---|
| 0.0–1.5s | **HOOK** | The *result* first (the refund email, the finished spreadsheet), plus hook text in the lime box | The first spoken line and the on-screen text say the same thing. Never open with "Hey guys" or a logo. |
| 1.5–8s | **STAKES** | Relatable problem: the messy inbox, the bank statement | Say the main keyword out loud ("ChatGPT", "cancel subscriptions"). TikTok transcribes speech for search. |
| 8–55s | **DEMO: 3 steps** | Screen recording with zoom-ins; lime box on every click | Change the visual **every 2–3 seconds** (zoom, cut, highlight, text pop). Number the steps on screen. |
| 55–65s | **PAYOFF + BONUS** | Final result + one extra tip | The bonus rewards people who stayed and keeps completion high |
| 65–72s | **CTA / OPEN LOOP** | Series tag "SHORTCUT #0XX" + tease the next one | "Follow — tomorrow I'll show you ___." One CTA only. |

### Retention rules (non-negotiable)

1. **Captions on every word**: bold, white, centred in the lower third, one keyword per line highlighted in lime.
2. **No dead air.** Cut every pause over 0.3s. CapCut's "Remove silences" does this.
3. **Zoom in on screen recordings.** Nobody can read a full desktop on a phone. Every click gets a 150–200% zoom.
4. **Blur personal info**: emails, account numbers, names. Use CapCut's Mosaic effect.
5. **Show, don't claim.** If the voiceover says "it found 7 subscriptions," the screen shows the 7.
6. **Use real numbers from your own demo.** Never invent statistics.

---

## Hook bank

Swap in the specifics. Hooks that name a **specific outcome + specific tool** beat vague curiosity.

**Money**
1. "Your bank app will never show you this."
2. "I found $___ a month I didn't know I was spending — in 40 seconds."
3. "Call your internet provider and read *this* script."
4. "Airlines hope you don't know this one rule."
5. "Before you sign any lease, paste it here first."

**Tool Drop**
6. "This free tool replaced a $___/month app for me."
7. "Stop paying for ___. This does it free."
8. "Google quietly built this, and nobody's using it."
9. "This AI turns any PDF into a podcast."
10. "The most underrated AI tool of 2026 isn't ChatGPT."

**Workflow**
11. "This used to take me 2 hours. Watch."
12. "I haven't manually written ___ in 3 months."
13. "Your 2-hour lecture, as notes, in 30 seconds."
14. "Do this every Monday and your week runs itself."

**Prompt Fix**
15. "You're using ChatGPT wrong. Here's the fix."
16. "Add these 6 words to any prompt."
17. "If AI keeps sounding like AI, do this."
18. "The prompt I use more than any other."

**Hidden Features**
19. "Your phone can do this and you've never tried it."
20. "Stop typing that. Your camera can do it."

**Pattern interrupts** (text on screen for the first 0.5s): `WAIT.` · `❌ vs ✅` · `$0` · `STOP 👇` · `Shortcut #0XX`

---

## Captions, hashtags & search

**Caption template.** TikTok shows ~50 characters before "more", so put the keyword first:
```
How to [KEYWORD PHRASE] with AI in 60 seconds ⏱️
Step 1 … Step 2 … Step 3 …  (short recap people can save)
💬 Comment "[WORD]" and I'll send the prompt
#[broad] #[mid] #[mid] #[niche] #[niche]
```

**Hashtags: 3–5, a mix of sizes**
- Broad (pick 1): `#aitools` `#ai` `#techtok`
- Mid (pick 1–2): `#chatgpttips` `#moneyhacks` `#productivityhacks` `#savemoney` `#studytips`
- Niche (pick 1–2): `#aishortcut` (own it) `#chatgpthack` `#budgetingtips` `#notebooklm` `#subscriptions`

**Search keywords to aim for** (check the TikTok search bar's autocomplete before writing):
`ai tools` · `chatgpt tips` · `chatgpt hacks` · `how to save money` · `cancel subscriptions` · `lower internet bill` · `study hacks ai` · `ai for work` · `budget spreadsheet` · `notebooklm`

---

## Engagement system

- **Pin a comment** within 60s of posting: the full prompt, or "Comment PROMPT for the exact text."
- **Reply to the best 3 questions with video replies.** Each reply is a free extra video and TikTok shows it to the original commenter's followers.
- **Remix winners.** Any video that hits **2× your median views** gets 3 follow-ups: a new hook on the same demo, a "Part 2", and a 25-second reach cut.
- **Series binge.** Say "Shortcut #014" out loud and on screen. Once you have 15+ videos, add a "Start here" playlist on the profile.

---

## Script format

Scripts live in [`scripts/`](scripts/). Every script uses this layout, which the length checker (`tools/script_length.py`) parses:

```markdown
## 001 · Title
**Pillar:** … · **Hook text:** "…" · **Keywords:** …

### Voiceover
> Line one…
> Line two…

### Shots
1. **0–2s** …

### Post
**Caption:** …
**Pinned comment:** …
```

Run `python3 faceless-tiktok/tools/script_length.py` to check each voiceover lands at **62–80 seconds** (the Creator Rewards minimum plus a safety margin).
