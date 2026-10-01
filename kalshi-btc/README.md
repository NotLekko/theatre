# kalshi-btc

Backtests simple strategies on Kalshi's 15-minute bitcoin up/down markets
(`KXBTC15M`). It answers one question: **would these strategies have made
money after the spread and fees, on data they weren't tuned on?**

It does not place orders and does not need a Kalshi account or API key. It
only reads public market data.

**Result so far** ([full report](results/backtest-2026-10-01-60d.md), 60 days,
5,693 windows): no edge. The market's own price predicted outcomes better
than the model at every entry minute, every simple strategy lost money over
the whole sample, and the strategy that did best on the first half lost money
on the second.

## Quick start

Requires Python 3.9+. No packages to install.

```sh
cd kalshi-btc
python3 -m kalshi_btc fetch --days 30   # ~2,900 markets; takes about 7 minutes
python3 -m kalshi_btc backtest          # prints the report, saves it to reports/
```

`fetch` caches everything under `data/`. Re-running it only downloads what's
missing.

## Paper trading

```sh
python3 -m kalshi_btc paper   # opens http://localhost:8765 in your browser
```

A local web page for testing bets on the live 15-minute windows with paper
money. It shows the current window's target, BTC's live price against it, a
countdown, and the market's and the model's odds. You can:

- **Bet by hand.** Buy UP (YES) or DOWN (NO) for any number of contracts.
  Fills work through Kalshi's live order book at the moment you click, so big
  orders get worse prices, and every fill pays the real taker fee.
- **Run strategy bots.** Each switched-on bot gets one decision at minute 5
  and one at minute 10 of every window, using the same rules the backtest
  tested. Momentum, Follow the favorite and Pricing model (2¢ edge) start
  switched on.
- **Track results.** Bets settle on Kalshi's real result a few seconds after
  each window closes. The page shows P&L per strategy and for you.

The account starts at $1,000 and is saved to `paper/account.json`, so
stopping and restarting the desk picks up where you left off (bots only bet
while it's running). Nothing is ever sent to Kalshi, and no account or API
key is needed. The server only listens on your own computer (127.0.0.1).

Options: `--port 8765`, `--balance 1000` (for a new account),
`--state paper/account.json`, `--no-browser`.

## What it downloads

| Data | Source | Used for |
|---|---|---|
| Settled `KXBTC15M` markets: open/close time, strike, result | Kalshi public API | what each window was betting on and how it settled |
| One-minute candles for each market: best YES bid/ask | Kalshi public API | the price you could have bought at, minute by minute |
| BTC-USD one-minute prices | Coinbase public API | BTC's move inside each window, and recent volatility |

Kalshi settles these markets on the CF Benchmarks Real-Time Index: the strike
is its 60-second average before the window opens, and the result is its
60-second average before it closes. That index isn't freely downloadable;
Coinbase is one of its component exchanges and is used as a close proxy.
Coinbase runs a few dollars off the index, so its prices are shifted by the
median gap between recent strikes and Coinbase at those opens. Each strike is
public from its window's open, so the shift uses no future data.

## What it tests

Each strategy makes at most one trade per window: at a set minute into the
window it buys YES or NO at the current ask (a taker order, paying Kalshi's
fee) and holds until settlement.

| Strategy | Rule |
|---|---|
| `buy_yes` / `buy_no` | always buy that side; shows the raw cost of trading |
| `favorite` | buy whichever side the market prices above 50¢ |
| `underdog` | buy whichever side the market prices below 50¢ |
| `momentum` | if BTC is above the strike, buy YES; if below, buy NO |
| `fair_value(edge>X)` | estimate the probability from BTC's distance to the strike, time left and recent volatility (a random-walk model); buy only if that beats the ask plus fee by more than X |

Entry minutes tried: 1, 3, 5, 7, 10, 12 and 14. Minutes 5 and 10 are the
"every 5 minutes" checkpoints. Kalshi's shortest bitcoin market is 15
minutes, so a bot that checks every 5 minutes acts on these windows.

## Reading the report

1. **Dataset**: market count, date range, average spread and fee at each
   minute. The spread plus the fee is the hurdle any strategy has to clear.
2. **Is the market already priced right?** The market's price compared with
   how often YES actually won. If the two match, a simple strategy has
   nothing to exploit. This section also compares the model's accuracy
   (Brier score) against the market's.
3. **Simple baselines**: every strategy at minutes 1, 5, 10 and 14 over the
   whole sample.
4. **Out-of-sample test**: all 63 combinations are scored on the first half
   of the data. The best one is then run once on the second half, which it
   has never seen. **This row is the one to trust.** The best of 63
   in-sample results will look good by chance alone.
5. **Verdict**: computed from the held-out result. It only says "possible
   edge" when the 95% confidence interval for P&L per contract is above
   zero.

`reports/` also gets a CSV of every held-out trade.

## Options

```sh
python3 -m kalshi_btc fetch --days 60 --data data
python3 -m kalshi_btc backtest --contracts 10 --fee-multiplier 1.0 --train-frac 0.5
```

- `--contracts`: contracts per trade (affects fee rounding; default 10).
- `--fee-multiplier`: set this if Kalshi's fee schedule lists a multiplier
  for the series (default 1).
- `KALSHI_BASE_URL` (environment variable): overrides the API host if Kalshi
  moves it.

## Limitations

- Fills are optimistic: the backtest assumes you get your full size at the
  quoted ask, instantly. Bid/ask snapshots are one per minute, and book depth
  isn't modeled.
- BTC prices come from Coinbase, not the settlement index.
- Even a positive held-out result means "paper-trade this next", not "this
  makes money".

## Testing without network access

```sh
python3 -m unittest discover -s tests
python3 -m kalshi_btc synth --data data-synthetic               # fairly priced fake market
python3 -m kalshi_btc synth --data data-mispriced --vol-mult 2  # market that underreacts
python3 -m kalshi_btc backtest --data data-synthetic
```

On the fairly priced synthetic market, the strategy picked in training loses
money out of sample. On the mispriced one, `fair_value` keeps its edge out of
sample. Together these check that the backtester neither invents an edge nor
misses a real one.
