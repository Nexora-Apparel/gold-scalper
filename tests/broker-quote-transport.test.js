import test from "node:test";
import assert from "node:assert/strict";
import { validateBrokerQuoteTransport } from "../lib/broker-quote-transport.js";

const now = Date.parse("2026-11-01T10:00:00.000Z");
const valid = {
  sequence: 1,
  source: "mt5_android",
  symbol: "XAUUSD",
  bid: 2650.1,
  ask: 2650.3,
  observedAt: new Date(now).toISOString(),
  observationMethod: "user_authorized_local_mt5_screen_ocr"
};

test("accepts fresh sequenced local MT5 observation", () => {
  const result = validateBrokerQuoteTransport(valid, { now, expectedSymbol: "XAUUSD" });
  assert.equal(result.ok, true);
  assert.equal(result.value.sequence, 1);
  assert.equal(result.value.status, "BROKER_QUOTE_VERIFIED");
  assert.equal(result.value.quote.spread, 0.2);
  assert.equal(result.value.executableForBroker, false);
});

test("rejects replay sequence values and unsupported observation method", () => {
  assert.equal(validateBrokerQuoteTransport({ ...valid, sequence: 0 }, { now }).ok, false);\n  assert.equal(validateBrokerQuoteTransport({ ...valid, sequence: "1" }, { now }).ok, false);\n  assert.equal(validateBrokerQuoteTransport({ ...valid, unexpected: "field" }, { now }).ok, false);
  assert.equal(validateBrokerQuoteTransport({ ...valid, observationMethod: "manual_entry" }, { now }).ok, false);
});

test("rejects stale, malformed and wrong-symbol observations", () => {
  assert.equal(validateBrokerQuoteTransport({ ...valid, observedAt: new Date(now - 2501).toISOString() }, { now }).ok, false);
  assert.equal(validateBrokerQuoteTransport({ ...valid, ask: valid.bid }, { now }).ok, false);
  assert.equal(validateBrokerQuoteTransport(valid, { now, expectedSymbol: "XAGUSD" }).ok, false);
});
