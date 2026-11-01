const SUPPORTED = new Set(["XAUUSD", "XAGUSD"]);

/**
 * Validates an explicitly user-authorised MT5 Android screen observation.
 * "verified" means the observation passed structural and freshness checks;
 * it does not guarantee the quote remains executable when a user acts.
 */
export function validateBrokerQuoteObservation(
  input,
  {
    now = Date.now(),
    maxAgeMs = 2500,
    futureToleranceMs = 1000,
    expectedSymbol = null
  } = {}
) {
  const reasons = [];
  const source = input?.source;
  const symbol = String(input?.symbol || "").toUpperCase();
  const bid = Number(input?.bid);
  const ask = Number(input?.ask);
  const timestamp = Date.parse(input?.timestamp);
  const ageMs = Number.isFinite(timestamp) ? now - timestamp : Infinity;

  if (source !== "mt5_android") reasons.push("unsupported_broker_quote_source");
  if (!SUPPORTED.has(symbol)) reasons.push("unsupported_symbol");
  if (expectedSymbol && symbol !== String(expectedSymbol).toUpperCase()) reasons.push("broker_quote_symbol_mismatch");
  if (![bid, ask].every(Number.isFinite) || bid <= 0 || ask <= bid) reasons.push("invalid_broker_bid_ask");
  if (!Number.isFinite(timestamp) || ageMs < -futureToleranceMs || ageMs > maxAgeMs) reasons.push("broker_quote_not_fresh");

  const verified = reasons.length === 0;
  const quote = verified ? Object.freeze({
    symbol,
    bid,
    ask,
    mid: Number(((bid + ask) / 2).toFixed(10)),
    spread: Number((ask - bid).toFixed(10)),
    timestamp: new Date(timestamp).toISOString(),
    marketState: null,
    stale: false,
    source: "mt5_android",
    executableForBroker: false
  }) : null;

  return Object.freeze({
    verified,
    status: verified ? "BROKER_QUOTE_VERIFIED" : "BROKER_QUOTE_INVALID",
    source: source === "mt5_android" ? source : null,
    symbol: SUPPORTED.has(symbol) ? symbol : null,
    quoteAgeMs: Number.isFinite(ageMs) ? Math.max(0, ageMs) : null,
    reasons: Object.freeze(reasons),
    quote
  });
}
