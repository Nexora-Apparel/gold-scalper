import { createBiquoteConnection } from "./biquote-signalr-connection.js";
import { fetchBiquoteQuotes } from "./biquote-market-data.js";
import { BiquoteTickStream } from "./biquote-tick-stream.js";
import { TickCandleAggregator } from "./tick-candle-aggregator.js";
import { MicrostructureWindow } from "./microstructure-window.js";

export class BiquoteLiveEngine {
  constructor({
    connection = createBiquoteConnection(),
    onQuote = () => {},
    onCandle = () => {},
    onMicrostructure = () => {},
    onStatus = () => {},
    onError = () => {},
    now = () => Date.now(),
    fetchSnapshot = fetchBiquoteQuotes
  } = {}) {
    this.onQuote = onQuote;
    this.onCandle = onCandle;
    this.onMicrostructure = onMicrostructure;
    this.windows = new Map(["XAUUSD", "XAGUSD"].map((symbol) => [symbol, {
      short: new MicrostructureWindow({ windowMs: 5000 }),
      context: new MicrostructureWindow({ windowMs: 15000 })
    }]));
    this.onStatus = onStatus;
    this.onError = onError;
    this.fetchSnapshot = fetchSnapshot;
    this.bootstrapQuotes = {};
    this.aggregator = new TickCandleAggregator({ onCandle });
    this.stream = new BiquoteTickStream({
      connection,
      now,
      onTick: (quote) => {
        this.onQuote(quote);
        const windows = this.windows.get(quote.symbol);
        windows.short.push(quote);
        windows.context.push(quote);
        this.onMicrostructure({
          symbol: quote.symbol,
          short: windows.short.snapshot(this.now()),
          context: windows.context.snapshot(this.now())
        });
        const result = this.aggregator.ingest(quote);
        if (!result.accepted) this.onStatus({
          state: "tick_rejected", symbol: quote.symbol, reason: result.reason
        });
      },
      onStatus,
      onError
    });
  }

  async start() {
    // REST is a best-effort display/bootstrap snapshot only; it never creates M1 bars.
    try {
      const snapshot = await this.fetchSnapshot();
      this.bootstrapQuotes = snapshot.quotes || {};
      for (const quote of Object.values(this.bootstrapQuotes)) this.onQuote(quote);
      this.onStatus({ state: "snapshot_ready", provider: "biquote", symbols: Object.keys(this.bootstrapQuotes) });
    } catch (error) {
      this.onError(error, { source: "rest-bootstrap" });
      this.onStatus({ state: "snapshot_unavailable", provider: "biquote", failClosed: true });
    }
    return this.stream.start();
  }

  getStatus() {
    const snapshot = this.stream.getSnapshot();
    return Object.freeze({
      ...snapshot,
      bootstrapQuotes: Object.freeze({ ...this.bootstrapQuotes }),
      microstructure: Object.freeze(Object.fromEntries([...this.windows].map(([symbol, windows]) => [
        symbol, Object.freeze({ short: windows.short.snapshot(), context: windows.context.snapshot() })
      ]))),
      candles: Object.freeze({
        XAUUSD: this.aggregator.snapshot("XAUUSD"),
        XAGUSD: this.aggregator.snapshot("XAGUSD")
      }),
      executionEnabled: false,
      signalGenerationEnabled: false
    });
  }

  stop() { return this.stream.stop(); }
}
