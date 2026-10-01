"""Downloads settled markets, their one-minute candles, and BTC prices to disk."""
from __future__ import annotations

import json
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Callable

from .coinbase import fetch_minute_closes
from .dataset import BTC_FILE, CANDLES_DIR, MARKETS_FILE
from .http import HttpError
from .kalshi import DEFAULT_SERIES, KalshiPublic
from .timeutil import iso, to_unix

VOL_WARMUP_SECONDS = 3 * 3600


def _write_json(path: Path, payload) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload))
    tmp.replace(path)


def fetch(data_dir: str | Path, series: str = DEFAULT_SERIES, days: float = 30, end_ts: int | None = None,
          workers: int = 4, client: KalshiPublic | None = None,
          log: Callable[[str], None] = print) -> None:
    data_dir = Path(data_dir)
    candles_dir = data_dir / CANDLES_DIR
    candles_dir.mkdir(parents=True, exist_ok=True)
    client = client or KalshiPublic()
    end_ts = end_ts or int(time.time())
    start_ts = int(end_ts - days * 86400)

    cutoff = client.historical_cutoff_ts()
    segments = []
    if cutoff and start_ts < cutoff:
        segments.append((start_ts, min(cutoff, end_ts), True))
    if not cutoff or end_ts > cutoff:
        segments.append((max(start_ts, cutoff or start_ts), end_ts, False))

    markets: dict[str, dict] = {}
    for lo, hi, historical in segments:
        log(f"Listing settled {series} markets {iso(lo)} → {iso(hi)}"
            f"{' (historical archive)' if historical else ''}...")
        for market in client.settled_markets(series, lo, hi, historical=historical):
            markets[market["ticker"]] = market
    if not markets:
        raise SystemExit(f"No settled {series} markets found in that range. Check the series ticker.")
    log(f"Found {len(markets)} settled markets.")
    _write_json(data_dir / MARKETS_FILE, {
        "series": series,
        "meta": {"source": "kalshi", "start_ts": start_ts, "end_ts": end_ts, "fetched_at": int(time.time())},
        "markets": sorted(markets.values(), key=lambda m: m.get("close_time", "")),
    })

    todo = [m for m in markets.values() if not (candles_dir / f"{m['ticker']}.json").exists()]
    log(f"Downloading one-minute candles for {len(todo)} markets ({len(markets) - len(todo)} cached)...")

    def download(market: dict) -> None:
        ticker = market["ticker"]
        open_ts, close_ts = to_unix(market["open_time"]), to_unix(market["close_time"])
        historical = cutoff is not None and close_ts < cutoff
        try:
            candles = client.candlesticks(series, ticker, open_ts - 300, close_ts, historical=historical)
        except HttpError as e:
            if e.status not in (400, 404):
                raise
            candles = client.candlesticks(series, ticker, open_ts - 300, close_ts, historical=not historical)
        _write_json(candles_dir / f"{ticker}.json", candles)

    failures = []
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(download, m): m["ticker"] for m in todo}
        for done, future in enumerate(as_completed(futures), 1):
            try:
                future.result()
            except Exception as e:  # keep going; report at the end
                failures.append((futures[future], e))
            if done % 200 == 0 or done == len(todo):
                log(f"  {done}/{len(todo)} markets")
    if failures:
        log(f"{len(failures)} markets failed to download (re-run fetch to retry). First error: "
            f"{failures[0][0]}: {failures[0][1]}")

    log("Downloading BTC-USD one-minute prices from Coinbase...")
    closes = fetch_minute_closes(start_ts - VOL_WARMUP_SECONDS, end_ts + 900, log=log)
    _write_json(data_dir / BTC_FILE, {
        "product": "BTC-USD", "source": "coinbase",
        "closes": {str(ts): px for ts, px in sorted(closes.items())},
    })
    log(f"Saved {len(closes)} BTC candles. Done: {data_dir}")
