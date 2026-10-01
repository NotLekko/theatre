"""Loads the on-disk cache written by `fetch` (or `synth`) into plain objects.

Raw API responses are cached untouched and normalized here, so a parsing fix
never requires re-downloading.
"""
from __future__ import annotations

import bisect
import json
import math
from dataclasses import dataclass, field
from pathlib import Path

from .timeutil import to_unix

MARKETS_FILE = "markets.json"
CANDLES_DIR = "candles"
BTC_FILE = "btc_1m.json"
# KXBTC15M asks about the 15 minutes before close, even if the market was
# listed (open_time) earlier than that.
WINDOW_SECONDS = 900


def parse_price(block: dict | None, key: str = "close") -> float | None:
    """Read a price in dollars from a candle OHLC block.

    Live candles carry `close_dollars: "0.5600"`; older/historical ones carry
    `close: 56` in cents.
    """
    if not block:
        return None
    value = block.get(f"{key}_dollars")
    if value not in (None, ""):
        return float(value)
    value = block.get(key)
    if value in (None, ""):
        return None
    if isinstance(value, int) or (isinstance(value, str) and "." not in value):
        return int(value) / 100.0
    value = float(value)
    return value / 100.0 if value > 1.0 else value


@dataclass(frozen=True)
class Quote:
    ts: int                 # end of the one-minute candle this snapshot closes
    yes_bid: float | None   # None when nobody is bidding
    yes_ask: float | None   # None when nobody is offering

    @property
    def no_ask(self) -> float | None:
        return None if self.yes_bid is None else round(1.0 - self.yes_bid, 4)

    @property
    def mid(self) -> float | None:
        if self.yes_bid is None or self.yes_ask is None:
            return None
        return (self.yes_bid + self.yes_ask) / 2


def parse_candle(candle: dict) -> Quote | None:
    ts = candle.get("end_period_ts")
    if ts is None:
        return None
    bid = parse_price(candle.get("yes_bid"))
    ask = parse_price(candle.get("yes_ask"))
    if bid is not None and bid <= 0:
        bid = None
    if ask is not None and ask >= 1:
        ask = None
    return Quote(int(ts), bid, ask)


@dataclass
class Market:
    ticker: str
    open_ts: int                  # start of the 15-minute window
    close_ts: int
    strike: float | None          # BRTI average the window opened at
    result: str                   # "yes" or "no"
    yes_is_up: bool
    expiration_value: float | None
    listed_early: bool = False    # open_time was before the window start
    quotes: list[Quote] = field(default_factory=list)
    _quote_ts: list[int] = field(default_factory=list, repr=False)

    def set_quotes(self, quotes: list[Quote]) -> None:
        self.quotes = sorted(quotes, key=lambda q: q.ts)
        self._quote_ts = [q.ts for q in self.quotes]

    def quote_at(self, ts: int, max_staleness: int = 180) -> Quote | None:
        """Latest book snapshot at or before `ts` (never after: no lookahead)."""
        i = bisect.bisect_right(self._quote_ts, ts) - 1
        if i < 0 or ts - self._quote_ts[i] > max_staleness:
            return None
        return self.quotes[i]

    @property
    def went_up(self) -> bool:
        return (self.result == "yes") == self.yes_is_up


def parse_market(raw: dict) -> Market | None:
    open_ts = to_unix(raw.get("open_time"))
    close_ts = to_unix(raw.get("close_time"))
    result = raw.get("result")
    if open_ts is None or close_ts is None or result not in ("yes", "no"):
        return None
    strike = raw.get("floor_strike")
    expiration = raw.get("expiration_value")
    try:
        expiration = float(expiration) if expiration not in (None, "") else None
    except ValueError:
        expiration = None
    strike_type = str(raw.get("strike_type") or "")
    window_start = max(open_ts, close_ts - WINDOW_SECONDS)
    return Market(
        ticker=raw["ticker"],
        open_ts=window_start,
        close_ts=close_ts,
        strike=float(strike) if strike not in (None, "") else None,
        result=result,
        yes_is_up=not strike_type.startswith("less"),
        expiration_value=expiration,
        listed_early=window_start > open_ts,
    )


class BtcSeries:
    """One-minute BTC closes keyed by bucket start; lookups never peek past `ts`."""

    def __init__(self, closes: dict[int, float]):
        self.closes = closes
        self._vol_cache: dict[tuple[int, int], float | None] = {}

    def price_at(self, ts: int, max_staleness: int = 180) -> float | None:
        # The bucket starting at ts-60 is the last one fully closed by ts.
        start = (ts - 60) - (ts - 60) % 60
        for bucket in range(start, start - max_staleness, -60):
            if bucket in self.closes:
                return self.closes[bucket]
        return None

    def realized_vol(self, ts: int, lookback_minutes: int = 60, min_returns: int = 20) -> float | None:
        """Std-dev of one-minute log returns over the window ending at `ts`."""
        key = (ts, lookback_minutes)
        if key not in self._vol_cache:
            last = (ts - 60) - (ts - 60) % 60
            returns = []
            for bucket in range(last - (lookback_minutes - 1) * 60, last + 1, 60):
                a, b = self.closes.get(bucket - 60), self.closes.get(bucket)
                if a and b:
                    returns.append(math.log(b / a))
            if len(returns) < min_returns:
                vol = None
            else:
                mean = sum(returns) / len(returns)
                vol = math.sqrt(sum((r - mean) ** 2 for r in returns) / (len(returns) - 1))
            self._vol_cache[key] = vol
        return self._vol_cache[key]


@dataclass
class Dataset:
    series: str
    markets: list[Market]
    btc: BtcSeries
    meta: dict


def load_dataset(data_dir: str | Path) -> Dataset:
    data_dir = Path(data_dir)
    payload = json.loads((data_dir / MARKETS_FILE).read_text())
    markets = []
    for raw in payload["markets"]:
        market = parse_market(raw)
        if market is None:
            continue
        candle_file = data_dir / CANDLES_DIR / f"{market.ticker}.json"
        if candle_file.exists():
            candles = json.loads(candle_file.read_text())
            market.set_quotes([q for q in map(parse_candle, candles) if q is not None])
        markets.append(market)
    markets.sort(key=lambda m: m.open_ts)
    btc_payload = json.loads((data_dir / BTC_FILE).read_text())
    closes = {int(ts): float(px) for ts, px in btc_payload["closes"].items()}
    return Dataset(payload.get("series", ""), markets, BtcSeries(closes), payload.get("meta", {}))
