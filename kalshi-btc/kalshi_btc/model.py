"""Fair probability that BTC finishes the window at or above the strike.

Driftless random walk in log price: P(up) = Phi(ln(S/K) / (sigma * sqrt(T))).
Kalshi settles on the average of the index over the final 60 seconds, which
has the variance of roughly T - 2/3 minutes of walk rather than T minutes.
"""
from __future__ import annotations

import math


def norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def prob_up(spot: float, strike: float, sigma_per_minute: float, minutes_left: float) -> float:
    effective_minutes = max(minutes_left - 2.0 / 3.0, 1.0 / 3.0)
    sd = sigma_per_minute * math.sqrt(effective_minutes)
    if sd <= 0:
        return 1.0 if spot >= strike else 0.0
    return norm_cdf(math.log(spot / strike) / sd)
