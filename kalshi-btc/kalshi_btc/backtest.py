"""Simulation engine, statistics and the markdown report."""
from __future__ import annotations

import math
import statistics
from dataclasses import dataclass
from typing import Iterable, Sequence

from .dataset import Dataset, Market
from .fees import taker_fee
from .model import prob_up
from .strategies import SIMPLE_STRATEGIES, Context, FairValue, Strategy, strategy_name
from .timeutil import iso

ENTRY_MINUTES = (1, 3, 5, 7, 10, 12, 14)
EDGE_THRESHOLDS = (0.0, 0.02, 0.05, 0.10)
MIN_TRAIN_TRADES = 30
BASIS_WINDOWS = 8


@dataclass(frozen=True)
class Trade:
    ticker: str
    entry_ts: int
    minute: int
    side: str
    price: float
    contracts: int
    fee: float
    won: bool
    pnl: float
    p_yes: float | None
    mid: float | None

    @property
    def cost(self) -> float:
        return self.contracts * self.price + self.fee


class Backtester:
    def __init__(self, dataset: Dataset, contracts: int = 10, fee_multiplier: float = 1.0,
                 vol_lookback_minutes: int = 60, basis_windows: int = BASIS_WINDOWS):
        self.dataset = dataset
        self.contracts = contracts
        self.fee_multiplier = fee_multiplier
        self.vol_lookback = vol_lookback_minutes
        self.basis = self._trailing_basis(basis_windows)
        self._contexts: dict[tuple[str, int], Context | None] = {}

    def _trailing_basis(self, windows: int) -> dict[str, float]:
        """Gap between the settlement index and Coinbase for each market.

        It's the median, over this window and the `windows - 1` before it, of
        strike minus Coinbase's average over the minute before the open. A
        strike is public from its window's open, so this uses no future data.
        """
        btc = self.dataset.btc
        gaps: list[float] = []
        basis = {}
        for m in self.dataset.markets:
            before, at_open = btc.closes.get(m.open_ts - 120), btc.closes.get(m.open_ts - 60)
            if m.strike is not None and before and at_open:
                gaps.append(m.strike - (before + at_open) / 2)
            recent = gaps[-windows:] if windows > 0 else []
            basis[m.ticker] = statistics.median(recent) if recent and m.strike is not None else 0.0
        return basis

    def fee_per_contract(self, price: float) -> float:
        return taker_fee(self.contracts, price, self.fee_multiplier) / self.contracts

    def strike(self, market: Market) -> float | None:
        if market.strike is not None:
            return market.strike
        return self.dataset.btc.price_at(market.open_ts)

    def context(self, market: Market, minute: int) -> Context | None:
        key = (market.ticker, minute)
        if key not in self._contexts:
            self._contexts[key] = self._build_context(market, minute)
        return self._contexts[key]

    def _build_context(self, market: Market, minute: int) -> Context | None:
        ts = market.open_ts + 60 * minute
        minutes_left = (market.close_ts - ts) / 60.0
        if minutes_left < 1:
            return None
        quote = market.quote_at(ts)
        if quote is None:
            return None
        btc = self.dataset.btc
        spot = btc.price_at(ts)
        if spot is not None:
            spot += self.basis.get(market.ticker, 0.0)
        sigma = btc.realized_vol(ts, self.vol_lookback)
        strike = self.strike(market)
        p_yes = None
        if spot and sigma and strike:
            p_up = prob_up(spot, strike, sigma, minutes_left)
            p_yes = p_up if market.yes_is_up else 1.0 - p_up
        return Context(market, ts, minute, minutes_left, quote, spot, strike, sigma, p_yes,
                       self.fee_per_contract)

    def run(self, strategy: Strategy, minute: int, markets: Iterable[Market]) -> list[Trade]:
        trades = []
        for market in markets:
            ctx = self.context(market, minute)
            if ctx is None:
                continue
            decision = strategy(ctx)
            if decision is None:
                continue
            fee = taker_fee(self.contracts, decision.price, self.fee_multiplier)
            won = decision.side == market.result
            pnl = self.contracts * ((1.0 if won else 0.0) - decision.price) - fee
            trades.append(Trade(market.ticker, ctx.ts, minute, decision.side, decision.price,
                                self.contracts, fee, won, pnl, ctx.p_yes, ctx.quote.mid))
        return trades


