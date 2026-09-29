# 01 — Niche Research & ROI Ranking

_Research date: 29 Sep 2026. TikTok publishes no official RPM table. The payout figures below come from creators' own reports collected by third-party sites (sources at the bottom) and they change month to month with ad spend._

## How TikTok pays a faceless account in 2026

| Revenue stream | What unlocks it | What it means for niche choice |
|---|---|---|
| **Creator Rewards** | 10K followers, 100K views in the last 30 days, 18+, **personal** account, eligible country, original content | Only **videos over 1 minute** earn anything. Payouts run ~$0.40–1.20 per 1K qualified views, and US/UK/AU views pay more. Changes in early 2026 penalize reused and low-retention content. |
| **Affiliate links** (bio link) | Bio link unlocks at a follower minimum | Pays per signup or sale. Software (SaaS) affiliate programs often pay a **recurring** monthly cut. |
| **TikTok Shop affiliate** | Follower minimum + Shop approval | Average US commission ~13%. Beauty pays 15–30%. Products must be physically shown. |
| **Own digital products** | Anytime | Templates and prompt packs are close to 100% margin. |
| **Sponsorships** | ~10K+ engaged followers | AI tool companies sponsor small, focused accounts. |

Takeaway: **the biggest money is off-platform.** Creators who mix several income streams reportedly earn 3–5× more than those who rely on platform payouts alone. So the niche has to (a) pay a decent RPM on videos over 60 seconds, **and** (b) have products the audience wants to buy.

## Scoring method

Each niche is scored 1–10 on seven criteria. 10 is always "good for us," so competition and risk are inverted. The data and weights live in [`niche-scoring/niches.csv`](niche-scoring/niches.csv). To change the weights and re-rank, run:

```bash
python3 faceless-tiktok/niche-scoring/score.py
```

| Criterion | Weight | Why |
|---|---|---|
| Creator Rewards RPM | 20% | Direct payout per view |
| Off-platform money | 25% | Affiliates, products, sponsors — the bigger lever |
| Production ease | 15% | Faceless videos have to be batchable by one person |
| Audience demand | 15% | Search + For You page appetite right now |
| Competition (inverted) | 10% | Easier to break in |
| Policy / brand risk (inverted) | 10% | Demonetization, advice rules, advertiser avoidance |
| Idea supply | 5% | Can you make 300 of these? |

## Results

| # | Niche | Score | RPM (reported) | Note |
|---|---|---|---|---|
| **1** | **AI tools & tech shortcuts** | **8.20** | ~$0.70–1.20 | Screen recordings are **original footage by default**. That matters because 2026 enforcement targets unoriginal and AI-generated "slop." |
| 2 | Personal finance explainers | 7.75 | ~$0.80–1.50 | Highest RPM, but affiliates are gated and there's regulatory risk (roughly 70% of finfluencer investing content was found non-compliant in 2025) |
| 3 | Business case studies | 7.35 | finance-adjacent | Less crowded; every video needs research |
| 4 | Psychology & self-improvement | 6.65 | ~$0.40–0.80 | Crowded with recycled quote content |
| 5 | Health & fitness (faceless) | 6.35 | high | Health-claim rules; very crowded |
| 6 | TikTok Shop product demos | 6.00 | ~n/a | Great commissions, but needs product samples and hands-on filming |
| 7 | History & untold stories | 5.70 | ~$0.30–0.60 | Excellent watch time, weak monetization |
| 8 | Motivation & quotes | 5.30 | ~$0.40–0.80 | Saturated; gets flagged as unoriginal |
| 9 | True crime | 5.05 | low–mid | Advertisers avoid it |
| 10 | Horror stories | 4.85 | low | Fun for growth, little to sell |
| 11 | Gameplay split-screen | 4.00 | low | The exact format that 2026 reuse rules go after |

## The pick: "AI tools that save you time _and money_"

AI tools/tech wins outright. We then **borrow the #2 niche's money angle** by making one content pillar "AI Money Moves": using AI to cut bills, find forgotten subscriptions and claim refunds. The combined niche gets:

1. **Tech RPM plus finance-intent viewers.** Money-saving viewers are the audience advertisers pay a premium for, without the investing-advice risk.
2. **Recurring affiliate income.** AI software affiliate programs commonly pay $5–50 per signup, and many pay monthly for as long as the customer stays.
3. **Built-in originality.** Every video is a screen recording of *you* using a tool, so it doesn't depend on stock clips or AI-generated footage that the 2026 rules penalize.
4. **Endless, timely supply.** New tools and features ship every week, and each one is a new video people are already searching for.
5. **Search traffic.** How-to videos dominate TikTok search in 2026, and "how to ___ with AI" is exactly that.

**Runner-up to test later:** a second account on business case studies ("How [company] actually makes money"). It's finance-adjacent on RPM, less crowded, and reuses the same voice and editing pipeline.

## Risks & how we handle them

| Risk | Mitigation |
|---|---|
| Crowded "make money with AI" genre (get-rich-quick hype) | We never promise income. The promise is *save time and money*: practical, verifiable, shown on screen. |
| Tools change fast, so scripts go stale | Every script is tool-agnostic where possible. Record the demo live and adjust the voiceover to what you actually see. |
| AI-content labelling | Turn on TikTok's AI-generated content label whenever the voiceover is synthetic (see 04). |
| Money content looks like financial advice | Consumer savings only. No stocks, crypto or "invest in X." Use a standard disclaimer (see 06). |

## Sources

- [Virlo — 35 Best Faceless TikTok Niches (2026)](https://virlo.ai/blog/best-faceless-tiktok-niches)
- [Kineclip — 12 Best TikTok Niches for 2026, Ranked by Profit](https://kineclip.com/blog/best-niches-tiktok-2026/)
- [Elev8or — TikTok Creator Rewards RPM 2026: Rates by Market and Niche](https://www.elev8or.io/blog/tiktok-creator-rewards-rpm-2026)
- [Fluxnote — Best TikTok Niches US 2026](https://fluxnote.io/best/best-tiktok-niches-us-creators-2026)
- [Flowshorts — Best Faceless TikTok Niches (2026 Data)](https://flowshorts.app/blog/best-faceless-tiktok-niches)
- [OpenClip — Best Faceless TikTok Niches 2026, Ranked](https://openclip.app/guides/best-faceless-tiktok-niches)
- [Benly — TikTok Creator Rewards Program 2026](https://benly.ai/learn/tiktok-ads/creator-rewards-program-2026)
- [Creators Agency — Creator Rewards: Requirements, RPM, Disqualifications](https://creatorsagency.co/blog/tiktok-creator-rewards-program-2026)
- [Quasa — Creator Rewards 2026: Requirements and RPM Decline](https://quasa.io/media/tiktok-creator-rewards-program-2026-strict-requirements-and-falling-rpm-explained)
- [ShortFormNation — TikTok Shop Affiliate Marketing 2026](https://www.shortformnation.com/blog/tiktok-shop-affiliate-marketing-the-complete-2026-guide)
- [HamsterGarage — TikTok Shop Affiliate Statistics 2026](https://www.hamstergarage.com/article/tiktok-shop-affiliate-statistics-benchmarks-roi)
- [Fluxnote — Can You Monetize AI Videos on TikTok? (2026)](https://fluxnote.io/guides/monetize-ai-videos-tiktok)
- [Sedric — Finfluencer Compliance Guide 2026](https://www.sedric.ai/blog/influencer-compliance)
