"""Command line: `python -m kalshi_btc {fetch,synth,backtest} ...`"""
from __future__ import annotations

import argparse
import csv
import sys
import time
from pathlib import Path

from .backtest import Backtester, build_report
from .dataset import load_dataset
from .kalshi import DEFAULT_SERIES
from .timeutil import iso


def cmd_fetch(args) -> None:
    from .fetch import fetch
    fetch(args.data, series=args.series, days=args.days, workers=args.workers)


def cmd_synth(args) -> None:
    from .synthetic import generate
    path = generate(args.data, days=args.days, seed=args.seed, vol_mult=args.vol_mult,
                    quote_noise=args.quote_noise, spread=args.spread)
    print(f"Wrote synthetic dataset to {path}")


def cmd_backtest(args) -> None:
    dataset = load_dataset(args.data)
    bt = Backtester(dataset, contracts=args.contracts, fee_multiplier=args.fee_multiplier)
    report, wf = build_report(bt, train_frac=args.train_frac)
    print(report)

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    report_path = out_dir / f"backtest-{stamp}.md"
    report_path.write_text(report + "\n")
    trades_path = out_dir / f"backtest-{stamp}-test-trades.csv"
    with trades_path.open("w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["ticker", "entry_time", "minute", "side", "price", "contracts", "fee",
                         "won", "pnl", "model_p_yes", "market_mid"])
        for t in wf.test_trades:
            writer.writerow([t.ticker, iso(t.entry_ts), t.minute, t.side, f"{t.price:.4f}", t.contracts,
                             f"{t.fee:.2f}", int(t.won), f"{t.pnl:.4f}",
                             "" if t.p_yes is None else f"{t.p_yes:.4f}",
                             "" if t.mid is None else f"{t.mid:.4f}"])
    print(f"\nSaved {report_path} and {trades_path}", file=sys.stderr)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="python -m kalshi_btc",
                                     description="Backtest baseline strategies on Kalshi's 15-minute BTC markets.")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("fetch", help="download settled markets, candles and BTC prices (no API key needed)")
    p.add_argument("--days", type=float, default=30)
    p.add_argument("--series", default=DEFAULT_SERIES)
    p.add_argument("--data", default="data")
    p.add_argument("--workers", type=int, default=4)
    p.set_defaults(func=cmd_fetch)

    p = sub.add_parser("synth", help="write a synthetic dataset for testing the pipeline")
    p.add_argument("--days", type=float, default=14)
    p.add_argument("--data", default="data-synthetic")
    p.add_argument("--seed", type=int, default=7)
    p.add_argument("--vol-mult", type=float, default=1.0,
                   help="market prices with this multiple of true volatility (1 = fairly priced)")
    p.add_argument("--quote-noise", type=float, default=0.01)
    p.add_argument("--spread", type=float, default=0.02)
    p.set_defaults(func=cmd_synth)

    p = sub.add_parser("backtest", help="run the baselines and write a report")
    p.add_argument("--data", default="data")
    p.add_argument("--contracts", type=int, default=10, help="contracts per trade")
    p.add_argument("--fee-multiplier", type=float, default=1.0)
    p.add_argument("--train-frac", type=float, default=0.5)
    p.add_argument("--out", default="reports")
    p.set_defaults(func=cmd_backtest)

    args = parser.parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
