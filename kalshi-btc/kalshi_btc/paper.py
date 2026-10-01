"""Paper-trading account for the live 15-minute BTC markets.

Orders fill against Kalshi's real order book at the moment you place them,
pay the real taker fee, and settle on Kalshi's real result. Nothing is ever
sent to Kalshi: the account only exists in a local JSON file.
"""
from __future__ import annotations

import json
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from .fees import taker_fee
from .kalshi import KalshiPublic
from .live import LiveFeed, Snapshot
from .strategies import Context, FairValue, Strategy, favorite, momentum, underdog, buy_yes

CHECKPOINT_MINUTES = (5, 10)
CHECKPOINT_GRACE_SECONDS = 60
SETTLE_POLL_SECONDS = 5


@dataclass(frozen=True)
class Bot:
    key: str
    label: str
    description: str
    strategy: Strategy
    default_on: bool


BOTS = [
    Bot("momentum", "Momentum", "Bets BTC keeps going the way it has moved since the window opened.",
        momentum, True),
    Bot("favorite", "Follow the favorite", "Buys whichever side the market prices above 50¢.",
        favorite, True),
    Bot("fair_value_2", "Pricing model, 2¢ edge",
        "Buys only when the random-walk model says a side is underpriced by 2¢ or more after fees.",
        FairValue(0.02), True),
    Bot("fair_value_5", "Pricing model, 5¢ edge", "Same model, but waits for a 5¢ edge.",
        FairValue(0.05), False),
    Bot("underdog", "Underdog", "Buys whichever side the market prices below 50¢.", underdog, False),
    Bot("buy_yes", "Always YES", "Buys YES every time. Shows what spread and fees cost.", buy_yes, False),
]
BOTS_BY_KEY = {b.key: b for b in BOTS}


class OrderError(Exception):
    pass


def walk_book(side: str, contracts: int, yes_bids: list[tuple[float, float]],
              no_bids: list[tuple[float, float]]) -> list[tuple[float, int]]:
    """Fill `contracts` against resting orders, cheapest first.

    Kalshi's book only lists bids: buying YES at p means matching a NO bid at 1 - p.
    """
    opposite = no_bids if side == "yes" else yes_bids
    fills, remaining = [], contracts
    for bid, size in opposite:
        take = min(remaining, int(size))
        if take <= 0:
            continue
        fills.append((round(1.0 - bid, 4), take))
        remaining -= take
        if remaining == 0:
            break
    return fills


