"""Live view of the current 15-minute window: Kalshi quotes plus BTC price,
volatility and the Coinbase-to-index gap, computed the same way as the backtest.
"""
from __future__ import annotations

import statistics
import threading
import time
from dataclasses import dataclass, field

from .coinbase import fetch_minute_closes
from .dataset import BtcSeries, Market, Quote, WINDOW_SECONDS, parse_price
from .http import RateLimiter, get_json
from .kalshi import KalshiPublic
from .model import prob_up
from .timeutil import to_unix

COINBASE_TICKER_URL = "https://api.exchange.coinbase.com/products/BTC-USD/ticker"
BASIS_WINDOWS = 8
CANDLE_REFRESH_SECONDS = 30
HISTORY_POINT_SECONDS = 5


def market_from_raw(raw: dict) -> Market:
    close_ts = to_unix(raw["close_time"])
    open_ts = max(to_unix(raw["open_time"]), close_ts - WINDOW_SECONDS)
    strike = raw.get("floor_strike")
    return Market(
        ticker=raw["ticker"],
        open_ts=open_ts,
        close_ts=close_ts,
        strike=float(strike) if strike not in (None, "") else None,
        result=raw.get("result") or "",
        yes_is_up=not str(raw.get("strike_type") or "").startswith("less"),
        expiration_value=None,
    )


def quote_from_raw(raw: dict, ts: int) -> tuple[Quote, float, float]:
    """Top of book from a market object, plus the size resting at each side."""
    bid = parse_price({"close_dollars": raw.get("yes_bid_dollars")})
    ask = parse_price({"close_dollars": raw.get("yes_ask_dollars")})
    bid = bid if bid and bid > 0 else None
    ask = ask if ask and ask < 1 else None
    bid_size = float(raw.get("yes_bid_size_fp") or 0)
    ask_size = float(raw.get("yes_ask_size_fp") or 0)
    return Quote(ts, bid, ask), bid_size, ask_size


@dataclass
class Snapshot:
    """Everything the desk knows at one moment. Immutable once published."""
    ts: float
    market: Market | None = None
    quote: Quote | None = None
    bid_size: float = 0.0
    ask_size: float = 0.0
    spot: float | None = None            # Coinbase, shifted onto the settlement index
    raw_spot: float | None = None
    basis: float = 0.0
    sigma: float | None = None
    p_yes: float | None = None
    history: list[tuple[int, float]] = field(default_factory=list)   # (ts, spot) this window
    error: str | None = None

    @property
    def minute(self) -> int | None:
        return None if self.market is None else int((self.ts - self.market.open_ts) // 60)

    @property
    def seconds_left(self) -> float | None:
        return None if self.market is None else max(self.market.close_ts - self.ts, 0.0)


class LiveFeed:
    def __init__(self, client: KalshiPublic, series: str):
        self.client = client
        self.series = series
        self.coinbase_limiter = RateLimiter(4.0)
        self._lock = threading.Lock()
        self._snapshot = Snapshot(ts=time.time())
        self._raw_market: dict | None = None
        self._btc: BtcSeries | None = None
        self._candles_at = 0.0
        self._strikes: dict[str, tuple[int, float]] = {}   # ticker -> (open_ts, strike)
        self._history: list[tuple[int, float]] = []

    def snapshot(self) -> Snapshot:
        with self._lock:
            return self._snapshot

    def refresh(self) -> Snapshot:
        now = time.time()
        error = None
        try:
            self._refresh_market(now)
        except Exception as e:  # keep the last good data and report the problem
            error = f"Kalshi: {e}"
        try:
            raw_spot = float(get_json(COINBASE_TICKER_URL, limiter=self.coinbase_limiter, retries=1)["price"])
            if now - self._candles_at > CANDLE_REFRESH_SECONDS:
                closes = fetch_minute_closes(int(now) - 200 * 60, int(now) + 60, limiter=self.coinbase_limiter)
                self._btc = BtcSeries(closes)
                self._candles_at = now
        except Exception as e:
            error = error or f"Coinbase: {e}"
            raw_spot = self._snapshot.raw_spot

        snap = self._build(now, raw_spot, error)
        with self._lock:
            self._snapshot = snap
        return snap

    def _refresh_market(self, now: float) -> None:
        current = self._raw_market
        if current is None or now >= to_unix(current["close_time"]):
            live = [m for m in self.client.open_markets(self.series)
                    if to_unix(m["open_time"]) <= now < to_unix(m["close_time"])]
            if not live:
                self._raw_market = None
                return
            self._raw_market = min(live, key=lambda m: to_unix(m["close_time"]))
            self._history = []
            for raw in self.client.recent_settled(self.series, BASIS_WINDOWS):
                self._remember_strike(raw)
        else:
            self._raw_market = self.client.market(current["ticker"])
        self._remember_strike(self._raw_market)

    def _remember_strike(self, raw: dict) -> None:
        if raw.get("floor_strike") not in (None, ""):
            market = market_from_raw(raw)
            self._strikes[market.ticker] = (market.open_ts, market.strike)

    def _basis(self) -> float:
        """Median of strike minus Coinbase over the minute before each recent open."""
        if self._btc is None:
            return 0.0
        gaps = []
        for open_ts, strike in sorted(self._strikes.values())[-BASIS_WINDOWS:]:
            before, at_open = self._btc.closes.get(open_ts - 120), self._btc.closes.get(open_ts - 60)
            if before and at_open:
                gaps.append(strike - (before + at_open) / 2)
        return statistics.median(gaps) if gaps else 0.0

    def _build(self, now: float, raw_spot: float | None, error: str | None) -> Snapshot:
        raw = self._raw_market
        if raw is None:
            return Snapshot(ts=now, raw_spot=raw_spot, error=error or "Waiting for the next window to open")
        market = market_from_raw(raw)
        quote, bid_size, ask_size = quote_from_raw(raw, int(now))
        basis = self._basis()
        spot = raw_spot + basis if raw_spot is not None else None
        sigma = self._btc.realized_vol(int(now) - int(now) % 60) if self._btc else None
        p_yes = None
        if spot and sigma and market.strike:
            p_up = prob_up(spot, market.strike, sigma, (market.close_ts - now) / 60.0)
            p_yes = p_up if market.yes_is_up else 1.0 - p_up
        if spot is not None and (not self._history or now - self._history[-1][0] >= HISTORY_POINT_SECONDS):
            self._history.append((int(now), round(spot, 2)))
        return Snapshot(now, market, quote, bid_size, ask_size, spot, raw_spot, basis, sigma, p_yes,
                        self._backfill(market, basis) + self._history, error)

    def _backfill(self, market: Market, basis: float) -> list[tuple[int, float]]:
        """Minute closes from the window's start up to the first live sample,
        so a desk started mid-window still draws the whole window."""
        if self._btc is None:
            return []
        first_live = self._history[0][0] if self._history else int(time.time())
        return [(bucket + 60, round(px + basis, 2)) for bucket, px in sorted(self._btc.closes.items())
                if market.open_ts <= bucket + 60 < first_live - 30]
