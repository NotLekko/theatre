"""Minimal JSON-over-HTTPS client (stdlib only) with retries and rate limiting."""
from __future__ import annotations

import json
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

USER_AGENT = "kalshi-btc-backtest/0.1"
RETRYABLE_STATUS = (429, 500, 502, 503, 504)


class HttpError(Exception):
    def __init__(self, status: int, url: str, body: str):
        super().__init__(f"HTTP {status} for {url}: {body[:300]}")
        self.status = status
        self.url = url
        self.body = body


class RateLimiter:
    """Spaces requests evenly so a thread pool stays under `per_second`."""

    def __init__(self, per_second: float):
        self.interval = 1.0 / per_second
        self._lock = threading.Lock()
        self._next = 0.0

    def wait(self) -> None:
        with self._lock:
            now = time.monotonic()
            slot = max(now, self._next)
            self._next = slot + self.interval
        if slot > now:
            time.sleep(slot - now)


def get_json(url: str, params: dict | None = None, limiter: RateLimiter | None = None,
             retries: int = 5, timeout: float = 30.0):
    if params:
        query = {k: v for k, v in params.items() if v is not None}
        if query:
            url = f"{url}?{urllib.parse.urlencode(query)}"
    for attempt in range(retries + 1):
        if limiter:
            limiter.wait()
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            body = e.read().decode(errors="replace")
            if e.code in RETRYABLE_STATUS and attempt < retries:
                time.sleep(min(2 ** attempt, 30))
                continue
            raise HttpError(e.code, url, body) from None
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            # A proxy refusing the tunnel is a policy decision, not a blip.
            if "Tunnel connection failed" in str(e) or attempt >= retries:
                raise
            time.sleep(min(2 ** attempt, 30))
    raise AssertionError("unreachable")
