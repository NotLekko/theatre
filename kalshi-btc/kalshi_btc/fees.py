"""Kalshi trading fees.

Taker fee per order = ceil_to_cent(0.07 * multiplier * contracts * P * (1 - P)),
so it is largest (1.75 cents/contract) at a 50-cent price. The multiplier is 1
unless Kalshi's fee schedule sets a different one for the series.
"""
from __future__ import annotations

import math

TAKER_RATE = 0.07


def taker_fee(contracts: int, price: float, multiplier: float = 1.0) -> float:
    raw = TAKER_RATE * multiplier * contracts * price * (1.0 - price)
    # Round before ceil so float noise (1.7500000001) doesn't add a cent.
    return math.ceil(round(raw * 100, 6)) / 100
