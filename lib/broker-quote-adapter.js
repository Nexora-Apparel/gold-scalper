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
  const bid = input?.bid;
  const ask = input?.ask;
  const timestamp = Date.parse(input?.timestamp);
  const ageMs = Number.isFinite(timestamp) ? now - timestamp : Infinity;

  if (source !== "mt5_android") reasons.push("unsupported_broker_quote_source");
  if (!SUPPORTED.has(symbol)) reasons.push("unsupported_symbol");
  if (expectedSymbol && symbol !== String(expectedSymbol).toUpperCase()) reasons.push("broker_quote_symbol_mismatch");
  if (typeof bid !== "number" || typeof ask !== "number" || ![bid, ask].every(Number.isFinite) || bid <= 0 || ask <= bid) reasons.push("invalid_broker_bid_ask");
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


/**
 * Compares an authorised MT5 screen observation with an independent live
 * reference quote. A parity pass is an operator quality gate, not a promise
 * that the broker will fill an order at the observed price.
 *
 * maxMidDeviation is deliberately mandatory: tolerances must be calibrated
 * for the instrument/feed and must never be silently guessed.
 */
export function evaluateBrokerQuoteParity(
  brokerObservation,
  referenceQuote,
  {
    now = Date.now(),
    maxBrokerAgeMs = 2500,
    maxReferenceAgeMs = 1500,
    maxTimestampSkewMs = 2500,
    maxMidDeviation,
    maxSpreadDeviation = null
  } = {}
) {
  const reasons = [];
  const broker = brokerObservation?.quote || brokerObservation || {};
  const brokerTimestamp = Date.parse(brokerObservation?.observedAt || broker.timestamp || brokerObservation?.timestamp);
  const referenceTimestamp = Date.parse(referenceQuote?.timestamp);
  const brokerAgeMs = Number.isFinite(brokerTimestamp) ? now - brokerTimestamp : Infinity;
  const referenceAgeMs = Number.isFinite(referenceTimestamp) ? now - referenceTimestamp : Infinity;
  const timestampSkewMs = Number.isFinite(brokerTimestamp) && Number.isFinite(referenceTimestamp)
    ? Math.abs(brokerTimestamp - referenceTimestamp) : Infinity;
  const brokerBid = Number(broker.bid), brokerAsk = Number(broker.ask);
  const referenceBid = Number(referenceQuote?.bid), referenceAsk = Number(referenceQuote?.ask);
  const brokerMid = (brokerBid + brokerAsk) / 2;
  const referenceMid = (referenceBid + referenceAsk) / 2;
  const brokerSpread = brokerAsk - brokerBid;
  const referenceSpread = referenceAsk - referenceBid;
  const midDeviation = Math.abs(brokerMid - referenceMid);
  const spreadDeviation = Math.abs(brokerSpread - referenceSpread);

  if (!SUPPORTED.has(String(broker.symbol || "").toUpperCase())) reasons.push("unsupported_broker_symbol");
  if (String(broker.symbol || "").toUpperCase() !== String(referenceQuote?.symbol || "").toUpperCase()) reasons.push("reference_symbol_mismatch");
  if (![brokerBid, brokerAsk, referenceBid, referenceAsk].every(Number.isFinite) ||
      brokerBid <= 0 || brokerAsk <= brokerBid || referenceBid <= 0 || referenceAsk <= referenceBid) {
    reasons.push("invalid_parity_bid_ask");
  }
  if (!Number.isFinite(brokerAgeMs) || brokerAgeMs < -1000 || brokerAgeMs > maxBrokerAgeMs) reasons.push("broker_observation_stale");
  if (!Number.isFinite(referenceAgeMs) || referenceAgeMs < -1000 || referenceAgeMs > maxReferenceAgeMs ||
      referenceQuote?.stale === true || referenceQuote?.marketState !== "open") reasons.push("reference_quote_stale_or_closed");
  if (!Number.isFinite(timestampSkewMs) || timestampSkewMs > maxTimestampSkewMs) reasons.push("quote_timestamp_skew_exceeded");
  if (!Number.isFinite(maxMidDeviation) || maxMidDeviation < 0) reasons.push("parity_tolerance_not_configured");
  else if (Number.isFinite(midDeviation) && midDeviation > maxMidDeviation) reasons.push("mid_price_deviation_exceeded");
  if (maxSpreadDeviation !== null &&
      (!Number.isFinite(maxSpreadDeviation) || maxSpreadDeviation < 0 || spreadDeviation > maxSpreadDeviation)) {
    reasons.push("spread_deviation_exceeded");
  }

  const receivedAt = Date.parse(brokerObservation?.receivedAt);
  const ingestionLatencyMs = Number.isFinite(receivedAt) && Number.isFinite(brokerTimestamp)
    ? Math.max(0, receivedAt - brokerTimestamp) : null;
  const passed = reasons.length === 0;
  return Object.freeze({
    passed,
    status: passed ? "BROKER_REFERENCE_PARITY_CONFIRMED" : "BROKER_REFERENCE_PARITY_REJECTED",
    symbol: SUPPORTED.has(String(broker.symbol || "").toUpperCase()) ? String(broker.symbol).toUpperCase() : null,
    brokerAgeMs: Number.isFinite(brokerAgeMs) ? Math.max(0, brokerAgeMs) : null,
    referenceAgeMs: Number.isFinite(referenceAgeMs) ? Math.max(0, referenceAgeMs) : null,
    timestampSkewMs: Number.isFinite(timestampSkewMs) ? timestampSkewMs : null,
    ingestionLatencyMs,
    brokerSpread: Number.isFinite(brokerSpread) ? brokerSpread : null,
    referenceSpread: Number.isFinite(referenceSpread) ? referenceSpread : null,
    spreadDeviation: Number.isFinite(spreadDeviation) ? spreadDeviation : null,
    midDeviation: Number.isFinite(midDeviation) ? midDeviation : null,
    maxMidDeviation: Number.isFinite(maxMidDeviation) ? maxMidDeviation : null,
    reasons: Object.freeze(reasons),
    operatorActionable: passed,
    executableForBroker: false,
    note: "Parity confirms only that the observed prices are within configured tolerances; it does not guarantee a broker fill."
  });
}
