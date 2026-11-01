import { createBiquoteConnection } from "./biquote-signalr-connection.js";
import { BiquoteTickStream } from "./biquote-tick-stream.js";
import { TickCandleAggregator } from "./tick-candle-aggregator.js";

export class BiquoteLiveEngine {
  constructor({
    connection = createBiquoteConnection(),
    onQuote = () => {},
    onCandle = () => {},
    onStatus = () => {},
    onError = () => {},
    now = () => Date.now()
  } = {}) {
    this.onQuote = onQuote;
    this.onCandle = onCandle;
    this.onStatus = onStatus;
    this.onError = onError;
    this.aggregator = new TickCandleAggregator({ onCandle });
    this.stream = new BiquoteTickStream({
      connection,
      now,
      onTick: (quote) => {
        this.onQuote(quote);
        const result = this.aggregator.ingest(quote);
        if (!result.accepted) this.onStatus({
          state: "tick_rejected", symbol: quote.symbol, reason: result.reason
        });
      },
      onStatus,
      onError
    });
  }

  start() { return this.stream.start(); }

  getStatus() {
    const snapshot = this.stream.getSnapshot();
    return Object.freeze({
      ...snapshot,
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
