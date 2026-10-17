import test from "node:test";
import assert from "node:assert/strict";
import { validateCandles } from "../api/analyze-btc.js";

const HOUR = 60 * 60 * 1000;
const M15 = 15 * 60 * 1000;

function candles(latestOpenTime, intervalMs, count = 100, price = 65000) {
  const latest = Date.parse(latestOpenTime);
  return Array.from({ length: count }, (_, index) => ({
    datetime: new Date(latest - index * intervalMs).toISOString().replace("T", " ").slice(0, 19),
    open: price,
    high: price + 50,
    low: price - 50,
    close: price + 10
  }));
}

test("BTC validator accepts fresh completed M15 candles at BTC price scale", () => {
  const now = Date.parse("2026-10-17T09:31:00Z");
  const values = candles("2026-10-17T09:00:00Z", M15, 100);
  assert.equal(validateCandles(values, "15min", 80, now).length, 100);
});

test("BTC validator rejects stale completed M15 candles", () => {
  const now = Date.parse("2026-10-17T09:31:00Z");
  const values = candles("2026-10-17T08:00:00Z", M15, 100);
  assert.throws(() => validateCandles(values, "15min", 80, now), /Stale 15min candles/);
});

test("BTC validator rejects malformed OHLC data instead of silently discarding it", () => {
  const now = Date.parse("2026-10-17T09:31:00Z");
  const values = candles("2026-10-17T09:00:00Z", M15, 100);
  values[8] = { ...values[8], high: values[8].close - 1 };
  assert.throws(() => validateCandles(values, "15min", 80, now), /malformed OHLC/);
});

test("BTC validator accepts fresh completed H1 candles", () => {
  const now = Date.parse("2026-10-17T09:31:00Z");
  const values = candles("2026-10-17T08:00:00Z", HOUR, 100);
  assert.equal(validateCandles(values, "1h", 60, now).length, 100);
});
