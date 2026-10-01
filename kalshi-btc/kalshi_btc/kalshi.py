"""Read-only client for Kalshi's public market-data endpoints (no API key needed)."""
from __future__ import annotations

import os
from typing import Iterator

from .http import HttpError, RateLimiter, get_json
from .timeutil import to_unix

DEFAULT_BASE_URL = os.environ.get("KALSHI_BASE_URL", "https://api.elections.kalshi.com/trade-api/v2")
DEFAULT_SERIES = "KXBTC15M"


class KalshiPublic:
    def __init__(self, base_url: str = DEFAULT_BASE_URL, per_second: float = 8.0):
        self.base = base_url.rstrip("/")
        self.limiter = RateLimiter(per_second)

    def _get(self, path: str, params: dict | None = None):
        return get_json(self.base + path, params, self.limiter)

    def historical_cutoff_ts(self) -> int | None:
        """Markets settled before this time are only served by the /historical endpoints."""
        try:
            data = self._get("/historical/cutoff")
        except HttpError as e:
            if e.status == 404:
                return None
            raise
        value = data.get("market_settled_ts")
        return to_unix(value) if value is not None else None

    def settled_markets(self, series: str, min_close_ts: int, max_close_ts: int,
                        historical: bool = False) -> Iterator[dict]:
        """Yield settled markets in `series` closing within [min_close_ts, max_close_ts].

        The API restricts which timestamp filters combine with which status
        filter, so try progressively looser queries and always filter here too.
        """
        path = "/historical/markets" if historical else "/markets"
        window_close = {"min_close_ts": min_close_ts, "max_close_ts": max_close_ts}
        window_settled = {"min_settled_ts": min_close_ts, "max_settled_ts": max_close_ts + 3600}
        attempts = [
            {"status": "settled", **window_close},
            {"status": "settled", **window_settled},
            window_close,
            {},
        ]
        if historical:
            attempts = [window_close, {}]
        last_error: HttpError | None = None
        for extra in attempts:
            try:
                for market in self._paginate(path, {"series_ticker": series, "limit": 1000, **extra}):
                    close_ts = to_unix(market.get("close_time"))
                    if close_ts is None or not (min_close_ts <= close_ts <= max_close_ts):
                        continue
                    if market.get("result") not in ("yes", "no"):
                        continue
                    yield market
                return
            except HttpError as e:
                if e.status != 400:
                    raise
                last_error = e
        assert last_error is not None
        raise last_error

    def _paginate(self, path: str, params: dict) -> Iterator[dict]:
        cursor = None
        while True:
            data = self._get(path, {**params, "cursor": cursor})
            yield from data.get("markets", [])
            cursor = data.get("cursor")
            if not cursor:
                return

    def candlesticks(self, series: str, ticker: str, start_ts: int, end_ts: int,
                     historical: bool = False) -> list[dict]:
        """One-minute candles (bid/ask/trade OHLC) for a single market."""
        if historical:
            path = f"/historical/markets/{ticker}/candlesticks"
        else:
            path = f"/series/{series}/markets/{ticker}/candlesticks"
        data = self._get(path, {"start_ts": start_ts, "end_ts": end_ts, "period_interval": 1})
        return data.get("candlesticks", [])
