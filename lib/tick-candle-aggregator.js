import { VELTRIX_SYMBOLS } from "./biquote-market-data.js";

function minuteStart(timestamp) {
  const value = Date.parse(timestamp);
  if (!Number.isFinite(value)) throw new Error("Invalid tick timestamp.");
  return Math.floor(value / 60000) * 60000;
}

export class TickCandleAggregator {
  constructor({ symbols = VELTRIX_SYMBOLS, onCandle = () => {}, maxOutOfOrderMs = 2000 } = {}) {
    this.symbols = [...new Set(symbols.map((s) => String(s).toUpperCase()))];
    if (!this.symbols.length || this.symbols.some((s) => !VELTRIX_SYMBOLS.includes(s))) {
      throw new Error("Unsupported aggregation symbol.");
    }
    this.onCandle = onCandle;
    this.maxOutOfOrderMs = maxOutOfOrderMs;
    this.current = new Map();
    this.completed = new Map();
    this.lastTimestamp = new Map();
  }

  ingest(quote) {
    const symbol = String(quote?.symbol || "").toUpperCase();
    if (!this.symbols.includes(symbol)) throw new Error("Unexpected symbol.");
    const timestamp = Date.parse(quote.timestamp);
    const price = Number(quote.mid);
    if (!Number.isFinite(timestamp) || !Number.isFinite(price) || price <= 0) {
      throw new Error("Invalid normalized quote.");
    }
    const bucket = minuteStart(quote.timestamp);
    const previousTimestamp = this.lastTimestamp.get(symbol);
    const active = this.current.get(symbol);
    if (active && bucket < active.bucket) return { accepted: false, reason: "closed_minute" };
    if (Number.isFinite(previousTimestamp) && timestamp < previousTimestamp - this.maxOutOfOrderMs) {
      return { accepted: false, reason: "out_of_order" };
    }

    if (!active || bucket > active.bucket) {
      if (active) {
        const candle = this.finalize(symbol, active);
        this.completed.set(symbol, candle);
        this.onCandle(candle);
      }
      this.current.set(symbol, {
        bucket, time: new Date(bucket).toISOString(),
        open: price, high: price, low: price, close: price,
        tickCount: 1, firstTickAt: quote.timestamp, lastTickAt: quote.timestamp,
        spreadSum: Number(quote.spread) || 0,
        maxSpread: Number(quote.spread) || 0
      });
    } else {
      active.high = Math.max(active.high, price);
      active.low = Math.min(active.low, price);
      if (timestamp < Date.parse(active.firstTickAt)) {
        active.open = price;
        active.firstTickAt = quote.timestamp;
      }
      if (timestamp >= Date.parse(active.lastTickAt)) {
        active.close = price;
        active.lastTickAt = quote.timestamp;
      }
      active.tickCount += 1;
      const spread = Number(quote.spread) || 0;
      active.spreadSum += spread;
      active.maxSpread = Math.max(active.maxSpread, spread);
    }
    this.lastTimestamp.set(symbol, Math.max(previousTimestamp || 0, timestamp));
    return { accepted: true, candle: this.snapshot(symbol) };
  }

  finalize(symbol, candle) {
    return Object.freeze({
      symbol, timeframe: "M1", time: candle.time,
      open: candle.open, high: candle.high, low: candle.low, close: candle.close,
      tickCount: candle.tickCount,
      firstTickAt: candle.firstTickAt, lastTickAt: candle.lastTickAt,
      averageSpread: candle.spreadSum / candle.tickCount,
      maxSpread: candle.maxSpread,
      source: "biquote_ticks",
      provider: "biquote",
      complete: true
    });
  }

  snapshot(symbol) {
    const candle = this.current.get(String(symbol).toUpperCase());
    if (!candle) return null;
    return Object.freeze({
      symbol: String(symbol).toUpperCase(), timeframe: "M1",
      time: candle.time, open: candle.open, high: candle.high,
      low: candle.low, close: candle.close, tickCount: candle.tickCount,
      complete: false, source: "biquote_ticks", provider: "biquote"
    });
  }

  getLatestCompleted(symbol) {
    return this.completed.get(String(symbol).toUpperCase()) || null;
  }

  flush() {
    const result = [];
    for (const [symbol, candle] of this.current) {
      const partial = Object.freeze({
        ...this.finalize(symbol, candle),
        complete: false,
        partial: true,
        closeReason: "stream_stopped_before_minute_rollover"
      });
      result.push(partial);
      this.current.delete(symbol);
      this.onCandle(partial);
    }
    return result;
  }
}

export { minuteStart };