@dataclass(frozen=True)
class Summary:
    trades: int
    win_rate: float
    avg_price: float
    pnl: float
    fees: float
    cost: float
    per_contract: float        # mean P&L per contract, dollars
    per_contract_se: float
    max_drawdown: float

    @property
    def roi(self) -> float:
        return self.pnl / self.cost if self.cost else 0.0

    @property
    def ci95(self) -> tuple[float, float]:
        return (self.per_contract - 1.96 * self.per_contract_se,
                self.per_contract + 1.96 * self.per_contract_se)


def summarize(trades: Sequence[Trade]) -> Summary:
    n = len(trades)
    if n == 0:
        return Summary(0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0)
    per_contract = [t.pnl / t.contracts for t in trades]
    mean = sum(per_contract) / n
    se = math.sqrt(sum((x - mean) ** 2 for x in per_contract) / (n - 1) / n) if n > 1 else 0.0
    equity = peak = drawdown = 0.0
    for t in sorted(trades, key=lambda t: t.entry_ts):
        equity += t.pnl
        peak = max(peak, equity)
        drawdown = max(drawdown, peak - equity)
    return Summary(
        trades=n,
        win_rate=sum(t.won for t in trades) / n,
        avg_price=sum(t.price for t in trades) / n,
        pnl=sum(t.pnl for t in trades),
        fees=sum(t.fee for t in trades),
        cost=sum(t.cost for t in trades),
        per_contract=mean,
        per_contract_se=se,
        max_drawdown=drawdown,
    )


@dataclass(frozen=True)
class Candidate:
    name: str
    strategy: Strategy
    minute: int


def candidates() -> list[Candidate]:
    pool = []
    for minute in ENTRY_MINUTES:
        for name, strategy in SIMPLE_STRATEGIES.items():
            pool.append(Candidate(name, strategy, minute))
        for edge in EDGE_THRESHOLDS:
            fv = FairValue(edge)
            pool.append(Candidate(strategy_name(fv), fv, minute))
    return pool


@dataclass
class WalkForward:
    train: list[Market]
    test: list[Market]
    ranked: list[tuple[Candidate, Summary]]   # by train P&L, best first
    chosen: Candidate | None
    chosen_train: Summary | None
    chosen_test: Summary | None
    test_trades: list[Trade]


def walk_forward(bt: Backtester, markets: Sequence[Market], train_frac: float = 0.5) -> WalkForward:
    """Pick the best candidate on the earlier slice, then score it once on the later slice."""
    split = int(len(markets) * train_frac)
    train, test = list(markets[:split]), list(markets[split:])
    ranked = []
    for cand in candidates():
        summary = summarize(bt.run(cand.strategy, cand.minute, train))
        if summary.trades >= MIN_TRAIN_TRADES:
            ranked.append((cand, summary))
    ranked.sort(key=lambda pair: pair[1].pnl, reverse=True)
    if not ranked:
        return WalkForward(train, test, [], None, None, None, [])
    chosen, chosen_train = ranked[0]
    test_trades = bt.run(chosen.strategy, chosen.minute, test)
    return WalkForward(train, test, ranked, chosen, chosen_train, summarize(test_trades), test_trades)


# --------------------------------------------------------------------------- report

def _cents(x: float) -> str:
    return f"{x * 100:+.2f}¢"


def _money(x: float) -> str:
    return f"-${-x:,.2f}" if x < 0 else f"${x:,.2f}"


def _summary_row(label: str, s: Summary) -> str:
    lo, hi = s.ci95
    return (f"| {label} | {s.trades} | {s.win_rate:.1%} | {s.avg_price:.3f} | {_money(s.pnl)} | "
            f"{_money(s.fees)} | {s.roi:+.1%} | {_cents(s.per_contract)} | "
            f"{_cents(lo)} … {_cents(hi)} | {_money(s.max_drawdown)} |")


SUMMARY_HEADER = ("| Strategy | Trades | Win rate | Avg price | P&L | Fees | ROI | P&L / contract | "
                  "95% CI / contract | Max drawdown |\n"
                  "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|")


