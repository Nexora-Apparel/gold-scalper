import test from "node:test";
import assert from "node:assert/strict";
import { validateCandles, isWithinSession } from "../api/analyze.js";

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


test("Gold candidate session gate supports normal and overnight windows", () => {
  const normal = { scanMode: "session", sessionStart: "01:00", sessionEnd: "07:00" };
  assert.equal(isWithinSession(normal, new Date("2026-10-17T00:30:00Z")), true);
  assert.equal(isWithinSession(normal, new Date("2026-10-17T06:00:00Z")), false);
  const overnight = { scanMode: "session", sessionStart: "22:00", sessionEnd: "06:00" };
  assert.equal(isWithinSession(overnight, new Date("2026-10-17T00:00:00Z")), true);
  assert.equal(isWithinSession(overnight, new Date("2026-10-17T06:00:00Z")), false);
});

test("Gold 24-hour mode bypasses configured session hours", () => {
  assert.equal(isWithinSession({ scanMode: "24h", sessionStart: "01:00", sessionEnd: "07:00" }, new Date("2026-10-17T18:00:00Z")), true);
});
