// Stabilised dip-buy runner for the 24h BTC race.
//
// Idea: only buy a sharp pullback once it has turned. A close 2% below the
// six-hour high arms the setup; the buy fires only when the close breaks
// above the highest close of the last three bars, while the tape is still
// above both its two-hour and six-hour averages. Exits are a +1.5% take
// profit on filled cost, or a break 0.3% under the lowest low seen while
// the setup was armed. One position at a time, full weight, 60-bar rest
// after an exit, and a hard halt if equity ever falls 5% under its peak.
//
// Everything is integers. Signals use closed bars only; orders fill at the
// next bar's open, so nothing here can see the future.
import { runBars, BPS, type OrderInput } from './vendor/makefun-bars.ts';

const LOOKBACK = 360; // six-hour window for the pullback high
const DIP_BPS = 200n; // arm once close is 2% under that high
const TAKE_BPS = 150n; // take profit, bps of filled cost
const LOW_GIVE_BPS = 30n; // stop gives 0.3% under the armed swing low
const REST_BARS = 60; // no re-entry for this long after an exit
const HALT_FLOOR_BPS = 9500n; // halt entries once equity is under 95% of peak
const FAST_AVG = 120; // two-hour average for the regime filter
const SLOW_AVG = 360; // six-hour average for the trend gate
const TURN_BARS = 3; // bounce: beat the best close of this many bars
const MAX_HOLD = 720; // safety: flatten a position held twelve hours

const SYMBOL = 'CBBTC';

// Rolling windows, oldest first, capped at LOOKBACK entries.
const pastHighs: bigint[] = [];
const pastCloses: bigint[] = [];

let armed = false; // a qualifying dip is on the table
let swingLow = 0n; // lowest low printed while armed
let exitFloor = 0n; // swing low locked in at entry; the stop hangs under it
let cooling = 0;
let peakEquity = 0n;
let stopped = false;
let heldBefore = false;
let heldBars = 0;

// Mean of the last n stored closes. Callers push the live close first,
// so the window already ends on the current bar.
function average(values: bigint[], n: number): bigint | null {
  if (values.length < n) return null;
  let sum = 0n;
  for (let i = values.length - n; i < values.length; i++) sum += values[i];
  return sum / BigInt(n);
}

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
      swingLow = 0n;
      exitFloor = 0n;
      heldBars = 0;
    }
    heldBefore = owns;
    if (state.equity > peakEquity) peakEquity = state.equity;
    if (state.equity * BPS < peakEquity * HALT_FLOOR_BPS) stopped = true;

    const bar = batch.bars.find(b => b.symbol === SYMBOL);
    if (!bar) return [];
    const close = BigInt(bar.c);
    const high = BigInt(bar.h);
    const low = BigInt(bar.l);
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
      const broken = exitFloor > 0n && close * BPS < exitFloor * (BPS - LOW_GIVE_BPS);
      const stale = heldBars >= MAX_HOLD;
      if (stopped || taken || broken || stale) {
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: 100 }];
      }
      return [];
    }

    if (stopped || resting || !warmed) return [];

    // Arm on the dip, disarm if the high is reclaimed.
    if (close * BPS <= refHigh * (BPS - DIP_BPS)) {
      if (!armed) {
        armed = true;
        swingLow = low;
      }
      if (low < swingLow) swingLow = low;
    }
    if (close >= refHigh) {
      armed = false;
      swingLow = 0n;
    }
    if (!armed) return [];

    // The turn: close above the best close of the last few bars. The
    // stored closes end on the live bar, so the window skips it. A turn
    // spends the setup: if the regime below refuses it, a fresh dip must
    // arm again.
    const recent = pastCloses.slice(-TURN_BARS - 1, -1);
    if (recent.length < TURN_BARS) return [];
    if (close <= peakOf(recent)) return [];
    armed = false;

    // Regime: the tape must still be above both averages.
    const fast = average(pastCloses, FAST_AVG);
    const slow = average(pastCloses, SLOW_AVG);
    if (fast === null || slow === null) return [];
    if (close <= fast || close <= slow) return [];

    if (state.hello.caps.max_open_positions < 1 || state.hello.caps.max_orders_per_bar < 1) return [];
    let spend = state.weightRoom(SYMBOL);
    if (spend > state.cash) spend = state.cash;
    if (spend < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    exitFloor = swingLow;
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: 100 }];
  },
});
