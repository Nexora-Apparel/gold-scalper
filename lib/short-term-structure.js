export class ShortTermStructureDetector {
  constructor({ lookback = 3, maxBars = 30, minBreakoutRangeRatio = 0.35 } = {}) {
    if (!Number.isInteger(lookback) || lookback < 2) throw new Error("lookback must be at least 2.");
    this.lookback = lookback;
    this.maxBars = maxBars;
    this.minBreakoutRangeRatio = minBreakoutRangeRatio;
    this.bars = new Map();
  }

  ingest(candle) {
    if (!candle || candle.timeframe !== "M1" || candle.complete !== true ||
        !["XAUUSD", "XAGUSD"].includes(candle.symbol)) return this.snapshot(candle?.symbol);
    const values = [candle.open, candle.high, candle.low, candle.close].map(Number);
    if (!values.every(Number.isFinite) || values.some(value => value <= 0) ||
        values[1] < Math.max(values[0], values[3]) || values[2] > Math.min(values[0], values[3])) {
      return this.snapshot(candle.symbol);
    }
    const list = this.bars.get(candle.symbol) || [];
    if (list.length && Date.parse(candle.time) <= Date.parse(list.at(-1).time)) return this.snapshot(candle.symbol);
    list.push(candle);
    if (list.length > this.maxBars) list.splice(0, list.length - this.maxBars);
    this.bars.set(candle.symbol, list);
    return this.snapshot(candle.symbol);
  }

  snapshot(symbol) {
    const list = this.bars.get(symbol) || [];
    if (list.length < this.lookback + 1) return Object.freeze({
      symbol, direction: null, strength: 0, ready: false,
      bars: list.length, reason: "insufficient_completed_m1_history"
    });
    const recent = list.slice(-(this.lookback + 1));
    const previous = recent.slice(0, -1);
    const latest = recent.at(-1);
    const averageRange = previous.reduce((sum, bar) => sum + (Number(bar.high) - Number(bar.low)), 0) / previous.length;
    if (!(averageRange > 0)) return Object.freeze({
      symbol, direction: null, strength: 0, ready: false,
      bars: list.length, reason: "zero_reference_range"
    });
    const priorHigh = Math.max(...previous.map(bar => Number(bar.high)));
    const priorLow = Math.min(...previous.map(bar => Number(bar.low)));
    const upBreak = Number(latest.close) > priorHigh;
    const downBreak = Number(latest.close) < priorLow;
    let direction = null, displacement = 0, reason = "no_confirmed_structure_break";
    if (upBreak) {
      direction = "UP"; displacement = Number(latest.close) - priorHigh; reason = "m1_close_broke_prior_swing_high";
    } else if (downBreak) {
      direction = "DOWN"; displacement = priorLow - Number(latest.close); reason = "m1_close_broke_prior_swing_low";
    } else {
      const a = previous.at(-1), b = previous.at(-2);
      if (b && Number(a.high) > Number(b.high) && Number(a.low) > Number(b.low) &&
          Number(latest.high) > Number(a.high) && Number(latest.low) > Number(a.low)) {
        direction = "UP"; displacement = Number(latest.close) - Number(latest.open); reason = "higher_high_higher_low_sequence";
      } else if (b && Number(a.high) < Number(b.high) && Number(a.low) < Number(b.low) &&
          Number(latest.high) < Number(a.high) && Number(latest.low) < Number(a.low)) {
        direction = "DOWN"; displacement = Number(latest.open) - Number(latest.close); reason = "lower_high_lower_low_sequence";
      }
    }
    const strength = direction ? Math.max(0, Math.min(1, Math.abs(displacement) / averageRange)) : 0;
    const ready = Boolean(direction) && strength >= this.minBreakoutRangeRatio;
    return Object.freeze({
      symbol, direction: ready ? direction : null, candidateDirection: direction,
      strength: Number(strength.toFixed(3)), ready, bars: list.length,
      averageRange, priorHigh, priorLow, latestClose: Number(latest.close), reason
    });
  }

  clear(symbol) {
    if (symbol) this.bars.delete(symbol);
    else this.bars.clear();
  }
}
