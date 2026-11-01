import { normalizeBiquoteTick, VELTRIX_SYMBOLS } from "./biquote-market-data.js";

const DEFAULT_WATCHDOG_MS = 2000;
const DEFAULT_MAX_AGE_MS = 5000;

/**
 * Owns the VELTRIX subscription lifecycle for an injected SignalR HubConnection.
 * Create the connection with @microsoft/signalr HubConnectionBuilder and
 * withAutomaticReconnect(); this module remains transport-agnostic and testable.
 */
export class BiquoteTickStream {
  constructor({
    connection,
    symbols = VELTRIX_SYMBOLS,
    onTick = () => {},
    onStatus = () => {},
    onError = () => {},
    now = () => Date.now(),
    maxAgeMs = DEFAULT_MAX_AGE_MS,
    watchdogMs = DEFAULT_WATCHDOG_MS
  } = {}) {
    if (!connection || typeof connection.start !== "function" ||
        typeof connection.on !== "function" || typeof connection.invoke !== "function") {
      throw new TypeError("A SignalR HubConnection is required.");
    }
    const requested = [...new Set(symbols.map((value) => String(value).toUpperCase()))];
    if (!requested.length || requested.some((symbol) => !VELTRIX_SYMBOLS.includes(symbol))) {
      throw new Error("Only XAUUSD and XAGUSD are enabled for VELTRIX LIVE.");
    }
    this.connection = connection;
    this.symbols = requested;
    this.onTick = onTick;
    this.onStatus = onStatus;
    this.onError = onError;
    this.now = now;
    this.maxAgeMs = maxAgeMs;
    this.watchdogMs = watchdogMs;
    this.lastTickAt = new Map();
    this.latest = new Map();
    this.timer = null;
    this.started = false;
    this.stopped = false;
    this.subscribed = false;
    this.handleTick = this.handleTick.bind(this);
    this.handleReconnect = this.handleReconnect.bind(this);
    this.handleClose = this.handleClose.bind(this);
  }

  emitStatus(state, details = {}) {
    this.onStatus(Object.freeze({
      provider: "biquote",
      state,
      connected: this.connection.state === "Connected",
      symbols: [...this.symbols],
      at: new Date(this.now()).toISOString(),
      ...details
    }));
  }

  handleTick(payload) {
    const symbol = String(payload?.symbol || "").toUpperCase();
    if (!this.symbols.includes(symbol)) return;
    try {
      const quote = normalizeBiquoteTick(payload, {
        symbol,
        now: this.now(),
        maxAgeMs: this.maxAgeMs
      });
      this.latest.set(symbol, quote);
      this.lastTickAt.set(symbol, this.now());
      this.onTick(quote);
    } catch (error) {
      this.onError(error, { symbol, source: "tick-validation" });
      this.emitStatus("degraded", { symbol, reason: error.message });
    }
  }

  async subscribe() {
    await this.connection.invoke("Subscribe", this.symbols);
    this.subscribed = true;
    this.emitStatus("streaming");
  }

  async handleReconnect() {
    if (this.stopped) return;
    this.subscribed = false;
    this.emitStatus("reconnecting");
    try {
      await this.subscribe();
    } catch (error) {
      this.onError(error, { source: "resubscribe" });
      this.emitStatus("degraded", { reason: "Resubscription failed." });
    }
  }

  handleClose(error) {
    this.subscribed = false;
    if (this.stopped) return;
    if (error) this.onError(error, { source: "connection-close" });
    this.emitStatus("disconnected", { reason: error?.message || "SignalR connection closed." });
  }

  checkFreshness() {
    const now = this.now();
    const staleSymbols = this.symbols.filter((symbol) => {
      const last = this.lastTickAt.get(symbol);
      return !last || now - last > this.maxAgeMs;
    });
    if (staleSymbols.length) {
      this.emitStatus("stale", { staleSymbols });
      return false;
    }
    this.emitStatus("streaming");
    return true;
  }

  async start() {
    if (this.started && !this.stopped) return;
    this.stopped = false;
    this.connection.on("ReceiveTick", this.handleTick);
    this.connection.onreconnected?.(this.handleReconnect);
    this.connection.onclose?.(this.handleClose);
    try {
      if (this.connection.state !== "Connected") await this.connection.start();
      await this.subscribe();
      this.started = true;
      this.timer = setInterval(() => this.checkFreshness(), this.watchdogMs);
      this.timer.unref?.();
    } catch (error) {
      this.onError(error, { source: "connection-start" });
      this.emitStatus("error", { reason: error.message });
      throw error;
    }
  }

  getLatest(symbol) {
    return this.latest.get(String(symbol).toUpperCase()) || null;
  }

  getSnapshot() {
    const quotes = {};
    for (const symbol of this.symbols) quotes[symbol] = this.getLatest(symbol);
    return Object.freeze({
      provider: "biquote",
      connected: this.connection.state === "Connected",
      subscribed: this.subscribed,
      fresh: this.checkFreshness(),
      quotes: Object.freeze(quotes)
    });
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.connection.off?.("ReceiveTick", this.handleTick);
    try {
      if (this.subscribed && this.connection.state === "Connected") {
        await this.connection.invoke("Unsubscribe", this.symbols);
      }
    } catch (error) {
      this.onError(error, { source: "unsubscribe" });
    }
    this.subscribed = false;
    if (this.connection.state === "Connected") await this.connection.stop();
    this.started = false;
    this.emitStatus("stopped");
  }
}
