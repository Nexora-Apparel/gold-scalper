import test from "node:test";
import assert from "node:assert/strict";
import { analyzeGold, scoreConfluence, detectAsianSessionSweep, selectFvgRetest } from "../lib/strategy.js";

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
    assert.ok(result.signal.riskReward > 0, "target distance must be positive but has no configured RR threshold");
    const setupCandle = fifteen.find((row) => row.time === result.signal.candleTime);
    assert.ok(setupCandle, "candidate must reference its setup candle");
    assert.ok(
      result.signal.side === "BUY" ? result.signal.entry > setupCandle.close : result.signal.entry < setupCandle.close,
      "pending entry must be beyond the setup candle close in the trade direction"
    );
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


test("fails closed when timestamped candles are not newest-first", () => {
  const hourly = makeCandles(100, 60 * 60 * 1000, "flat");
  const fifteen = makeCandles(120, 15 * 60 * 1000, "wave");
  [fifteen[0], fifteen[1]] = [fifteen[1], fifteen[0]];
  const result = analyzeGold(hourly, fifteen);
  assert.equal(result.status, "NO_TRADE");
  assert.equal(result.signal, null);
  assert.match(result.reason, /Malformed|missing OHLC/i);
});


test("dashboard strategy choice cannot disable mandatory MSNR + SMC mode", () => {
  const hourly = makeCandles(100, 60 * 60 * 1000, "flat");
  const fifteen = makeCandles(120, 15 * 60 * 1000, "flat");
  const result = analyzeGold(hourly, fifteen, { strategyMode: "SMC" });
  assert.equal(result.status, "NO_TRADE");
  assert.equal(result.signal, null);
  assert.match(result.reason, /mandatory.*MSNR.*SMC|MSNR.*SMC/i);
});

test("combined MSNR + SMC mode requires both strategy confirmations", () => {
  const hourly = makeCandles(100, 60 * 60 * 1000, "flat");
  const fifteen = makeCandles(120, 15 * 60 * 1000, "flat");
  const result = analyzeGold(hourly, fifteen, { strategyMode: "MSNR_SMC" });
  assert.equal(result.status, "NO_TRADE");
  assert.equal(result.signal, null);
  assert.match(result.reason, /MSNR.*SMC|SMC.*MSNR/i);
});

test("MSNR-only input cannot switch the engine away from mandatory combined mode", () => {
  const hourly = makeCandles(100, 60 * 60 * 1000, "flat");
  const fifteen = makeCandles(120, 15 * 60 * 1000, "flat");
  const result = analyzeGold(hourly, fifteen, { strategyMode: "MSNR" });
  assert.equal(result.status, "NO_TRADE");
  assert.equal(result.signal, null);
  assert.match(result.reason, /mandatory.*MSNR.*SMC|MSNR.*SMC/i);
});

test("confluence score gives 75 points to the three mandatory confirmations", () => {
  const result = scoreConfluence({
    h1Direction: true,
    zoneInteraction: true,
    structureBreak: true
  });
  assert.equal(result.score, 75);
  assert.equal(result.corePassed, true);
  assert.equal(result.supportingEvidenceCount, 0);
});

test("optional confluence raises score without changing mandatory confirmation status", () => {
  const result = scoreConfluence({
    h1Direction: true,
    zoneInteraction: true,
    structureBreak: true,
    liquiditySweep: true,
    fvgRetest: true,
    momentumAligned: true,
    m15Aligned: true
  });
  assert.equal(result.score, 100);
  assert.equal(result.corePassed, true);
  assert.equal(result.supportingEvidenceCount, 4);
  assert.equal(result.components.reduce((sum, item) => sum + item.points, 0), 100);
});

test("missing a core confirmation lowers score and marks confluence incomplete", () => {
  const result = scoreConfluence({
    h1Direction: true,
    zoneInteraction: true,
    structureBreak: false,
    liquiditySweep: true,
    fvgRetest: true
  });
  assert.equal(result.score, 70);
  assert.equal(result.corePassed, false);
});


test("Asian session range detects a completed-session liquidity sweep and reclaim", () => {
  const rows = [];
  const start = Date.parse("2026-10-20T00:00:00Z"); // 01:00 Africa/Lagos
  for (let i = 0; i < 28; i++) {
    const open = 2000;
    rows.push(candle(start + i * 15 * 60 * 1000, open, 2002, 1998, 2000));
  }
  // One M15 candle after 08:00 Lagos sweeps the Asian low and closes back above it.
  rows.push(candle(Date.parse("2026-10-20T07:00:00Z"), 1999, 2001, 1996, 1999.5));
  const result = detectAsianSessionSweep(rows, 0.1);
  assert.equal(result.available, true);
  assert.equal(result.bullishSweep, true);
  assert.equal(result.bearishSweep, false);
  assert.equal(result.asianLow, 1998);
});

test("Asian session sweep stays unavailable before the local 08:00 session boundary", () => {
  const rows = [];
  const start = Date.parse("2026-10-20T00:00:00Z");
  for (let i = 0; i < 24; i++) rows.push(candle(start + i * 15 * 60 * 1000, 2000, 2002, 1998, 2000));
  const result = detectAsianSessionSweep(rows, 0.1);
  assert.equal(result.available, false);
  assert.match(result.reason, /has not finished/);
});


test("Asian session sweep fails closed for candles without valid timestamps", () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({
    open: 2000, high: 2002, low: 1998, close: 2000,
    time: i === 19 ? "not-a-time" : new Date(Date.UTC(2026, 9, 20, 0, i * 15)).toISOString()
  }));
  assert.doesNotThrow(() => detectAsianSessionSweep(rows, 0.1));
  assert.equal(detectAsianSessionSweep(rows, 0.1).available, false);
});


test("FVG selection prefers the most recent valid retest after BOS", () => {
  const last = { low: 100.8, high: 101.2 };
  const gaps = [
    { side: "BUY", low: 100, high: 102, index: 20 },
    { side: "BUY", low: 100.5, high: 101.5, index: 25 },
    { side: "BUY", low: 100.7, high: 101.3, index: 14 },
    { side: "SELL", low: 100.9, high: 101.1, index: 27 },
    { side: "BUY", low: 100.6, high: 101.4, index: 10 }
  ];
  const selected = selectFvgRetest(gaps, "BUY", 15, last, 30);
  assert.equal(selected.index, 25);
  assert.equal(selectFvgRetest(gaps, "BUY", 28, last, 30), null);
});
