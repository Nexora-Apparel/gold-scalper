const SUPPORTED = new Set(["XAUUSD", "XAGUSD"]);

/**
 * Deterministic pre-signal market-quality gate.
 * This module never emits BUY/SELL instructions; it only reports whether
 * the current quote/microstructure window is suitable for downstream analysis.
 */
export function evaluateScalpingMarketState({
  quote,
  shortWindow,
  contextWindow,
  now = Date.now(),
  maxQuoteAgeMs = 1500,
  minSamples = 3,
  minTicksPerSecond = 0.2,
  maxSpreadMultiple = 2.5,
  brokerQuoteVerification = null,
  quietMovePercent = 0.002,
  expandedMovePercent = 0.02,
  spikeMovePercent = 0.05
} = {}) {
  const reasons = [];
  const symbol = String(quote?.symbol || "").toUpperCase();
  const timestamp = Date.parse(quote?.timestamp);
  const bid = Number(quote?.bid), ask = Number(quote?.ask), mid = Number(quote?.mid);
  const spread = Number(quote?.spread);
  const ageMs = Number.isFinite(timestamp) ? now - timestamp : Infinity;

  if (!SUPPORTED.has(symbol)) reasons.push("unsupported_symbol");
  if (!Number.isFinite(timestamp) || ageMs < -1000 || ageMs > maxQuoteAgeMs) reasons.push("quote_not_fresh");
  if (quote?.marketState !== "open" || quote?.stale === true) reasons.push("market_not_live");
  const brokerQuoteVerified = brokerQuoteVerification?.verified === true &&
    brokerQuoteVerification?.status === "BROKER_QUOTE_VERIFIED" &&
    brokerQuoteVerification?.source === "mt5_android" &&
    brokerQuoteVerification?.symbol === symbol;
  if (!brokerQuoteVerified) reasons.push("broker_quote_not_verified");
  if (![bid, ask, mid, spread].every(Number.isFinite) || !(bid > 0 && ask > bid && mid > 0 && spread >= 0)) {
    reasons.push("invalid_quote");
  } else {
    const midpointTolerance = Math.max(0.000001, (ask - bid) * 0.02);
    if (mid < bid - midpointTolerance || mid > ask + midpointTolerance) reasons.push("mid_outside_bid_ask");
  }

  const shortReady = shortWindow?.ready === true &&
    Number(shortWindow.sampleCount) >= minSamples &&
    Number(shortWindow.ticksPerSecond) >= minTicksPerSecond;
  const contextReady = contextWindow?.ready === true &&
    Number(contextWindow.sampleCount) >= minSamples;
  if (!shortReady) reasons.push("short_window_not_ready");
  if (!contextReady) reasons.push("context_window_not_ready");

  const baselineSpread = Number(contextWindow?.averageSpread);
  const spreadMultiple = baselineSpread > 0 ? spread / baselineSpread : null;
  if (spreadMultiple !== null && spreadMultiple > maxSpreadMultiple) {
    reasons.push("spread_anomaly");
  }

  const shortMove = Number(shortWindow?.priceChangePercent);
  const contextMove = Number(contextWindow?.priceChangePercent);
  const absoluteMove = Math.max(
    Number.isFinite(shortMove) ? Math.abs(shortMove) : 0,
    Number.isFinite(contextMove) ? Math.abs(contextMove) : 0
  );
  const volatilityRegime = absoluteMove >= spikeMovePercent ? "SPIKE"
    : absoluteMove >= expandedMovePercent ? "EXPANDED"
    : absoluteMove <= quietMovePercent ? "QUIET" : "NORMAL";

  const alignedMomentum = Number.isFinite(shortMove) && Number.isFinite(contextMove) &&
    Math.sign(shortMove) !== 0 && Math.sign(shortMove) === Math.sign(contextMove);
  const momentumDirection = alignedMomentum
    ? (shortMove > 0 ? "UP" : "DOWN")
    : "UNALIGNED";

  return Object.freeze({
    symbol: SUPPORTED.has(symbol) ? symbol : null,
    ready: reasons.length === 0,
    reasons: Object.freeze(reasons),
    quoteAgeMs: Number.isFinite(ageMs) ? Math.max(0, ageMs) : null,
    brokerQuoteVerified,
    spread,
    baselineSpread: Number.isFinite(baselineSpread) ? baselineSpread : null,
    spreadMultiple,
    shortMovePercent: Number.isFinite(shortMove) ? shortMove : null,
    contextMovePercent: Number.isFinite(contextMove) ? contextMove : null,
    momentumDirection,
    volatilityRegime,
    signalGenerationEnabled: false
  });
}
