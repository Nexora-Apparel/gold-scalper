import test from "node:test";
import assert from "node:assert/strict";
import { evaluateSignalLifecycle } from "../lib/signal-lifecycle.js";

function active(side = "BUY", overrides = {}) {
  const signal = side === "BUY"
    ? { side, entry: 4171, stopLoss: 4151, takeProfit: 4191, candleTime: "2026-10-16T08:00:00Z" }
    : { side, entry: 4171, stopLoss: 4191, takeProfit: 4151, candleTime: "2026-10-16T08:00:00Z" };
  return {
    state: "WAITING_FOR_ENTRY",
    createdAt: "2026-10-16T08:00:00Z",
    expiresAt: "2026-10-16T16:00:00Z",
    result: { status: "SIGNAL_CANDIDATE", signal },
    ...overrides
  };
}

function candle(time, open, high, low, close) {
  return { time, open, high, low, close };
}

test("BUY confirms only after a later bullish candle retests and closes above entry", () => {
  const result = evaluateSignalLifecycle(active(), [
    candle("2026-10-16T08:15:00Z", 4171, 4180, 4168, 4175)
  ], Date.parse("2026-10-16T08:30:00Z"));
  assert.equal(result.changed, true);
  assert.equal(result.active.state, "CONFIRMATION_PENDING_DELIVERY");
  assert.equal(result.event.type, "CONFIRMED");
});

test("SELL confirms only after a later bearish candle retests and closes below entry", () => {
  const result = evaluateSignalLifecycle(active("SELL"), [
    candle("2026-10-16T08:15:00Z", 4171, 4174, 4160, 4165)
  ], Date.parse("2026-10-16T08:30:00Z"));
  assert.equal(result.active.state, "CONFIRMATION_PENDING_DELIVERY");
  assert.equal(result.event.type, "CONFIRMED");
});

test("same setup candle cannot confirm its own entry", () => {
  const result = evaluateSignalLifecycle(active(), [
    candle("2026-10-16T08:00:00Z", 4171, 4180, 4160, 4175)
  ], Date.parse("2026-10-16T08:30:00Z"));
  assert.equal(result.changed, false);
  assert.equal(result.active.state, "WAITING_FOR_ENTRY");
});

test("invalidates a BUY if stop or target is touched before confirmation", () => {
  const result = evaluateSignalLifecycle(active(), [
    candle("2026-10-16T08:15:00Z", 4171, 4175, 4149, 4160)
  ], Date.parse("2026-10-16T08:30:00Z"));
  assert.equal(result.active.state, "INVALIDATED");
  assert.equal(result.event.type, "INVALIDATED");
});

test("fails closed when entry and target are both touched in the same candle", () => {
  const result = evaluateSignalLifecycle(active(), [
    candle("2026-10-16T08:15:00Z", 4171, 4192, 4168, 4180)
  ], Date.parse("2026-10-16T08:30:00Z"));
  assert.equal(result.active.state, "INVALIDATED");
});

test("expires an unconfirmed setup after its expiry time", () => {
  const result = evaluateSignalLifecycle(active(), [], Date.parse("2026-10-16T16:00:00Z"));
  assert.equal(result.active.state, "EXPIRED");
  assert.equal(result.event.type, "EXPIRED");
});

test("ignores already-final lifecycle states", () => {
  const result = evaluateSignalLifecycle(active("BUY", { state: "CONFIRMED_AND_NOTIFIED" }), [
    candle("2026-10-16T08:15:00Z", 4171, 4180, 4168, 4175)
  ], Date.parse("2026-10-16T08:30:00Z"));
  assert.equal(result.changed, false);
  assert.equal(result.active.state, "CONFIRMED_AND_NOTIFIED");
});
