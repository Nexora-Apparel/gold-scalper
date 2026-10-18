import test from "node:test";
import assert from "node:assert/strict";
import { evaluateNewsWindow, getNewsStatus } from "../lib/news-filter.js";

const now = new Date("2026-10-19T12:00:00.000Z");
function event(offsetMinutes, impact = "High", country = "USD") {
  return { title: "US economic release", country, impact, date: new Date(now.getTime() + offsetMinutes * 60000).toISOString() };
}

test("blocks high-impact USD events within 30 minutes before or after", () => {
  for (const offset of [-30, -1, 0, 1, 30]) {
    const result = evaluateNewsWindow([event(offset)], now);
    assert.equal(result.blocked, true, `offset ${offset}`);
    assert.equal(result.status, "BLOCKED");
  }
});

test("allows high-impact USD events outside the 30-minute window", () => {
  assert.equal(evaluateNewsWindow([event(-31)], now).blocked, false);
  assert.equal(evaluateNewsWindow([event(31)], now).blocked, false);
});

test("ignores non-USD and non-high-impact events", () => {
  assert.equal(evaluateNewsWindow([event(0, "High", "EUR")], now).blocked, false);
  assert.equal(evaluateNewsWindow([event(0, "Medium", "USD")], now).blocked, false);
});

test("fails closed on empty or malformed calendars", () => {
  for (const events of [[], null, [{}]]) {
    const result = evaluateNewsWindow(events, now);
    assert.equal(result.blocked, true);
    assert.equal(result.status, "UNAVAILABLE");
  }
});

test("calendar HTTP errors fail closed", async () => {
  const result = await getNewsStatus({
    now,
    fetchImpl: async () => ({ ok: false, status: 503 })
  });
  assert.equal(result.blocked, true);
  assert.equal(result.status, "UNAVAILABLE");
});

test("calendar network failures fail closed", async () => {
  const result = await getNewsStatus({
    now,
    fetchImpl: async () => { throw new Error("network unavailable"); }
  });
  assert.equal(result.blocked, true);
  assert.equal(result.status, "UNAVAILABLE");
});

test("calendar response with an unexpected JSON shape fails closed", async () => {
  const result = await getNewsStatus({
    now,
    fetchImpl: async () => ({ ok: true, json: async () => ({ events: [] }) })
  });
  assert.equal(result.blocked, true);
  assert.equal(result.status, "UNAVAILABLE");
});
