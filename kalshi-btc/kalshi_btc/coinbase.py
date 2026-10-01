"""BTC-USD one-minute candles from Coinbase's public market-data API.

Kalshi settles on the CF Benchmarks Real-Time Index, which isn't freely
downloadable; Coinbase is one of its constituent exchanges and tracks it
closely enough to use as the spot price at decision time.
"""
from __future__ import annotations

from typing import Callable

from .http import RateLimiter, get_json
from .timeutil import iso

CANDLES_URL = "https://api.exchange.coinbase.com/products/{product}/candles"
MAX_CANDLES_PER_REQUEST = 300


def fetch_minute_closes(start_ts: int, end_ts: int, product: str = "BTC-USD",
                        limiter: RateLimiter | None = None,
                        log: Callable[[str], None] = lambda _: None) -> dict[int, float]:
    """Return {bucket_start_ts: close} for every minute in [start_ts, end_ts)."""
    limiter = limiter or RateLimiter(5.0)
    url = CANDLES_URL.format(product=product)
    span = MAX_CANDLES_PER_REQUEST * 60
    closes: dict[int, float] = {}
    t = start_ts - start_ts % 60
    requests = 0
    while t < end_ts:
        chunk_end = min(t + span, end_ts)
        # `end` is inclusive on Coinbase, so stop one bucket short of the next chunk.
        rows = get_json(url, {"granularity": 60, "start": iso(t), "end": iso(chunk_end - 60)}, limiter)
        for row in rows:
            ts, close = int(row[0]), float(row[4])
            if t <= ts < chunk_end:
                closes[ts] = close
        t = chunk_end
        requests += 1
        if requests % 50 == 0:
            log(f"  coinbase: {requests} requests, {len(closes)} candles so far")
    return closes
