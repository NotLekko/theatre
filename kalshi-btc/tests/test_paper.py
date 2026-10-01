import json
import tempfile
import unittest
from pathlib import Path

from kalshi_btc.dataset import Market, Quote
from kalshi_btc.fees import taker_fee
from kalshi_btc.live import Snapshot
from kalshi_btc.paper import BOTS, OrderError, PaperDesk, walk_book

OPEN, CLOSE = 1_000_200, 1_001_100   # a 15-minute window


class FakeClient:
    def __init__(self):
        self.yes_bids = [(0.40, 50.0), (0.39, 100.0)]
        self.no_bids = [(0.58, 5.0), (0.57, 1000.0)]   # YES offers at 0.42 and 0.43
        self.result = ""

    def orderbook(self, ticker):
        return self.yes_bids, self.no_bids

    def market(self, ticker):
        return {"ticker": ticker, "result": self.result, "expiration_value": "100.5"}


class FakeFeed:
    def __init__(self, ts):
        self.snap = self.make(ts)

    @staticmethod
    def make(ts, spot=101.0):
        market = Market("KXBTC15M-TEST", OPEN, CLOSE, 100.0, "", True, None)
        return Snapshot(ts=ts, market=market, quote=Quote(int(ts), 0.40, 0.42), spot=spot,
                        sigma=0.001, p_yes=0.7, history=[])

    def snapshot(self):
        return self.snap

    def refresh(self):
        return self.snap


class PaperDeskTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "account.json"
        self.now = OPEN + 120
        self.client = FakeClient()
        self.feed = FakeFeed(self.now)
        self.desk = PaperDesk(self.path, self.feed, self.client, clock=lambda: self.now)

    def tearDown(self):
        self.tmp.cleanup()

    def test_walk_book_buys_cheapest_offers_first(self):
        fills = walk_book("yes", 20, self.client.yes_bids, self.client.no_bids)
        self.assertEqual(fills, [(0.42, 5), (0.43, 15)])
        self.assertEqual(walk_book("no", 60, self.client.yes_bids, self.client.no_bids), [(0.6, 50), (0.61, 10)])
        self.assertEqual(walk_book("yes", 5, [], []), [])

    def test_order_pays_book_prices_and_fees(self):
        p = self.desk.place_order("yes", 20)
        expected_fee = round(taker_fee(5, 0.42) + taker_fee(15, 0.43), 2)
        self.assertEqual(p["contracts"], 20)
        self.assertAlmostEqual(p["avg_price"], (5 * 0.42 + 15 * 0.43) / 20)
        self.assertAlmostEqual(p["fee"], expected_fee)
        self.assertAlmostEqual(self.desk.state["cash"], 1000 - (5 * 0.42 + 15 * 0.43) - expected_fee)
        # Saved to disk, so a restart picks it up.
        self.assertEqual(len(json.loads(self.path.read_text())["positions"]), 1)

    def test_rejects_orders_it_cannot_fill_or_afford(self):
        self.client.no_bids = [(0.58, 5000.0)]
        with self.assertRaises(OrderError):
            self.desk.place_order("yes", 5000)            # $2,100 > $1,000
        with self.assertRaises(OrderError):
            self.desk.place_order("maybe", 5)
        with self.assertRaises(OrderError):
            self.desk.place_order("yes", 0)
        self.client.no_bids = []
        with self.assertRaises(OrderError):
            self.desk.place_order("yes", 5)
        self.now = CLOSE + 1
        with self.assertRaises(OrderError):
            self.desk.place_order("no", 5)
        self.assertEqual(self.desk.state["cash"], 1000)

    def test_settles_on_kalshi_result(self):
        win = self.desk.place_order("yes", 5)
        lose = self.desk.place_order("no", 10)
        cash_after_buys = self.desk.state["cash"]
        self.now = CLOSE + 2
        self.assertEqual(self.desk.settle(), [])          # Kalshi hasn't settled yet
        self.client.result = "yes"
        self.now += 10
        settled = {r["id"]: r for r in self.desk.settle()}
        self.assertAlmostEqual(settled[win["id"]]["pnl"], 5 - win["cost"])
        self.assertAlmostEqual(settled[lose["id"]]["pnl"], -lose["cost"])
        self.assertAlmostEqual(self.desk.state["cash"], cash_after_buys + 5)
        self.assertEqual(self.desk.state["positions"], [])
        view = self.desk.view()
        self.assertEqual(view["by_source"]["manual"]["trades"], 2)
        self.assertEqual(view["by_source"]["manual"]["wins"], 1)

    def test_bots_bet_once_per_checkpoint(self):
        enabled = {k for k, v in self.desk.state["bots"].items() if v["enabled"]}
        self.assertEqual(enabled, {b.key for b in BOTS if b.default_on})

        self.feed.snap = FakeFeed.make(OPEN + 4 * 60)    # before minute 5: nothing
        self.assertEqual(self.desk.run_bots(self.feed.snap), [])

        self.feed.snap = FakeFeed.make(OPEN + 5 * 60 + 3)
        first = self.desk.run_bots(self.feed.snap)
        self.assertEqual(self.desk.run_bots(self.feed.snap), [])   # same checkpoint again
        sources = {p["source"] for p in first}
        # BTC above target and market at 41% UP: momentum buys UP, favorite buys DOWN,
        # and the model (70% vs a 42¢ ask) sees an edge on UP.
        self.assertEqual(sources, {"momentum", "favorite", "fair_value_2"})
        sides = {p["source"]: p["side"] for p in first}
        self.assertEqual(sides, {"momentum": "yes", "favorite": "no", "fair_value_2": "yes"})

        self.feed.snap = FakeFeed.make(OPEN + 7 * 60)    # between checkpoints
        self.assertEqual(self.desk.run_bots(self.feed.snap), [])
        self.feed.snap = FakeFeed.make(OPEN + 10 * 60 + 1)
        self.assertEqual(len(self.desk.run_bots(self.feed.snap)), 3)

    def test_switching_bots_and_reset(self):
        self.desk.set_bot("momentum", enabled=False, contracts=25)
        self.assertEqual(self.desk.state["bots"]["momentum"], {"enabled": False, "contracts": 25})
        with self.assertRaises(OrderError):
            self.desk.set_bot("nope", enabled=True)
        self.desk.place_order("yes", 5)
        self.desk.reset(500)
        self.assertEqual(self.desk.state["cash"], 500)
        self.assertEqual(self.desk.state["positions"], [])
        self.assertEqual(self.desk.state["bots"]["momentum"], {"enabled": False, "contracts": 25})


if __name__ == "__main__":
    unittest.main()
