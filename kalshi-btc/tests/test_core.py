import json
import math
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from kalshi_btc import fetch as fetch_module
from kalshi_btc.backtest import Backtester, build_report, summarize
from kalshi_btc.dataset import BtcSeries, Dataset, Market, Quote, load_dataset, parse_candle, parse_market, parse_price
from kalshi_btc.fees import taker_fee
from kalshi_btc.http import HttpError
from kalshi_btc.kalshi import KalshiPublic
from kalshi_btc.model import prob_up
from kalshi_btc.strategies import FairValue, buy_no, buy_yes
from kalshi_btc.synthetic import generate
from kalshi_btc.timeutil import to_unix


class FeeTest(unittest.TestCase):
    def test_rounds_up_to_the_cent(self):
        self.assertEqual(taker_fee(1, 0.50), 0.02)     # 1.75 cents -> 2
        self.assertEqual(taker_fee(10, 0.50), 0.18)    # 17.5 cents -> 18
        self.assertEqual(taker_fee(100, 0.50), 1.75)   # exact, no extra cent from float noise
        self.assertEqual(taker_fee(10, 0.90), 0.07)    # 6.3 cents -> 7

    def test_multiplier(self):
        self.assertEqual(taker_fee(100, 0.50, multiplier=0.5), 0.88)


class ParsingTest(unittest.TestCase):
    def test_price_formats(self):
        self.assertEqual(parse_price({"close_dollars": "0.5600"}), 0.56)
        self.assertEqual(parse_price({"close": 56}), 0.56)
        self.assertEqual(parse_price({"close": "56"}), 0.56)
        self.assertEqual(parse_price({"close": 0.56}), 0.56)
        self.assertIsNone(parse_price({}))
        self.assertIsNone(parse_price(None))

    def test_empty_book_sides_become_none(self):
        q = parse_candle({"end_period_ts": 120, "yes_bid": {"close": 0}, "yes_ask": {"close": 100}})
        self.assertEqual(q, Quote(120, None, None))
        q = parse_candle({"end_period_ts": 120, "yes_bid": {"close": 40}, "yes_ask": {"close": 43}})
        self.assertAlmostEqual(q.no_ask, 0.60)
        self.assertAlmostEqual(q.mid, 0.415)

    def test_market(self):
        m = parse_market({"ticker": "T", "open_time": "2026-09-30T14:00:00Z",
                          "close_time": "2026-09-30T14:15:00.000Z", "floor_strike": 65000.5,
                          "result": "no", "expiration_value": "64990.10"})
        self.assertEqual(m.close_ts - m.open_ts, 900)
        self.assertTrue(m.yes_is_up)
        self.assertFalse(m.went_up)
        early = parse_market({"ticker": "T", "open_time": "2026-09-30T13:00:00Z",
                              "close_time": "2026-09-30T14:15:00Z", "result": "yes"})
        self.assertEqual(early.close_ts - early.open_ts, 900)
        self.assertTrue(early.listed_early)
        self.assertIsNone(parse_market({"ticker": "T", "open_time": "2026-09-30T14:00:00Z",
                                        "close_time": "2026-09-30T14:15:00Z", "result": ""}))

    def test_to_unix(self):
        self.assertEqual(to_unix("2026-09-01T00:00:00Z"), 1788220800)
        self.assertEqual(to_unix(1788220800), 1788220800)
        self.assertEqual(to_unix("1788220800"), 1788220800)
        self.assertIsNone(to_unix(None))


