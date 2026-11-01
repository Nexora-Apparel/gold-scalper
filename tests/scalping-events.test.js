import test from "node:test";
import assert from "node:assert/strict";
import { validateScalpingEvent, validateScalpingEventBatch, summarizeScalpingEvents } from "../lib/scalping-events.js";

test("validates and normalizes a scalping event", () => {
  const result = validateScalpingEvent({ eventId: "evt-1", type: "signal", symbol: "xauusd", side: "BUY", payload: { confidence: 0.81 } });
  assert.equal(result.ok, true);
  assert.equal(result.value.type, "SIGNAL");
  assert.equal(result.value.symbol, "XAUUSD");
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
