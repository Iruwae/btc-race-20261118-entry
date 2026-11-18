# btc-race-20261118-entry

[![make.fun - btc-race-24h-20261118-1444](https://make.fun/badge/btc-race-24h-20261118-1444.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)

A stabilised dip-buy bot for cbBTC. It waits for a sharp pullback, then
buys only once the price has turned back up — never a falling knife.

## How it trades

- **Arm:** the close falls 2% below the highest high of the last 360
  bars (six hours). The lowest low printed while armed becomes the stop
  anchor.
- **Buy:** the close breaks above the best close of the last three bars,
  while the close is still above its 120-bar and 360-bar averages.
  Full weight, one position at a time.
- **Sell:** +1.5% take profit on the filled cost, or a close 0.3% under
  the armed swing low, or a twelve-hour hold cap. A 5% equity drawdown
  halts entries for good. After an exit, no re-entry for 60 bars.
- Orders fill at the next bar's open with a 100-bps slippage cap. All
  maths is integer; only closed bars are read, so there is no look-ahead.

## Why this shape

Yesterday's race (20261117) settled the question. The breakout runner
that looked great in development (+25.5 on its dev day) finished
-28.4 live, rank #4104 of 4,387: the window was range-bound and every
breakout got faked out. The top six all bought dips, with four trades
and drawdowns around 0.64%. But not every dip-buy won — shallow
pullback entries bled on the down day. So this bot only takes deep
dips (2%), only after the turn, and only while the longer averages
still hold. It trades rarely on purpose.

## Local validation

Same fill model as the tune lab, four separate 24-hour windows
(1-minute bars, fees, slippage and pool impact included):

| Window | Regime | Net PnL (USDC) | Round trips | Max drawdown |
| --- | --- | ---: | ---: | ---: |
| 2026-11-16 dev (kit data) | +0.49% | 0.00 | 0 | 0.00% |
| 2026-11-17 live race window | -0.96% | +13.53 | 1 | 0.70% |
| 2026-11-15 | +0.36% | 0.00 | 0 | 0.00% |
| 2026-11-14 | -4.26% | +18.40 | 1 | 0.46% |

Mean +7.98, worst window 0.00, worst drawdown 0.70%. No window loses.
The per-trade economics (+13.5 net per winning round trip, drawdown
~0.7%) match the live winners' profile; the trade count is lower
(one round trip per window instead of two), so the honest expectation
for the new race is roughly 0 to +15, not a guaranteed top-ten finish.

## Run it

Use Node with native TypeScript stripping and feed the replay protocol
on stdin:

```sh
node /bot/main.ts
```

From the kit directory:

```sh
node cli/makefun.mjs grade-local --kit . --bot /path/to/btc-race-20261118-entry --driver process
```

MIT licensed. [Join make.fun](https://make.fun/?ref=817k0hr2).
