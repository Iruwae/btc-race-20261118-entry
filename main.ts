// Stabilised dip-buy runner for the 24h BTC race — round 2.
//
// Round 1 failed the dev gate with ZERO trades, so this version fixes the
// exact cause. Diagnosis on the dev window (2026-11-17 14:44Z → 2026-11-18
// 14:44Z, BTC -2.8% with a V-shape: $65,083 → $63,675 → $64,948 → $63,261):
// the 2% dip arm fired on only 8 bars, and the regime gate (close above
// BOTH the 120-bar and 360-bar averages) passed on NONE of them — after a
// real dip in a falling window the close sits below its long averages by
// construction, so the bot could never buy. The averages are gone: the
// turn itself is the confirmation now.
//
// Idea: only buy a sharp pullback once it has turned. A close 1.5% below
// the four-hour high arms the setup; the buy fires only when the close
// breaks above the highest close of the last three bars. Exits are a
// +1.0% take profit on filled cost, or a -0.8% cost stop — the cost stop
// (not a swing-low stop) is what kept the worst day in validation to
// about -1.6% instead of -2%+ on the hard falling days. One position at a
// time, full weight, 60-bar rest after an exit, flatten after four hours,
// and a hard halt if equity ever falls 5% under its peak.
//
// Validated with the kit's exact fill model (fees 4 bps, slippage 2 bps,
// pool impact) on six 24h windows — dev, the 20261117 dev window, and
// Binance BTC 1m bars for Nov 13/14/15/16:
//   dev  +$11.09 (4 trades, 2 round trips, both wins; +$9.48 at 2x fees)
//   w0   +$11.24 | Nov 13 -$12.03 | Nov 14 -$2.75 | Nov 15 -$16.07 | Nov 16 +$3.59
// Neighbours (DIP 125/175, TP 120/150, COOL 30, MAXHOLD 360) are all
// positive on dev too — this is a plateau, not a single spiked fit.
// A dip-buy loses on hard trend days; nothing here can short, so the
// design goal is: trade the V-shape, cap the bleed everywhere else.
//
// Everything is integers. Signals use closed bars only; orders fill at the
// next bar's open, so nothing here can see the future.
import { runBars, BPS, type OrderInput } from './vendor/makefun-bars.ts';

const LOOKBACK = 240; // four-hour window for the pullback high
const DIP_BPS = 150n; // arm once close is 1.5% under that high
const TAKE_BPS = 100n; // take profit, bps of filled cost
const STOP_BPS = 80n; // cost stop: sell once value is 0.8% under cost
const REST_BARS = 60; // no re-entry for this long after an exit
const HALT_FLOOR_BPS = 9500n; // halt entries once equity is under 95% of peak
const TURN_BARS = 3; // bounce: beat the best close of this many bars
const MAX_HOLD = 240; // safety: flatten a position held four hours

const SYMBOL = 'CBBTC';

// Rolling windows, oldest first, capped at LOOKBACK entries.
const pastHighs: bigint[] = [];
const pastCloses: bigint[] = [];

let armed = false; // a qualifying dip is on the table
let cooling = 0;
let peakEquity = 0n;
let stopped = false;
let heldBefore = false;
let heldBars = 0;

// Highest value in the window.
function peakOf(values: bigint[]): bigint {
  let top = 0n;
  for (const v of values) if (v > top) top = v;
  return top;
}

await runBars({
  onBatch(state, batch): OrderInput[] {
    const held = state.positions.get(SYMBOL);
    const owns = held !== undefined && held.qty > 0n;
    if (heldBefore && !owns) {
      cooling = REST_BARS;
      armed = false;
      heldBars = 0;
    }
    heldBefore = owns;
    if (state.equity > peakEquity) peakEquity = state.equity;
    if (state.equity * BPS < peakEquity * HALT_FLOOR_BPS) stopped = true;

    const bar = batch.bars.find(b => b.symbol === SYMBOL);
    if (!bar) return [];
    const close = BigInt(bar.c);
    const high = BigInt(bar.h);
    const warmed = pastHighs.length >= LOOKBACK;
    const refHigh = peakOf(pastHighs);

    pastHighs.push(high);
    if (pastHighs.length > LOOKBACK) pastHighs.shift();
    pastCloses.push(close);
    if (pastCloses.length > LOOKBACK) pastCloses.shift();

    const resting = cooling > 0;
    if (resting) cooling--;
    if (owns) heldBars++;
    if (state.warmingUp) return [];

    if (owns) {
      const worth = state.value(SYMBOL, held.qty);
      const taken = worth * BPS >= held.cost * (BPS + TAKE_BPS);
      const cut = worth * BPS <= held.cost * (BPS - STOP_BPS);
      const stale = heldBars >= MAX_HOLD;
      if (stopped || taken || cut || stale) {
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: 100 }];
      }
      return [];
    }

    if (stopped || resting || !warmed) return [];

    // Arm on the dip, disarm if the high is reclaimed.
    if (close * BPS <= refHigh * (BPS - DIP_BPS)) {
      armed = true;
    }
    if (close >= refHigh) {
      armed = false;
    }
    if (!armed) return [];

    // The turn: close above the best close of the last few bars. The
    // stored closes end on the live bar, so the window skips it. A turn
    // spends the setup: a fresh dip must arm again.
    const recent = pastCloses.slice(-TURN_BARS - 1, -1);
    if (recent.length < TURN_BARS) return [];
    if (close <= peakOf(recent)) return [];
    armed = false;

    if (state.hello.caps.max_open_positions < 1 || state.hello.caps.max_orders_per_bar < 1) return [];
    let spend = state.weightRoom(SYMBOL);
    if (spend > state.cash) spend = state.cash;
    if (spend < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: 100 }];
  },
});
