const MINUTE_MS = 60000;

export class HigherTimeframeAggregator {
  constructor({ timeframes = [5, 15], onCandle = () => {} } = {}) {
    this.timeframes = [...new Set(timeframes)];
    if (!this.timeframes.length || this.timeframes.some((n) => ![5, 15].includes(n))) {
      throw new Error("Only M5 and M15 context aggregation is supported.");
    }
    this.onCandle = onCandle;
    this.active = new Map();
    this.completed = new Map();
    this.lastMinute = new Map();
  }

  ingest(m1) {
    if (!m1 || m1.timeframe !== "M1" || m1.complete !== true) {
      throw new Error("Only complete M1 bars may feed higher timeframes.");
    }
    const symbol = String(m1.symbol || "").toUpperCase();
    const timestamp = Date.parse(m1.time);
    if (!symbol || !Number.isFinite(timestamp)) throw new Error("Invalid M1 bar.");
    const results = [];
    const previous = this.lastMinute.get(symbol);
    if (Number.isFinite(previous) && timestamp <= previous) {
      return { accepted: false, reason: "duplicate_or_out_of_order", completed: results };
    }
    for (const minutes of this.timeframes) {
      const span = minutes * MINUTE_MS;
      const bucket = Math.floor(timestamp / span) * span;
      const key = symbol + ":" + minutes;
      let active = this.active.get(key);
      if (!active || bucket > active.bucket) {
        if (active) {
          const finalized = this.finalize(active, minutes, timestamp);
          if (finalized) {
            this.completed.set(key, finalized);
            results.push(finalized);
            this.onCandle(finalized);
          }
        }
        active = {
          symbol, minutes, bucket,
          time: new Date(bucket).toISOString(),
          open: m1.open, high: m1.high, low: m1.low, close: m1.close,
          minuteTimes: [timestamp], tickCount: Number(m1.tickCount) || 0,
          source: "biquote_m1_rollup"
        };
        this.active.set(key, active);
      } else if (bucket === active.bucket) {
        const expectedNext = active.minuteTimes.at(-1) + MINUTE_MS;
        if (timestamp !== expectedNext) {
          active.gapDetected = true;
        }
        active.high = Math.max(active.high, m1.high);
        active.low = Math.min(active.low, m1.low);
        active.close = m1.close;
        active.minuteTimes.push(timestamp);
        active.tickCount += Number(m1.tickCount) || 0;
      }
    }
    this.lastMinute.set(symbol, timestamp);
    return { accepted: true, completed: results };
  }

  finalize(active, minutes, nextTimestamp) {
    const expected = minutes;
    const contiguous = active.minuteTimes.length === expected &&
      active.minuteTimes.every((time, index) => index === 0 || time - active.minuteTimes[index - 1] === MINUTE_MS) &&
      !active.gapDetected;
    if (!contiguous) return null;
    return Object.freeze({
      symbol: active.symbol,
      timeframe: "M" + minutes,
      time: active.time,
      open: active.open, high: active.high, low: active.low, close: active.close,
      source: active.source, provider: "biquote",
      constituentMinutes: active.minuteTimes.length,
      tickCount: active.tickCount,
      complete: true,
      finalizedAt: new Date(nextTimestamp).toISOString()
    });
  }

  getLatestCompleted(symbol, timeframe) {
    return this.completed.get(String(symbol).toUpperCase() + ":" + Number(String(timeframe).replace(/^M/, ""))) || null;
  }
}
