from __future__ import annotations

import re
from datetime import datetime, timezone


def to_unix(value) -> int | None:
    """Accepts unix seconds (int/float/numeric string) or an ISO-8601 timestamp."""
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        return int(value)
    text = str(value).strip()
    try:
        return int(float(text))
    except ValueError:
        pass
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    # Older Pythons only parse 3- or 6-digit fractions; seconds are enough here.
    text = re.sub(r"\.\d+", "", text, count=1)
    dt = datetime.fromisoformat(text)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp())


def iso(ts: int) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
