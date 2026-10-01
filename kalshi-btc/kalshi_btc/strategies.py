"""Baseline strategies. Each one looks at a single moment in a window and
either buys one side at the current ask (a taker order) or passes.

Every order is held to settlement: $1 per contract if right, $0 if wrong.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from .dataset import Market, Quote


@dataclass(frozen=True)
class Context:
    market: Market
    ts: int
    minute: int                 # minutes since the window opened
    minutes_left: float
    quote: Quote
    spot: float | None          # BTC price at ts (Coinbase, shifted onto the settlement index)
    strike: float | None
    sigma: float | None         # trailing one-minute log-return volatility
    p_yes: float | None         # model probability that YES settles in the money
    fee_per_contract: Callable[[float], float]


@dataclass(frozen=True)
class Decision:
    side: str                   # "yes" or "no"
    price: float


Strategy = Callable[[Context], "Decision | None"]


def _buy(side: str, ctx: Context) -> Decision | None:
    price = ctx.quote.yes_ask if side == "yes" else ctx.quote.no_ask
    return Decision(side, price) if price is not None else None


def buy_yes(ctx: Context) -> Decision | None:
    return _buy("yes", ctx)


def buy_no(ctx: Context) -> Decision | None:
    return _buy("no", ctx)


def favorite(ctx: Context) -> Decision | None:
    """Back whichever side the market currently prices above 50%."""
    mid = ctx.quote.mid
    if mid is None or mid == 0.5:
        return None
    return _buy("yes" if mid > 0.5 else "no", ctx)


def underdog(ctx: Context) -> Decision | None:
    mid = ctx.quote.mid
    if mid is None or mid == 0.5:
        return None
    return _buy("no" if mid > 0.5 else "yes", ctx)


def momentum(ctx: Context) -> Decision | None:
    """Bet BTC keeps going the way it has moved since the window opened."""
    if ctx.spot is None or ctx.strike is None or ctx.spot == ctx.strike:
        return None
    up = ctx.spot > ctx.strike
    return _buy("yes" if up == ctx.market.yes_is_up else "no", ctx)


class FairValue:
    """Buy a side only when the random-walk model says it's underpriced by
    more than `min_edge` after paying the ask and the fee."""

    def __init__(self, min_edge: float):
        self.min_edge = min_edge
        self.__name__ = f"fair_value(edge>{min_edge:.2f})"

    def __call__(self, ctx: Context) -> Decision | None:
        if ctx.p_yes is None:
            return None
        best: tuple[float, Decision] | None = None
        for side, p_win in (("yes", ctx.p_yes), ("no", 1.0 - ctx.p_yes)):
            decision = _buy(side, ctx)
            if decision is None:
                continue
            edge = p_win - decision.price - ctx.fee_per_contract(decision.price)
            if edge > self.min_edge and (best is None or edge > best[0]):
                best = (edge, decision)
        return best[1] if best else None


SIMPLE_STRATEGIES: dict[str, Strategy] = {
    "buy_yes": buy_yes,
    "buy_no": buy_no,
    "favorite": favorite,
    "underdog": underdog,
    "momentum": momentum,
}


def strategy_name(strategy: Strategy) -> str:
    return getattr(strategy, "__name__", type(strategy).__name__)
