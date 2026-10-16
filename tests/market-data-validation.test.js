import test from "node:test";
import assert from "node:assert/strict";
import { validateCandles } from "../api/analyze.js";
import { validateCandles as validateBtcCandles } from "../api/analyze-btc.js";

const HOUR = 60 * 60 * 1000;
const FIFTEEN_MINUTES = 15 * 60 * 1000;

function providerCandles(latestOpenTime, intervalMs, count = 30) {
  const latest = Date.parse(latestOpenTime);
  return Array.from({ length: count }, (_, index) => ({
    datetime: new Date(latest - index * intervalMs).toISOString().replace("T", " ").slice(0, 19),
    open: 4160,
    high: 4162,
    low: 4158,
    close: 4161
  }));
}

test("H1 freshness is measured from candle close, not open", () => {
  const now = Date.parse("2026-10-16T17:31:00Z");
  const candles = providerCandles("2026-10-16T16:00:00Z", HOUR);
  assert.equal(validateCandles(candles, "1h", 20, now).length, 30);
});

test("rejects an H1 candle more than 90 minutes past close", () => {
  const now = Date.parse("2026-10-16T17:31:00Z");
  const candles = providerCandles("2026-10-16T15:00:00Z", HOUR);
  assert.throws(() => validateCandles(candles, "1h", 20, now), /Stale 1h candles/);
});

test("M15 freshness is measured from candle close", () => {
  const now = Date.parse("2026-10-16T17:31:00Z");
  const candles = providerCandles("2026-10-16T17:00:00Z", FIFTEEN_MINUTES);
  assert.equal(validateCandles(candles, "15min", 20, now).length, 30);
});

test("rejects an M15 candle more than 45 minutes past close", () => {
  const now = Date.parse("2026-10-16T17:31:00Z");
  const candles = providerCandles("2026-10-16T16:00:00Z", FIFTEEN_MINUTES);
  assert.throws(() => validateCandles(candles, "15min", 20, now), /Stale 15min candles/);
});

test("BTC H1 candles use the same completed-candle freshness safeguards", () => {
  const now = Date.parse("2026-10-16T17:31:00Z");
  const candles = providerCandles("2026-10-16T16:00:00Z", HOUR);
  assert.equal(validateBtcCandles(candles, "1h", 20, now).length, 30);
  assert.throws(() => validateBtcCandles(providerCandles("2026-10-16T15:00:00Z", HOUR), "1h", 20, now), /Stale 1h candles/);
});

test("BTC M15 candles use the same completed-candle freshness safeguards", () => {
  const now = Date.parse("2026-10-16T17:31:00Z");
  const candles = providerCandles("2026-10-16T17:00:00Z", FIFTEEN_MINUTES);
  assert.equal(validateBtcCandles(candles, "15min", 20, now).length, 30);
  assert.throws(() => validateBtcCandles(providerCandles("2026-10-16T16:00:00Z", FIFTEEN_MINUTES), "15min", 20, now), /Stale 15min candles/);
});
