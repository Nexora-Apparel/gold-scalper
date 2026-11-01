export class MicrostructureWindow {
  constructor({ windowMs = 5000, maxTicks = 500 } = {}) {
    if (!Number.isFinite(windowMs) || windowMs < 250) throw new Error("windowMs must be at least 250ms.");
    if (!Number.isInteger(maxTicks) || maxTicks < 2) throw new Error("maxTicks must be at least 2.");
    this.windowMs = windowMs;
    this.maxTicks = maxTicks;
    this.ticks = [];
  }

  push(quote) {
    const timestamp = Date.parse(quote?.timestamp);
    const mid = Number(quote?.mid);
    const spread = Number(quote?.spread);
    if (!Number.isFinite(timestamp) || !Number.isFinite(mid) || mid <= 0 ||
        !Number.isFinite(spread) || spread < 0) {
      throw new Error("Microstructure input must be a normalized quote.");
    }
    const last = this.ticks.at(-1);
    if (last && timestamp < last.timestamp) return false;
    this.ticks.push({ timestamp, mid, spread });
    this.prune(timestamp);
    if (this.ticks.length > this.maxTicks) this.ticks.splice(0, this.ticks.length - this.maxTicks);
    return true;
  }

  prune(now = Date.now()) {
    const cutoff = now - this.windowMs;
    while (this.ticks.length > 1 && this.ticks[0].timestamp < cutoff) this.ticks.shift();
  }

  snapshot(now = Date.now()) {
    this.prune(now);
    if (!this.ticks.length) return Object.freeze({
      ready: false, sampleCount: 0, windowMs: this.windowMs
    });
    const first = this.ticks[0], last = this.ticks.at(-1);
    const spreads = this.ticks.map((tick) => tick.spread);
    const mean = spreads.reduce((sum, value) => sum + value, 0) / spreads.length;
    const variance = spreads.reduce((sum, value) => sum + (value - mean) ** 2, 0) / spreads.length;
    const elapsedMs = Math.max(0, last.timestamp - first.timestamp);
    const priceChange = last.mid - first.mid;
    return Object.freeze({
      ready: this.ticks.length >= 2 && elapsedMs > 0,
      sampleCount: this.ticks.length,
      windowMs: this.windowMs,
      firstTimestamp: new Date(first.timestamp).toISOString(),
      lastTimestamp: new Date(last.timestamp).toISOString(),
      latestMid: last.mid,
      priceChange,
      priceChangePercent: first.mid ? priceChange / first.mid * 100 : null,
      ticksPerSecond: elapsedMs > 0 ? (this.ticks.length - 1) / (elapsedMs / 1000) : 0,
      averageSpread: mean,
      maxSpread: Math.max(...spreads),
      spreadStdDev: Math.sqrt(variance),
      quoteAgeMs: Math.max(0, now - last.timestamp)
    });
  }

  clear() { this.ticks.length = 0; }
}
