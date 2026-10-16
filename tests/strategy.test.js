import test from "node:test";
import assert from "node:assert/strict";
import { analyzeGold } from "../lib/strategy.js";

function candle(time, open, high, low, close) {
  return { time: new Date(time).toISOString(), open, high, low, close };
}

function makeCandles(count, intervalMs, mode = "flat") {
  const start = Date.UTC(2026, 0, 1);
  const rows = [];
  let previous = 2000;
  for (let i = 0; i < count; i++) {
    const close = mode === "wave" ? 2000 + Math.sin(i / 3) * 4 : 2000;
    const open = mode === "wave" ? previous : 2000;
    rows.push(candle(
      start + i * intervalMs,
      open,
      Math.max(open, close) + 1,
      Math.min(open, close) - 1,
      close
    ));
    previous = close;
  }
  // Production provider returns newest-first.
  return rows.reverse();
}

test("returns NO_TRADE when candle history is insufficient", () => {
  const result = analyzeGold([], []);
  assert.equal(result.status, "NO_TRADE");
  assert.equal(result.signal, null);
  assert.match(result.reason, /Insufficient/);
});

test("does not create a directional MSNR signal when H1 trend is neutral", () => {
  const hourly = makeCandles(100, 60 * 60 * 1000, "flat");
  const fifteen = makeCandles(120, 15 * 60 * 1000, "wave");
  const result = analyzeGold(hourly, fifteen);
  assert.equal(result.status, "NO_TRADE");
  assert.equal(result.signal, null);
  assert.match(result.reason, /MSNR|trend/i);
});

test("never emits a malformed trade candidate", () => {
  const hourly = makeCandles(100, 60 * 60 * 1000, "flat");
  const fifteen = makeCandles(120, 15 * 60 * 1000, "wave");
  const result = analyzeGold(hourly, fifteen);
  if (result.status === "SIGNAL_CANDIDATE") {
    assert.ok(["BUY", "SELL"].includes(result.signal.side));
    assert.ok(result.signal.stopLoss > 0);
    assert.ok(result.signal.takeProfit > 0);
    assert.ok(result.signal.riskReward >= 1.5);
    assert.match(result.signal.timeframe, /MSNR/);
  } else {
    assert.equal(result.signal, null);
  }
});


test("fails closed when any supplied candle is malformed", () => {
  const hourly = makeCandles(100, 60 * 60 * 1000, "flat");
  const fifteen = makeCandles(120, 15 * 60 * 1000, "wave");
  fifteen[15] = { ...fifteen[15], high: Number.NaN };
  const result = analyzeGold(hourly, fifteen);
  assert.equal(result.status, "NO_TRADE");
  assert.equal(result.signal, null);
  assert.match(result.reason, /Malformed|missing OHLC/i);
});

test("neutral RSI is 50 when all completed candles have unchanged closes", () => {
  const hourly = makeCandles(100, 60 * 60 * 1000, "flat");
  const fifteen = makeCandles(120, 15 * 60 * 1000, "flat");
  const result = analyzeGold(hourly, fifteen);
  assert.equal(result.status, "NO_TRADE");
  assert.equal(result.indicators.rsi, 50);
});

test("rejects missing candle arrays without throwing", () => {
  const result = analyzeGold(null, []);
  assert.equal(result.status, "NO_TRADE");
  assert.equal(result.signal, null);
  assert.match(result.reason, /Malformed|missing OHLC/i);
});
