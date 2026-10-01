"""Writes a fake dataset in the same on-disk format as `fetch`, for testing.

BTC follows a random walk; like Kalshi, each window's strike and settlement
are 60-second averages. Each 15-minute market quotes the random-walk fair
probability (computed with `vol_mult` times the true volatility, so a value
other than 1 makes the market systematically wrong) plus noise, with a fixed
bid/ask spread around it.
"""
from __future__ import annotations

import json
import math
import random
from pathlib import Path

from .dataset import BTC_FILE, CANDLES_DIR, MARKETS_FILE
from .model import prob_up
from .timeutil import iso

WINDOW = 900
DEFAULT_START = 1788220800  # 2026-09-01T00:00:00Z


def generate(data_dir: str | Path, days: float = 14, seed: int = 7, sigma: float = 0.0007,
             spread: float = 0.02, quote_noise: float = 0.01, vol_mult: float = 1.0,
             start_ts: int = DEFAULT_START, series: str = "KXBTC15M") -> Path:
    rng = random.Random(seed)
    data_dir = Path(data_dir)
    candles_dir = data_dir / CANDLES_DIR
    candles_dir.mkdir(parents=True, exist_ok=True)
    end_ts = int(start_ts + days * 86400)

    # Simulate per second so strike and settlement can be 60-second averages,
    # as on Kalshi; minute candles are just every 60th print.
    first = start_ts - 3 * 3600
    sigma_per_second = sigma / math.sqrt(60)
    seconds = []
    price = 60000.0
    for _ in range(end_ts + WINDOW - first):
        price *= math.exp(rng.gauss(0.0, sigma_per_second))
        seconds.append(price)
    closes = {bucket: round(seconds[bucket + 59 - first], 2)
              for bucket in range(first, end_ts + WINDOW, 60)}

    def price_at(ts: int) -> float:
        return closes[ts - 60]

    def minute_average_before(ts: int) -> float:
        return round(sum(seconds[ts - 60 - first:ts - first]) / 60, 2)

    markets = []
    for open_ts in range(start_ts, end_ts - WINDOW + 1, WINDOW):
        close_ts = open_ts + WINDOW
        strike, settle = minute_average_before(open_ts), minute_average_before(close_ts)
        ticker = f"{series}-SYN{open_ts}"
        markets.append({
            "ticker": ticker,
            "open_time": iso(open_ts),
            "close_time": iso(close_ts),
            "floor_strike": strike,
            "strike_type": "greater_or_equal",
            "result": "yes" if settle >= strike else "no",
            "expiration_value": f"{settle:.2f}",
        })
        candles = []
        for ts in range(open_ts + 60, close_ts, 60):
            fair = prob_up(price_at(ts), strike, sigma * vol_mult, (close_ts - ts) / 60)
            mid = min(max(fair + rng.gauss(0.0, quote_noise), 0.02), 0.98)
            bid = max(round(mid - spread / 2, 2), 0.01)
            ask = min(round(mid + spread / 2, 2), 0.99)
            candles.append({
                "end_period_ts": ts,
                "yes_bid": {"close_dollars": f"{bid:.4f}"},
                "yes_ask": {"close_dollars": f"{ask:.4f}"},
            })
        (candles_dir / f"{ticker}.json").write_text(json.dumps(candles))

    (data_dir / MARKETS_FILE).write_text(json.dumps({
        "series": series,
        "meta": {"synthetic": True, "seed": seed, "sigma": sigma, "spread": spread,
                 "quote_noise": quote_noise, "vol_mult": vol_mult},
        "markets": markets,
    }))
    (data_dir / BTC_FILE).write_text(json.dumps({
        "product": "BTC-USD", "source": "synthetic",
        "closes": {str(ts): px for ts, px in closes.items()},
    }))
    return data_dir
