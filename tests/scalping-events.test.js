import test from "node:test";
import assert from "node:assert/strict";
import { validateScalpingEvent, validateScalpingEventBatch, summarizeScalpingEvents } from "../lib/scalping-events.js";

test("validates and normalizes a scalping event", () => {
  const result = validateScalpingEvent({ eventId: "evt-1", type: "signal", symbol: "xauusd", side: "BUY", payload: { confidence: 0.81 } });
  assert.equal(result.ok, true);
  assert.equal(result.value.type, "SIGNAL");
  assert.equal(result.value.symbol, "XAUUSD");
});
test("accepts MT5 spread observations as auditable journal events", () => {
  const result = validateScalpingEvent({ eventId: "spread-1", type: "MT5_SPREAD_OBSERVED", symbol: "XAUUSD", payload: { bid: 4172.5, ask: 4172.7, spreadPriceDelta: 0.2, spreadUnit: "raw_price_delta" } });
  assert.equal(result.ok, true);
});
test("rejects unknown types, symbols, future timestamps and oversized payloads", () => {
  const base = { eventId: "evt", type: "SIGNAL", symbol: "XAUUSD" };
  assert.equal(validateScalpingEvent({ ...base, type: "TICK" }).ok, false);
  assert.equal(validateScalpingEvent({ ...base, symbol: "BTCUSD" }).ok, false);
  assert.equal(validateScalpingEvent({ ...base, occurredAt: new Date(Date.now() + 120000).toISOString() }).ok, false);
  assert.equal(validateScalpingEvent({ ...base, payload: { text: "x".repeat(13000) } }).ok, false);
});
test("validates batches atomically and rejects duplicate IDs", () => {
  assert.equal(validateScalpingEventBatch([{ eventId: "a", type: "NO_TRADE", symbol: "XAUUSD" }, { eventId: "b", type: "FEED_ERROR", symbol: "XAGUSD" }]).value.length, 2);
  assert.equal(validateScalpingEventBatch([{ eventId: "a", type: "NO_TRADE", symbol: "XAUUSD" }, { eventId: "a", type: "SIGNAL", symbol: "XAUUSD" }]).ok, false);
  assert.equal(validateScalpingEventBatch([{ eventId: "a", type: "NO_TRADE", symbol: "XAUUSD" }, { eventId: "b", type: "INVALID", symbol: "XAUUSD" }]).ok, false);
});
test("summarizes closed positions separately from signals", () => {
  const result = summarizeScalpingEvents([{ type: "SIGNAL" }, { type: "POSITION_CLOSED" }, { type: "POSITION_CLOSED" }, { type: "POSITION_OUTCOME_RECORDED", payload: { realizedR: 1.5 } }, { type: "POSITION_OUTCOME_RECORDED", payload: { realizedR: -1 } }]);
  assert.equal(result.totalEvents, 5);
  assert.equal(result.closedPositions, 2);
  assert.equal(result.netR, 0.5);
});

test("requires numeric realized R for manually recorded outcomes",()=>{
  assert.equal(validateScalpingEvent({eventId:"outcome-1",type:"POSITION_OUTCOME_RECORDED",symbol:"XAUUSD",payload:{positionId:"pos-1",realizedR:1.25}}).ok,true);
  assert.equal(validateScalpingEvent({eventId:"outcome-2",type:"POSITION_OUTCOME_RECORDED",symbol:"XAUUSD",payload:{positionId:"pos-1",realizedR:"not-a-number"}}).ok,false);
  assert.equal(validateScalpingEvent({eventId:"outcome-3",type:"POSITION_OUTCOME_RECORDED",symbol:"XAUUSD",payload:{realizedR:1.25}}).ok,false);
});
test("rejects multiple outcome events for the same position in one batch",()=>{
  const base={type:"POSITION_OUTCOME_RECORDED",symbol:"XAUUSD",payload:{positionId:"pos-1",realizedR:1.0}};
  const result=validateScalpingEventBatch([
    {eventId:"outcome-a",...base},
    {eventId:"outcome-b",...base}
  ]);
  assert.equal(result.ok,false);
});

test("accepts structurally valid Android MT5 broker quote observations", () => {
  const observedAt = new Date().toISOString();
  const result = validateScalpingEvent({
    eventId: "broker-quote-1",
    type: "BROKER_QUOTE_OBSERVED",
    symbol: "XAUUSD",
    payload: {
      source: "mt5_android",
      observationMethod: "user_authorized_local_mt5_screen_ocr",
      bid: 2650.1,
      ask: 2650.3,
      spreadPriceDelta: 0.2,
      spreadUnit: "raw_price_delta",
      observedAt,
      rawScreenUploaded: false
    }
  });
  assert.equal(result.ok, true);
});

test("rejects malformed or mislabelled Android broker quote observations", () => {
  const observedAt = new Date().toISOString();
  const base = {
    eventId: "broker-quote-invalid",
    type: "BROKER_QUOTE_OBSERVED",
    symbol: "XAUUSD",
    payload: {
      source: "mt5_android",
      observationMethod: "user_authorized_local_mt5_screen_ocr",
      bid: 2650.3,
      ask: 2650.1,
      observedAt,
      rawScreenUploaded: false
    }
  };
  assert.equal(validateScalpingEvent(base).ok, false);
  assert.equal(validateScalpingEvent({
    ...base, payload: { ...base.payload, bid: 2650.1, ask: 2650.3, source: "biquote" }
  }).ok, false);
  assert.equal(validateScalpingEvent({
    ...base, payload: { ...base.payload, bid: 2650.1, ask: 2650.3, rawScreenUploaded: true }
  }).ok, false);
});
