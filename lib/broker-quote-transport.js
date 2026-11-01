import { validateBrokerQuoteObservation } from "./broker-quote-adapter.js";

export function validateBrokerQuoteTransport(input, { now = Date.now(), expectedSymbol = null } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "Quote observation must be an object." };
  }
  const allowedKeys = new Set(["sequence", "source", "symbol", "bid", "ask", "observedAt", "observationMethod"]);
  if (Object.keys(input).some((key) => !allowedKeys.has(key)) || JSON.stringify(input).length > 1024) {
    return { ok: false, error: "Quote observation contains unsupported fields or exceeds 1 KB." };
  }
  const sequence = input.sequence;
  if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 1) {
    return { ok: false, error: "A positive safe-integer sequence is required." };
  }
  const checked = validateBrokerQuoteObservation({
    source: input.source,
    symbol: input.symbol,
    bid: input.bid,
    ask: input.ask,
    timestamp: input.observedAt
  }, { now, maxAgeMs: 2500, futureToleranceMs: 1000, expectedSymbol });
  if (!checked.verified) {
    return { ok: false, error: "Broker quote observation rejected.", reasons: checked.reasons };
  }
  if (input.observationMethod !== "user_authorized_local_mt5_screen_ocr") {
    return { ok: false, error: "Unsupported observation method." };
  }
  return {
    ok: true,
    value: Object.freeze({
      sequence,
      observedAt: checked.quote.timestamp,
      receivedAt: new Date(now).toISOString(),
      source: "mt5_android",
      observationMethod: "user_authorized_local_mt5_screen_ocr",
      rawScreenUploaded: false,
      quote: checked.quote,
      verified: true,
      status: "BROKER_QUOTE_VERIFIED",
      executableForBroker: false
    })
  };
}