class NoLookaheadTest(unittest.TestCase):
    def test_quote_at_uses_latest_snapshot_not_after(self):
        m = Market("T", 0, 900, 100.0, "yes", True, None)
        m.set_quotes([Quote(60, 0.4, 0.42), Quote(120, 0.5, 0.52), Quote(600, 0.9, 0.92)])
        self.assertEqual(m.quote_at(119).yes_bid, 0.4)
        self.assertEqual(m.quote_at(120).yes_bid, 0.5)
        self.assertIsNone(m.quote_at(30))
        self.assertIsNone(m.quote_at(400))  # last snapshot is too stale

    def test_btc_lookups_ignore_future_prices(self):
        closes = {t: 100.0 * math.exp(0.001 * (t // 60) * (-1) ** (t // 60)) for t in range(0, 7200, 60)}
        series = BtcSeries(dict(closes))
        ts = 3600
        price, vol = series.price_at(ts), series.realized_vol(ts)
        tampered = {t: (px if t + 60 <= ts else px * 2) for t, px in closes.items()}
        series2 = BtcSeries(tampered)
        self.assertEqual(series2.price_at(ts), price)
        self.assertEqual(series2.realized_vol(ts), vol)
        self.assertEqual(price, closes[ts - 60])

    def test_basis_uses_only_current_and_earlier_strikes(self):
        closes = {t: 100.0 for t in range(-600, 3600, 60)}
        markets = [Market(f"M{i}", i * 900, (i + 1) * 900, 103.0 + i, "yes", True, None) for i in range(3)]
        bt = Backtester(_dataset(markets, closes), basis_windows=8)
        self.assertEqual(bt.basis["M0"], 3.0)
        self.assertEqual(bt.basis["M1"], 3.5)
        markets[2].strike = 500.0  # a later window can't move earlier estimates
        self.assertEqual(Backtester(_dataset(markets, closes), basis_windows=8).basis["M1"], 3.5)


class ModelTest(unittest.TestCase):
    def test_prob_up(self):
        self.assertAlmostEqual(prob_up(100, 100, 0.001, 10), 0.5)
        self.assertGreater(prob_up(100.1, 100, 0.001, 10), 0.5)
        self.assertLess(prob_up(99.9, 100, 0.001, 10), 0.5)
        # Less time left means more certainty for the same move.
        self.assertGreater(prob_up(100.1, 100, 0.001, 2), prob_up(100.1, 100, 0.001, 10))


def _dataset(markets, closes=None):
    return Dataset("KXBTC15M", markets, BtcSeries(closes or {}), {})


class AccountingTest(unittest.TestCase):
    def test_pnl_for_wins_and_losses(self):
        win = Market("W", 0, 900, 100.0, "yes", True, None)
        win.set_quotes([Quote(300, 0.38, 0.40)])
        lose = Market("L", 900, 1800, 100.0, "no", True, None)
        lose.set_quotes([Quote(1200, 0.38, 0.40)])
        bt = Backtester(_dataset([win, lose]), contracts=10)

        trades = bt.run(buy_yes, 5, [win, lose])
        self.assertEqual([t.won for t in trades], [True, False])
        fee = taker_fee(10, 0.40)
        self.assertAlmostEqual(trades[0].pnl, 10 * 0.60 - fee)
        self.assertAlmostEqual(trades[1].pnl, -10 * 0.40 - fee)

        no_trades = bt.run(buy_no, 5, [lose])
        self.assertAlmostEqual(no_trades[0].price, 0.62)
        self.assertAlmostEqual(no_trades[0].pnl, 10 * 0.38 - taker_fee(10, 0.62))

        s = summarize(trades)
        self.assertEqual(s.trades, 2)
        self.assertAlmostEqual(s.pnl, 2.0 - 2 * fee)
        self.assertAlmostEqual(s.max_drawdown, 4.0 + fee)

    def test_fair_value_needs_edge_after_fees(self):
        m = Market("T", 0, 900, 100.0, "yes", True, None)
        m.set_quotes([Quote(300, 0.49, 0.50)])
        closes = {t: 100.0 * (1 + 0.0005 * ((t // 60) % 2)) for t in range(-7200, 900, 60)}
        bt = Backtester(_dataset([m], closes))
        ctx = bt.context(m, 5)
        self.assertIsNotNone(ctx.p_yes)
        decision = FairValue(0.0)(ctx)
        if decision is not None:
            p_win = ctx.p_yes if decision.side == "yes" else 1 - ctx.p_yes
            self.assertGreater(p_win - decision.price - ctx.fee_per_contract(decision.price), 0)


class SyntheticEndToEndTest(unittest.TestCase):
    def _report(self, **kwargs):
        with tempfile.TemporaryDirectory() as tmp:
            generate(tmp, days=7, **kwargs)
            bt = Backtester(load_dataset(tmp))
            return build_report(bt)

    def test_fair_market_shows_no_edge(self):
        report, wf = self._report(vol_mult=1.0)
        self.assertIn("SYNTHETIC DATA", report)
        self.assertNotIn("Possible edge", report)
        self.assertLessEqual(wf.chosen_test.ci95[0], 0)

    def test_paying_the_spread_costs_money_in_a_fair_market(self):
        with tempfile.TemporaryDirectory() as tmp:
            generate(tmp, days=7, quote_noise=0.0)
            bt = Backtester(load_dataset(tmp))
            markets = bt.dataset.markets
            # Buying both sides every window isolates the cost of trading: one side always wins.
            both = bt.run(buy_yes, 5, markets) + bt.run(buy_no, 5, markets)
            self.assertLess(summarize(both).pnl, 0)
            # The model's volatility estimate is noisy, so it still finds some "edges";
            # in a fairly priced market they shouldn't hold up.
            self.assertLessEqual(summarize(bt.run(FairValue(0.0), 5, markets)).ci95[0], 0)

    def test_mispriced_market_shows_edge_out_of_sample(self):
        report, wf = self._report(vol_mult=2.0)
        self.assertIn("Possible edge", report)
        self.assertGreater(wf.chosen_test.ci95[0], 0)


class FakeKalshi(KalshiPublic):
    """Serves the synthetic dataset through the client interface."""

    def __init__(self, raw_markets, candles_by_ticker, reject_status_filter=False):
        super().__init__(per_second=1000)
        self.raw_markets = raw_markets
        self.candles = candles_by_ticker
        self.reject_status_filter = reject_status_filter
        self.paths = []

    def _get(self, path, params=None):
        self.paths.append((path, dict(params or {})))
        if path == "/historical/cutoff":
            raise HttpError(404, path, "")
        if path == "/markets":
            if self.reject_status_filter and "status" in params:
                raise HttpError(400, path, "invalid filter combination")
            page = int(params.get("cursor") or 0)
            chunk = self.raw_markets[page * 500:(page + 1) * 500]
            more = (page + 1) * 500 < len(self.raw_markets)
            return {"markets": chunk, "cursor": str(page + 1) if more else ""}
        if path.endswith("/candlesticks"):
            ticker = path.split("/")[-2]
            return {"ticker": ticker, "candlesticks": self.candles[ticker]}
        raise AssertionError(path)


class FetchTest(unittest.TestCase):
    def test_fetch_writes_a_loadable_dataset(self):
        with tempfile.TemporaryDirectory() as src, tempfile.TemporaryDirectory() as dst:
            generate(src, days=2)
            raw = json.loads((Path(src) / "markets.json").read_text())["markets"]
            raw.append({**raw[0], "ticker": "UNSETTLED", "result": ""})
            candles = {m["ticker"]: json.loads((Path(src) / "candles" / f"{m['ticker']}.json").read_text())
                       for m in raw if m["ticker"] != "UNSETTLED"}
            closes = {int(k): v for k, v in json.loads((Path(src) / "btc_1m.json").read_text())["closes"].items()}
            client = FakeKalshi(raw, candles, reject_status_filter=True)
            end_ts = to_unix(raw[-2]["close_time"])
            with mock.patch.object(fetch_module, "fetch_minute_closes", return_value=closes):
                fetch_module.fetch(dst, days=2.5, end_ts=end_ts, client=client, log=lambda _: None)

            ds = load_dataset(dst)
            self.assertEqual(len(ds.markets), len(raw) - 1)
            self.assertTrue(all(m.quotes for m in ds.markets))
            # The 400 on the status filter fell back to a looser query.
            market_queries = [p for path, p in client.paths if path == "/markets"]
            self.assertIn("status", market_queries[0])
            self.assertNotIn("status", market_queries[-1])


if __name__ == "__main__":
    unittest.main()
