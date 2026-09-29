#!/usr/bin/env python3
"""Rank TikTok niches by weighted ROI score.

Each niche in niches.csv is scored 1-10 on every criterion (10 = best for us,
so "competition" and "risk" are already inverted: 10 = low competition / low risk).
Edit the scores or the WEIGHTS below and re-run:

    python3 faceless-tiktok/niche-scoring/score.py
"""

import csv
import pathlib

# Weights must sum to 1.0. Money is weighted heaviest because the goal is ROI.
WEIGHTS = {
    "rpm": 0.20,          # Creator Rewards payout per 1K qualified views
    "offplatform": 0.25,  # affiliates, digital products, sponsors
    "production": 0.15,   # how cheap/fast a faceless video is to make
    "demand": 0.15,       # search + FYP appetite right now
    "competition": 0.10,  # 10 = uncrowded
    "risk": 0.10,         # 10 = low policy / brand-safety / demonetization risk
    "supply": 0.05,       # how many ideas before you run dry
}


def main():
    assert abs(sum(WEIGHTS.values()) - 1.0) < 1e-9, "weights must sum to 1"
    path = pathlib.Path(__file__).with_name("niches.csv")
    with path.open(newline="") as f:
        rows = list(csv.DictReader(f))

    for row in rows:
        row["score"] = sum(float(row[k]) * w for k, w in WEIGHTS.items())
    rows.sort(key=lambda r: r["score"], reverse=True)

    width = max(len(r["niche"]) for r in rows)
    print(f"{'#':>2}  {'Niche':<{width}}  Score")
    for i, row in enumerate(rows, 1):
        print(f"{i:>2}  {row['niche']:<{width}}  {row['score']:.2f}")


if __name__ == "__main__":
    main()