class PaperDesk:
    def __init__(self, state_path: str | Path, feed: LiveFeed, client: KalshiPublic,
                 starting_balance: float = 1000.0, default_contracts: int = 10,
                 clock: Callable[[], float] = time.time):
        self.path = Path(state_path)
        self.feed = feed
        self.client = client
        self.clock = clock
        self.lock = threading.RLock()
        self._last_settle_poll: dict[str, float] = {}
        if self.path.exists():
            self.state = json.loads(self.path.read_text())
        else:
            self.state = self._fresh_state(starting_balance, default_contracts)
            self._save()

    @staticmethod
    def _fresh_state(balance: float, contracts: int) -> dict:
        return {
            "starting_balance": balance,
            "cash": balance,
            "created_at": time.time(),
            "positions": [],
            "history": [],
            "bots": {b.key: {"enabled": b.default_on, "contracts": contracts} for b in BOTS},
            "fired": [],
        }

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.state, indent=1))
        tmp.replace(self.path)

    # ------------------------------------------------------------------ orders

    def place_order(self, side: str, contracts: int, source: str = "manual",
                    snap: Snapshot | None = None) -> dict:
        if side not in ("yes", "no"):
            raise OrderError("Side must be YES or NO.")
        if not isinstance(contracts, int) or not 1 <= contracts <= 10000:
            raise OrderError("Contracts must be a whole number from 1 to 10,000.")
        snap = snap or self.feed.snapshot()
        market = snap.market
        now = self.clock()
        if market is None or now >= market.close_ts:
            raise OrderError("No window is open right now. The next one opens on the quarter hour.")
        try:
            yes_bids, no_bids = self.client.orderbook(market.ticker)
        except Exception as e:
            raise OrderError(f"Couldn't read Kalshi's order book ({e}). Try again in a moment.") from None
        fills = walk_book(side, contracts, yes_bids, no_bids)
        if not fills:
            raise OrderError(f"Nobody is selling {side.upper()} right now.")
        filled = sum(q for _, q in fills)
        price_total = sum(p * q for p, q in fills)
        fee = round(sum(taker_fee(q, p) for p, q in fills), 2)
        cost = round(price_total + fee, 4)
        with self.lock:
            if cost > self.state["cash"] + 1e-9:
                raise OrderError(f"That costs ${cost:,.2f} but the paper account has "
                                 f"${self.state['cash']:,.2f}.")
            position = {
                "id": uuid.uuid4().hex[:10],
                "ticker": market.ticker,
                "open_ts": market.open_ts,
                "close_ts": market.close_ts,
                "strike": market.strike,
                "side": side,
                "contracts": filled,
                "requested": contracts,
                "avg_price": round(price_total / filled, 4),
                "fee": fee,
                "cost": cost,
                "source": source,
                "placed_at": now,
                "minute": int((now - market.open_ts) // 60),
                "spot_at_entry": snap.spot,
                "model_p_yes": snap.p_yes,
            }
            self.state["cash"] = round(self.state["cash"] - cost, 4)
            self.state["positions"].append(position)
            self._save()
        return position

    # ------------------------------------------------------------------ bots

    def set_bot(self, key: str, enabled: bool | None = None, contracts: int | None = None) -> None:
        if key not in BOTS_BY_KEY:
            raise OrderError(f"Unknown strategy {key!r}.")
        with self.lock:
            bot = self.state["bots"].setdefault(key, {"enabled": False, "contracts": 10})
            if enabled is not None:
                bot["enabled"] = bool(enabled)
            if contracts is not None:
                if not isinstance(contracts, int) or not 1 <= contracts <= 10000:
                    raise OrderError("Contracts must be a whole number from 1 to 10,000.")
                bot["contracts"] = contracts
            self._save()

    def run_bots(self, snap: Snapshot) -> list[dict]:
        """At minutes 5 and 10 of each window, give every enabled bot one decision."""
        market, quote = snap.market, snap.quote
        if market is None or quote is None:
            return []
        elapsed = snap.ts - market.open_ts
        placed = []
        for minute in CHECKPOINT_MINUTES:
            if not 0 <= elapsed - minute * 60 < CHECKPOINT_GRACE_SECONDS:
                continue
            for bot in BOTS:
                settings = self.state["bots"].get(bot.key, {})
                tag = f"{market.ticker}|{bot.key}|{minute}"
                if not settings.get("enabled") or tag in self.state["fired"]:
                    continue
                with self.lock:
                    self.state["fired"] = (self.state["fired"] + [tag])[-500:]
                contracts = int(settings.get("contracts", 10))
                ctx = Context(market, int(snap.ts), minute, (market.close_ts - snap.ts) / 60.0, quote,
                              snap.spot, market.strike, snap.sigma, snap.p_yes,
                              lambda p, c=contracts: taker_fee(c, p) / c)
                decision = bot.strategy(ctx)
                if decision is None:
                    continue
                try:
                    placed.append(self.place_order(decision.side, contracts, source=bot.key, snap=snap))
                except OrderError:
                    pass
            with self.lock:
                self._save()
        return placed

    # ------------------------------------------------------------------ settlement

    def settle(self) -> list[dict]:
        now = self.clock()
        settled = []
        due = {p["ticker"] for p in self.state["positions"] if p["close_ts"] <= now}
        for ticker in due:
            if now - self._last_settle_poll.get(ticker, 0) < SETTLE_POLL_SECONDS:
                continue
            self._last_settle_poll[ticker] = now
            try:
                raw = self.client.market(ticker)
            except Exception:
                continue
            result = raw.get("result")
            if result not in ("yes", "no"):
                continue
            settlement = raw.get("expiration_value")
            with self.lock:
                still_open = []
                for p in self.state["positions"]:
                    if p["ticker"] != ticker:
                        still_open.append(p)
                        continue
                    payout = float(p["contracts"]) if p["side"] == result else 0.0
                    record = {**p, "result": result, "payout": payout,
                              "pnl": round(payout - p["cost"], 4), "settled_at": now,
                              "settlement_value": float(settlement) if settlement else None}
                    self.state["cash"] = round(self.state["cash"] + payout, 4)
                    self.state["history"].append(record)
                    settled.append(record)
                self.state["positions"] = still_open
                self._save()
        return settled

    def reset(self, balance: float) -> None:
        if not 1 <= balance <= 10_000_000:
            raise OrderError("Starting balance must be between $1 and $10,000,000.")
        with self.lock:
            contracts = {k: v.get("contracts", 10) for k, v in self.state["bots"].items()}
            enabled = {k: v.get("enabled", False) for k, v in self.state["bots"].items()}
            self.state = self._fresh_state(balance, 10)
            for key, bot in self.state["bots"].items():
                bot["contracts"] = contracts.get(key, 10)
                bot["enabled"] = enabled.get(key, bot["enabled"])
            self._save()

    # ------------------------------------------------------------------ loop

    def tick(self) -> Snapshot:
        snap = self.feed.refresh()
        self.run_bots(snap)
        self.settle()
        return snap

    def run_forever(self, interval: float = 2.0, stop: threading.Event | None = None) -> None:
        stop = stop or threading.Event()
        while not stop.is_set():
            started = time.time()
            try:
                self.tick()
            except Exception as e:  # never let one bad tick kill the desk
                print(f"tick failed: {e}")
            stop.wait(max(0.0, interval - (time.time() - started)))

    # ------------------------------------------------------------------ view

    def view(self) -> dict:
        snap = self.feed.snapshot()
        with self.lock:
            state = json.loads(json.dumps(self.state))
        market, quote = snap.market, snap.quote

        def mark(p: dict) -> float | None:
            if market is None or quote is None or p["ticker"] != market.ticker:
                return None
            bid = quote.yes_bid if p["side"] == "yes" else (None if quote.yes_ask is None else 1 - quote.yes_ask)
            return None if bid is None else round(bid * p["contracts"], 4)

        for p in state["positions"]:
            p["value"] = mark(p)
        open_value = sum(p["value"] if p["value"] is not None else p["cost"] for p in state["positions"])
        history = state["history"]
        realized = sum(h["pnl"] for h in history)

        by_source: dict[str, dict] = {}
        for h in history:
            s = by_source.setdefault(h["source"], {"trades": 0, "open": 0, "wins": 0, "pnl": 0.0, "fees": 0.0, "contracts": 0})
            s["trades"] += 1
            s["wins"] += h["side"] == h["result"]
            s["pnl"] += h["pnl"]
            s["fees"] += h["fee"]
            s["contracts"] += h["contracts"]
        for p in state["positions"]:
            s = by_source.setdefault(p["source"], {"trades": 0, "open": 0, "wins": 0, "pnl": 0.0, "fees": 0.0, "contracts": 0})
            s["open"] += 1

        equity_curve, running = [], 0.0
        for h in sorted(history, key=lambda h: h["settled_at"]):
            running += h["pnl"]
            equity_curve.append([h["settled_at"], round(running, 2)])

        return {
            "now": snap.ts,
            "error": snap.error,
            "market": None if market is None else {
                "ticker": market.ticker,
                "open_ts": market.open_ts,
                "close_ts": market.close_ts,
                "strike": market.strike,
                "yes_bid": quote.yes_bid,
                "yes_ask": quote.yes_ask,
                "no_bid": None if quote.yes_ask is None else round(1 - quote.yes_ask, 4),
                "no_ask": quote.no_ask,
                "bid_size": snap.bid_size,
                "ask_size": snap.ask_size,
                "yes_fee_per_contract_10": None if quote.yes_ask is None else taker_fee(10, quote.yes_ask) / 10,
                "no_fee_per_contract_10": None if quote.no_ask is None else taker_fee(10, quote.no_ask) / 10,
            },
            "btc": {"spot": snap.spot, "raw_spot": snap.raw_spot, "basis": snap.basis, "sigma": snap.sigma,
                    "history": snap.history},
            "model": {"p_yes": snap.p_yes},
            "account": {
                "starting_balance": state["starting_balance"],
                "cash": state["cash"],
                "open_value": round(open_value, 4),
                "equity": round(state["cash"] + open_value, 4),
                "realized": round(realized, 4),
                "created_at": state["created_at"],
            },
            "positions": state["positions"],
            "history": history[-200:][::-1],
            "equity_curve": equity_curve,
            "by_source": by_source,
            "bots": [{"key": b.key, "label": b.label, "description": b.description,
                      **state["bots"].get(b.key, {"enabled": False, "contracts": 10})} for b in BOTS],
            "checkpoints": list(CHECKPOINT_MINUTES),
        }