def _brier(pairs: list[tuple[float, bool]]) -> float:
    return sum((p - (1.0 if y else 0.0)) ** 2 for p, y in pairs) / len(pairs)


def build_report(bt: Backtester, train_frac: float = 0.5) -> tuple[str, WalkForward]:
    ds = bt.dataset
    markets = [m for m in ds.markets if m.quotes]
    lines: list[str] = []
    out = lines.append

    out(f"# Kalshi {ds.series or 'BTC'} backtest")
    out("")
    if ds.meta.get("synthetic"):
        out("> **SYNTHETIC DATA.** These numbers come from simulated markets and only check that "
            "the pipeline works. They say nothing about real Kalshi markets.")
        out("")

    # ---- dataset
    out("## Dataset")
    out("")
    if not markets:
        out("No markets with quote data were found.")
        return "\n".join(lines), WalkForward([], [], [], None, None, None, [])
    yes_rate = sum(m.result == "yes" for m in markets) / len(markets)
    missing_strike = sum(m.strike is None for m in markets)
    checkable = [m for m in markets if m.strike is not None and m.expiration_value is not None]
    consistent = sum(((m.expiration_value >= m.strike) == (m.result == "yes")) == m.yes_is_up
                     for m in checkable)
    out(f"- Markets with quotes: **{len(markets)}** ({len(ds.markets) - len(markets)} more had no candle data)")
    out(f"- Windows: {iso(markets[0].open_ts)} → {iso(markets[-1].close_ts)}")
    out(f"- Resolved YES: {yes_rate:.1%}")
    out(f"- Contracts per trade: {bt.contracts}; taker fee multiplier: {bt.fee_multiplier}")
    listed_early = sum(m.listed_early for m in markets)
    if listed_early:
        out(f"- {listed_early} markets were listed before their 15-minute window; minutes are counted "
            f"from the window start")
    if missing_strike:
        out(f"- {missing_strike} markets had no `floor_strike`; used the Coinbase price at open instead")
    gaps = [bt.basis[m.ticker] for m in markets if bt.basis.get(m.ticker)]
    if gaps:
        out(f"- Coinbase prices are shifted onto the settlement index by a trailing gap estimate "
            f"(median {_money(statistics.median(gaps))})")
    if checkable:
        out(f"- Settlement sanity check (expiration value vs strike agrees with result): "
            f"{consistent}/{len(checkable)}")
    out("")
    out("Average bid/ask spread by minute into the window (what a taker pays to cross):")
    out("")
    out("| Minute | Markets quoted | Avg spread | Avg taker fee / contract at mid |")
    out("|---:|---:|---:|---:|")
    for minute in ENTRY_MINUTES:
        quotes = [c.quote for m in markets if (c := bt.context(m, minute)) and c.quote.mid is not None]
        if not quotes:
            continue
        spread = sum(q.yes_ask - q.yes_bid for q in quotes) / len(quotes)
        fee = sum(bt.fee_per_contract(q.mid) for q in quotes) / len(quotes)
        out(f"| {minute} | {len(quotes)} | {spread * 100:.2f}¢ | {fee * 100:.2f}¢ |")
    out("")

    # ---- calibration
    out("## Is the market already priced right?")
    out("")
    out("If the market's own price is a well-calibrated probability, there is nothing for a simple "
        "strategy to exploit. Buckets of the YES mid-price at minute 5 vs. how often YES actually won:")
    out("")
    out("| YES mid | Markets | Avg mid | Actually YES |")
    out("|---|---:|---:|---:|")
    buckets: dict[int, list[tuple[float, bool]]] = {}
    for m in markets:
        ctx = bt.context(m, 5)
        if ctx and ctx.quote.mid is not None:
            buckets.setdefault(min(int(ctx.quote.mid * 10), 9), []).append((ctx.quote.mid, m.result == "yes"))
    for b in sorted(buckets):
        rows = buckets[b]
        avg = sum(p for p, _ in rows) / len(rows)
        hit = sum(y for _, y in rows) / len(rows)
        out(f"| {b / 10:.1f}–{(b + 1) / 10:.1f} | {len(rows)} | {avg:.3f} | {hit:.3f} |")
    out("")
    out("Brier score (lower is better) of the market mid vs. the random-walk model, on the same windows:")
    out("")
    out("| Minute | Windows | Market | Model |")
    out("|---:|---:|---:|---:|")
    for minute in ENTRY_MINUTES:
        market_pairs, model_pairs = [], []
        for m in markets:
            ctx = bt.context(m, minute)
            if ctx and ctx.quote.mid is not None and ctx.p_yes is not None:
                market_pairs.append((ctx.quote.mid, m.result == "yes"))
                model_pairs.append((ctx.p_yes, m.result == "yes"))
        if market_pairs:
            out(f"| {minute} | {len(market_pairs)} | {_brier(market_pairs):.4f} | {_brier(model_pairs):.4f} |")
    out("")

    # ---- simple baselines, whole sample
    out("## Simple baselines (whole sample)")
    out("")
    out("Each strategy makes at most one taker trade per window, at the given minute, and holds to "
        "settlement. Minutes 5 and 10 are the \"every 5 minutes\" checkpoints inside each 15-minute window.")
    out("")
    out(SUMMARY_HEADER)
    for minute in (1, 5, 10, 14):
        for name, strategy in SIMPLE_STRATEGIES.items():
            out(_summary_row(f"{name} @ min {minute}", summarize(bt.run(strategy, minute, markets))))
        fv = FairValue(0.0)
        out(_summary_row(f"{strategy_name(fv)} @ min {minute}", summarize(bt.run(fv, minute, markets))))
    out("")

    # ---- walk-forward
    wf = walk_forward(bt, markets, train_frac)
    out("## Out-of-sample test")
    out("")
    out(f"Tried {len(candidates())} strategy/minute/threshold combinations on the first "
        f"{train_frac:.0%} of windows ({len(wf.train)} windows), picked the one with the highest "
        f"P&L, then ran only that one on the remaining {len(wf.test)} windows it had never seen.")
    out("")
    if wf.chosen is None:
        out(f"No combination made at least {MIN_TRAIN_TRADES} trades in the training slice.")
    else:
        out("Top 5 in training:")
        out("")
        out(SUMMARY_HEADER)
        for cand, summary in wf.ranked[:5]:
            out(_summary_row(f"{cand.name} @ min {cand.minute}", summary))
        out("")
        out(f"Chosen: **{wf.chosen.name} @ minute {wf.chosen.minute}**. Held-out result:")
        out("")
        out(SUMMARY_HEADER)
        out(_summary_row("train (in-sample)", wf.chosen_train))
        out(_summary_row("**test (held out)**", wf.chosen_test))
        out("")
    out("## Verdict")
    out("")
    out(verdict(wf))
    out("")
    out("## Caveats")
    out("")
    out("- Fills assume you can buy your full size at the quoted ask with no delay. Real fills are "
        "worse, especially for larger orders and during fast moves.")
    out("- The BTC price is Coinbase, not the CF Benchmarks index Kalshi settles on; they track "
        "closely but not perfectly.")
    out("- Picking the best of many combinations flatters the training numbers. Trust the held-out "
        "row, and treat a small sample as noise.")
    return "\n".join(lines), wf


def verdict(wf: WalkForward) -> str:
    s = wf.chosen_test
    if wf.chosen is None or s is None or s.trades == 0:
        return "Not enough data to judge. Fetch more days and re-run."
    lo, _ = s.ci95
    if lo > 0:
        return (f"**Possible edge.** The chosen strategy made {_money(s.pnl)} on held-out data and the "
                f"95% confidence interval per contract is above zero. That is worth paper-trading "
                f"live for a few weeks before any real money, because the backtest's fills are optimistic.")
    if s.pnl > 0:
        return (f"**No reliable edge.** The chosen strategy made {_money(s.pnl)} on held-out data, but "
                f"the result is within the range you'd expect from luck (95% CI per contract "
                f"includes zero). Don't trade it with real money.")
    return (f"**No edge.** The best strategy from training lost {_money(-s.pnl)} on the held-out data. "
            f"After the spread and fees, these baselines lose money. Don't trade them with real money.")
