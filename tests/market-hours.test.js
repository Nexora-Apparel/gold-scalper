import test from "node:test";
import assert from "node:assert/strict";
import { getGoldMarketStatus } from "../lib/market-hours.js";

test("blocks Saturday all day", () => {
  assert.equal(getGoldMarketStatus(new Date("2026-10-17T12:00:00Z")).open, false);
});

test("blocks Sunday before conservative 22:00 UTC reopen", () => {
  assert.equal(getGoldMarketStatus(new Date("2026-10-18T21:59:00Z")).open, false);
  assert.equal(getGoldMarketStatus(new Date("2026-10-18T22:00:00Z")).open, true);
});

test("blocks Friday from 21:00 UTC onward", () => {
  assert.equal(getGoldMarketStatus(new Date("2026-10-16T20:59:00Z")).open, true);
  assert.equal(getGoldMarketStatus(new Date("2026-10-16T21:00:00Z")).open, false);
});

test("allows a normal weekday and fails closed on an invalid clock", () => {
  assert.equal(getGoldMarketStatus(new Date("2026-10-19T09:00:00Z")).open, true);
  assert.equal(getGoldMarketStatus("not-a-date").open, false);
});
