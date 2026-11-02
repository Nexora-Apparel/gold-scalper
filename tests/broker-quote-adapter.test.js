import test from "node:test";
import assert from "node:assert/strict";
import { validateBrokerQuoteObservation } from "../lib/broker-quote-adapter.js";

const now = Date.parse("2026-11-01T10:00:00.000Z");
const valid = {
  source: "mt5_android",
  symbol: "XAUUSD",
  bid: 2650.1,
  ask: 2650.3,
  timestamp: new Date(now).toISOString()
};

test("accepts a fresh supported MT5 Android Bid/Ask observation", () => {
  const result = validateBrokerQuoteObservation(valid, { now, expectedSymbol: "XAUUSD" });
  assert.equal(result.verified, true);
  assert.equal(result.status, "BROKER_QUOTE_VERIFIED");
  assert.equal(result.quote.bid, 2650.1);
  assert.equal(result.quote.ask, 2650.3);
  assert.equal(result.quote.spread, 0.2);
  assert.equal(result.quote.marketState, null);
  assert.equal(result.quote.executableForBroker, false);
});

test("rejects observations from unapproved sources and unsupported symbols", () => {
  const source = validateBrokerQuoteObservation({ ...valid, source: "biquote" }, { now });
  assert.equal(source.verified, false);
  assert.ok(source.reasons.includes("unsupported_broker_quote_source"));
  const symbol = validateBrokerQuoteObservation({ ...valid, symbol: "BTCUSD" }, { now });
  assert.ok(symbol.reasons.includes("unsupported_symbol"));
});

test("rejects mismatched expected instrument and malformed prices", () => {
  const mismatch = validateBrokerQuoteObservation(valid, { now, expectedSymbol: "XAGUSD" });
  assert.ok(mismatch.reasons.includes("broker_quote_symbol_mismatch"));
  const malformed = validateBrokerQuoteObservation({ ...valid, ask: valid.bid }, { now });
  assert.ok(malformed.reasons.includes("invalid_broker_bid_ask"));
});

test("rejects stale and excessively future-dated observations", () => {
  const stale = validateBrokerQuoteObservation({ ...valid, timestamp: new Date(now - 2501).toISOString() }, { now });
  assert.ok(stale.reasons.includes("broker_quote_not_fresh"));
  const future = validateBrokerQuoteObservation({ ...valid, timestamp: new Date(now + 1001).toISOString() }, { now });
  assert.ok(future.reasons.includes("broker_quote_not_fresh"));
});

test("rejects string-coerced, non-finite and non-positive prices", () => {
  assert.equal(validateBrokerQuoteObservation({ ...valid, bid: String(valid.bid) }, { now }).verified, false);
  for (const bid of [NaN, Infinity, 0, -1]) {
    const result = validateBrokerQuoteObservation({ ...valid, bid }, { now });
    assert.equal(result.verified, false);
    assert.ok(result.reasons.includes("invalid_broker_bid_ask"));
  }
});


import { evaluateBrokerQuoteParity } from "../lib/broker-quote-adapter.js";

test("confirms parity only when fresh MT5 and reference quotes meet configured tolerances", () => {
  const broker = {
    observedAt: new Date(now).toISOString(),
    receivedAt: new Date(now + 120).toISOString(),
    quote: { symbol: "XAUUSD", bid: 2650.1, ask: 2650.3 }
  };
  const reference = {
    symbol: "XAUUSD", bid: 2650.11, ask: 2650.31,
    timestamp: new Date(now).toISOString(), marketState: "open", stale: false
  };
  const result = evaluateBrokerQuoteParity(broker, reference, {
    now: now + 200, maxMidDeviation: 0.05, maxSpreadDeviation: 0.01
  });
  assert.equal(result.passed, true);
  assert.equal(result.operatorActionable, true);
  assert.equal(result.executableForBroker, false);
  assert.equal(result.ingestionLatencyMs, 120);
  assert.equal(result.midDeviation, 0.01);
});

test("fails closed when tolerance is missing, quote is stale, or prices diverge", () => {
  const broker = {
    observedAt: new Date(now).toISOString(),
    quote: { symbol: "XAGUSD", bid: 31.1, ask: 31.12 }
  };
  const reference = {
    symbol: "XAGUSD", bid: 31.3, ask: 31.32,
    timestamp: new Date(now).toISOString(), marketState: "open", stale: false
  };
  const missingTolerance = evaluateBrokerQuoteParity(broker, reference, { now });
  assert.equal(missingTolerance.passed, false);
  assert.ok(missingTolerance.reasons.includes("parity_tolerance_not_configured"));
  const divergence = evaluateBrokerQuoteParity(broker, reference, { now, maxMidDeviation: 0.05 });
  assert.ok(divergence.reasons.includes("mid_price_deviation_exceeded"));
  const stale = evaluateBrokerQuoteParity(broker, { ...reference, timestamp: new Date(now - 2000).toISOString() }, {
    now, maxMidDeviation: 0.5
  });
  assert.ok(stale.reasons.includes("reference_quote_stale_or_closed"));
});
