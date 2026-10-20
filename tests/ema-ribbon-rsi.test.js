import test from "node:test";
import assert from "node:assert/strict";
import { analyzeEmaRibbonRsi } from "../lib/ema-ribbon-rsi.js";

function candlesFromCloses(closes, intervalMs = 5 * 60 * 1000) {
  const start = Date.UTC(2026, 0, 1);
  return closes.map((close, i) => {
    const previous = i ? closes[i - 1] : close - 0.2;
    return {
      time: new Date(start + i * intervalMs).toISOString(),
      open: previous,
      high: Math.max(previous, close) + 0.5,
      low: Math.min(previous, close) - 0.5,
      close
    };
  }).reverse();
}

test("EMA Ribbon + RSI fails closed on flat/choppy candles", () => {
  const flat = candlesFromCloses(Array.from({ length: 100 }, () => 2000));
  const result = analyzeEmaRibbonRsi(flat, { timeframe: "M5" }, "XAUUSD");
  assert.equal(result.status, "NO_TRADE");
  assert.equal(result.signal, null);
});

test("EMA Ribbon + RSI accepts a completed bullish ribbon breakout and builds ATR risk levels", () => {
  const closes = Array.from({ length: 80 }, (_, i) => 2000 + i * 0.25);
  closes[78] -= 2;
  closes[79] = 2023;
  const result = analyzeEmaRibbonRsi(candlesFromCloses(closes), {
    timeframe: "M5", balance: 1000, currency: "USD", riskPercent: 0.5, atrTargetMultiple: 4
  }, "XAUUSD");
  assert.equal(result.status, "SIGNAL_CANDIDATE", result.reason);
  assert.equal(result.signal.side, "BUY");
  assert.equal(result.signal.timeframe, "M5");
  assert.equal(result.signal.entry, 2023);
  assert.ok(result.signal.stopLoss < result.signal.entry);
  assert.ok(result.signal.takeProfit > result.signal.entry);
  assert.equal(result.signal.riskReward, 2);
  assert.match(result.signal.explanation.join(" "), /EMA9 > EMA21 > EMA50/);
});

test("EMA Ribbon + RSI rejects insufficient history and malformed candles", () => {
  assert.equal(analyzeEmaRibbonRsi(candlesFromCloses(Array.from({ length: 40 }, (_, i) => 2000 + i)), { timeframe: "M15" }).status, "NO_TRADE");
  const malformed = candlesFromCloses(Array.from({ length: 80 }, (_, i) => 2000 + i * 0.1));
  malformed[4] = { ...malformed[4], high: Number.NaN };
  assert.equal(analyzeEmaRibbonRsi(malformed, { timeframe: "M15" }).status, "NO_TRADE");
});
