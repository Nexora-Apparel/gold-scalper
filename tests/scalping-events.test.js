import test from "node:test";
import assert from "node:assert/strict";
import { validateScalpingEvent, validateScalpingEventBatch, summarizeScalpingEvents, validateScalpingEventTransitions, filterIdempotentLifecycleEvents } from "../lib/scalping-events.js";

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

test("normalizes versioned event envelopes and stable signal correlation", () => {
  const signal = validateScalpingEvent({
    eventId: "signal-42", type: "SIGNAL", symbol: "XAUUSD", source: "android",
    schemaVersion: 1, payload: { confidence: 0.84 }
  });
  assert.equal(signal.ok, true);
  assert.deepEqual(signal.value.envelope, {
    schemaVersion: 1, source: "android", correlationId: "signal-42",
    signalId: "signal-42", positionId: null
  });
  const opened = validateScalpingEvent({
    eventId: "opened-42", type: "POSITION_OPENED", symbol: "XAUUSD",
    source: "android", signalId: "signal-42", positionId: "mt5-9001",
    payload: { positionId: "mt5-9001" }
  });
  assert.equal(opened.value.envelope.correlationId, "signal-42");
  assert.equal(opened.value.envelope.positionId, "mt5-9001");
});
test("rejects unsupported envelope versions, sources and malformed identifiers", () => {
  const base = { eventId: "evt-envelope", type: "NO_TRADE", symbol: "XAUUSD" };
  assert.equal(validateScalpingEvent({ ...base, schemaVersion: 2 }).ok, false);
  assert.equal(validateScalpingEvent({ ...base, source: "unknown-client" }).ok, false);
  assert.equal(validateScalpingEvent({ ...base, signalId: "x".repeat(161) }).ok, false);
});


test("accepts a complete position lifecycle in chronological order", () => {
  const base = { symbol: "XAUUSD", side: "BUY" };
  const events = [
    { ...base, eventId: "open-1", type: "POSITION_OPENED", occurredAt: "2026-11-02T09:00:00.000Z", payload: { positionId: "mt5-1" } },
    { ...base, eventId: "exit-1", type: "EXIT_RECOMMENDED", occurredAt: "2026-11-02T09:00:10.000Z", payload: { positionId: "mt5-1" } },
    { ...base, eventId: "close-1", type: "POSITION_CLOSED", occurredAt: "2026-11-02T09:00:20.000Z", payload: { positionId: "mt5-1" } },
    { ...base, eventId: "outcome-1", type: "POSITION_OUTCOME_RECORDED", occurredAt: "2026-11-02T09:00:21.000Z", payload: { positionId: "mt5-1", realizedR: 1.2 } }
  ].map(event => validateScalpingEvent(event).value);
  assert.equal(validateScalpingEventTransitions(events).ok, true);
});

test("rejects close and outcome events without valid preceding position states", () => {
  const closed = validateScalpingEvent({
    eventId: "close-orphan", type: "POSITION_CLOSED", symbol: "XAUUSD",
    occurredAt: "2026-11-02T09:00:20.000Z", payload: { positionId: "mt5-orphan" }
  }).value;
  assert.equal(validateScalpingEventTransitions([closed]).ok, false);
  const opened = validateScalpingEvent({
    eventId: "open-late", type: "POSITION_OPENED", symbol: "XAUUSD",
    occurredAt: "2026-11-02T09:00:30.000Z", payload: { positionId: "mt5-orphan" }
  }).value;
  assert.equal(validateScalpingEventTransitions([closed], [opened]).ok, false);
});

test("rejects duplicate opens, duplicate closes and exit events after closure", () => {
  const make = (eventId, type, time) => validateScalpingEvent({
    eventId, type, symbol: "XAGUSD", occurredAt: time,
    payload: { positionId: "mt5-duplicate", ...(type === "POSITION_OUTCOME_RECORDED" ? { realizedR: 0.5 } : {}) }
  }).value;
  const opened = make("open-a", "POSITION_OPENED", "2026-11-02T09:00:00.000Z");
  const duplicateOpen = make("open-b", "POSITION_OPENED", "2026-11-02T09:00:01.000Z");
  assert.equal(validateScalpingEventTransitions([opened, duplicateOpen]).ok, false);
  const closed = make("close-a", "POSITION_CLOSED", "2026-11-02T09:00:02.000Z");
  const duplicateClose = make("close-b", "POSITION_CLOSED", "2026-11-02T09:00:03.000Z");
  assert.equal(validateScalpingEventTransitions([opened, closed, duplicateClose]).ok, false);
  const exitAfterClose = make("exit-late", "EXIT_RECOMMENDED", "2026-11-02T09:00:04.000Z");
  assert.equal(validateScalpingEventTransitions([opened, closed, exitAfterClose]).ok, false);
});

test("reconstructs position transitions across separate sync batches", () => {
  const opened = validateScalpingEvent({
    eventId: "open-persisted", type: "POSITION_OPENED", symbol: "XAUUSD",
    occurredAt: "2026-11-02T09:00:00.000Z", payload: { positionId: "mt5-persisted" }
  }).value;
  const closed = validateScalpingEvent({
    eventId: "close-incoming", type: "POSITION_CLOSED", symbol: "XAUUSD",
    occurredAt: "2026-11-02T09:00:10.000Z", payload: { positionId: "mt5-persisted" }
  }).value;
  assert.equal(validateScalpingEventTransitions([closed], [opened]).ok, true);
});


test("derives signal linkage from sourceSignalRef and rejects conflicting identifiers", () => {
  const linked = validateScalpingEvent({
    eventId: "position-linked", type: "POSITION_OPENED", symbol: "XAUUSD", side: "BUY",
    payload: { positionId: "mt5-linked", sourceSignalRef: "signal-original" }
  });
  assert.equal(linked.ok, true);
  assert.equal(linked.value.envelope.signalId, "signal-original");
  assert.equal(linked.value.envelope.correlationId, "signal-original");
  assert.equal(validateScalpingEvent({
    eventId: "position-conflict", type: "POSITION_OPENED", symbol: "XAUUSD", side: "BUY",
    signalId: "signal-a", payload: { positionId: "mt5-conflict", sourceSignalRef: "signal-b" }
  }).ok, false);
});


test("filters repeated event IDs and already-settled outcome retries without suppressing new lifecycle events", () => {
  const prior = [
    { eventId: "open-existing", type: "POSITION_OPENED", payload: { positionId: "mt5-idempotent" } },
    { eventId: "outcome-existing", type: "POSITION_OUTCOME_RECORDED", payload: { positionId: "mt5-settled" } }
  ];
  const incoming = [
    { eventId: "open-existing", type: "POSITION_OPENED", payload: { positionId: "mt5-idempotent" } },
    { eventId: "outcome-retry", type: "POSITION_OUTCOME_RECORDED", payload: { positionId: "mt5-settled", realizedR: 1 } },
    { eventId: "close-new", type: "POSITION_CLOSED", payload: { positionId: "mt5-idempotent" } },
    { eventId: "outcome-new", type: "POSITION_OUTCOME_RECORDED", payload: { positionId: "mt5-idempotent", realizedR: -0.5 } }
  ];
  assert.deepEqual(filterIdempotentLifecycleEvents(incoming, prior).map(event => event.eventId), ["close-new", "outcome-new"]);
});


test("does not let legacy duplicate opens prevent a new valid close transition", () => {
  const prior = [
    { eventId: "legacy-open-a", type: "POSITION_OPENED", symbol: "XAUUSD", occurredAt: "2026-11-02T09:00:00.000Z", payload: { positionId: "mt5-legacy-dup" } },
    { eventId: "legacy-open-b", type: "POSITION_OPENED", symbol: "XAUUSD", occurredAt: "2026-11-02T09:00:01.000Z", payload: { positionId: "mt5-legacy-dup" } }
  ];
  const close = validateScalpingEvent({
    eventId: "legacy-position-close", type: "POSITION_CLOSED", symbol: "XAUUSD",
    occurredAt: "2026-11-02T09:00:10.000Z", payload: { positionId: "mt5-legacy-dup" }
  }).value;
  assert.equal(validateScalpingEventTransitions([close], prior).ok, true);
});


test("normalizes top-level positionId into the persisted payload and rejects conflicts", () => {
  const normalized = validateScalpingEvent({
    eventId: "position-top-level", type: "POSITION_OPENED", symbol: "XAUUSD",
    positionId: "mt5-top-level", payload: { entryPrice: 2650 }
  });
  assert.equal(normalized.ok, true);
  assert.equal(normalized.value.payload.positionId, "mt5-top-level");
  assert.equal(validateScalpingEvent({
    eventId: "position-id-conflict", type: "POSITION_OPENED", symbol: "XAUUSD",
    positionId: "mt5-a", payload: { positionId: "mt5-b" }
  }).ok, false);
});
