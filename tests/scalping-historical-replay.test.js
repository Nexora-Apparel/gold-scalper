import test from "node:test";
import assert from "node:assert/strict";
import { replayScalpingSignals } from "../lib/scalping-historical-replay.js";

const base = Date.parse("2026-10-01T10:00:00.000Z");
function q(ms, bid, ask) {
  return { dataKind: "tick", provider: "demo-broker-tick-export", symbol: "XAUUSD", timestamp: new Date(base + ms).toISOString(), bid, ask };
}

test("replays BUY at Ask and closes at Bid using executable-side prices", () => {
  const result = replayScalpingSignals({
    symbol: "XAUUSD",
    quotes: [q(0, 2650, 2650.2), q(5000, 2650.5, 2650.7)],
    signals: [{ id: "s1", symbol: "XAUUSD", side: "BUY", timestamp: new Date(base).toISOString() }],
    horizonsSeconds: [5]
  });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].entryPrice, 2650.2);
  assert.equal(result.results[0].exitPrice, 2650.5);
  assert.equal(result.results[0].movePriceUnits, 0.3);
  assert.equal(result.results[0].outcome, "WIN");
});

test("replays SELL at Bid and closes at Ask", () => {
  const result = replayScalpingSignals({
    symbol: "XAUUSD",
    quotes: [q(0, 2650, 2650.2), q(5000, 2649.7, 2649.9)],
    signals: [{ symbol: "XAUUSD", side: "SELL", timestamp: new Date(base).toISOString() }],
    horizonsSeconds: [5]
  });
  assert.equal(result.results[0].entryPrice, 2650);
  assert.equal(result.results[0].exitPrice, 2649.9);
  assert.equal(result.results[0].movePriceUnits, 0.1);
});

test("skips horizons without a timely exit quote instead of inventing one", () => {
  const result = replayScalpingSignals({
    symbol: "XAUUSD",
    quotes: [q(0, 2650, 2650.2), q(5000, 2650.5, 2650.7)],
    signals: [{ symbol: "XAUUSD", side: "BUY", timestamp: new Date(base).toISOString() }],
    horizonsSeconds: [15]
  });
  assert.equal(result.results.length, 0);
  assert.equal(result.skipped.exit_quote_unavailable_15s, 1);
});

test("rejects OHLC, mixed providers, malformed quotes and unordered tapes", () => {
  const signal = [{ symbol: "XAUUSD", side: "BUY", timestamp: new Date(base).toISOString() }];
  assert.throws(() => replayScalpingSignals({ symbol: "XAUUSD", quotes: [{ ...q(0, 2650, 2650.2), dataKind: "ohlc" }, q(5000, 2650, 2650.2)], signals: signal }), /tick data only/);
  assert.throws(() => replayScalpingSignals({ symbol: "XAUUSD", quotes: [q(0, 2650, 2650.2), { ...q(5000, 2650, 2650.2), provider: "other" }], signals: signal }), /mix market-data providers/);
  assert.throws(() => replayScalpingSignals({ symbol: "XAUUSD", quotes: [q(5000, 2650, 2650.2), q(0, 2650, 2650.2)], signals: signal }), /chronologically ordered/);
  assert.throws(() => replayScalpingSignals({ symbol: "XAUUSD", quotes: [q(0, 2650, 2650.2), q(0, 2650, 2650.2)], signals: signal }), /unique and strictly chronologically ordered/);
  assert.throws(() => replayScalpingSignals({ symbol: "XAUUSD", quotes: [q(0, 2650, 2650), q(5000, 2650, 2650)], signals: signal }), /invalid Bid\/Ask/);
});

test("reports results by requested horizon and does not label estimates as proven accuracy", () => {
  const result = replayScalpingSignals({
    symbol: "XAUUSD",
    quotes: [q(0, 2650, 2650.2), q(5000, 2650.5, 2650.7), q(15000, 2650.6, 2650.8)],
    signals: [{ symbol: "XAUUSD", side: "BUY", timestamp: new Date(base).toISOString() }],
    horizonsSeconds: [5, 15]
  });
  assert.equal(result.summary.length, 2);
  assert.equal(result.summary[0].evaluated, 1);
  assert.equal(result.summary[1].evaluated, 1);
  assert.equal(result.summaryBySide.length, 4);
  assert.equal(result.summaryBySide[0].side, "BUY");
  assert.match(result.validationNotice, /research estimate/);
});

test("rejects timezone-ambiguous tick and signal timestamps", () => {
  const signal = [{ symbol: "XAUUSD", side: "BUY", timestamp: "2026-10-01T10:00:00" }];
  const invalidSignalResult = replayScalpingSignals({ symbol: "XAUUSD", quotes: [q(0, 2650, 2650.2), q(5000, 2650.3, 2650.5)], signals: signal });
  assert.equal(invalidSignalResult.skipped.invalid_signal, 1);
  const ambiguousTape = [q(0, 2650, 2650.2), { ...q(5000, 2650.3, 2650.5), timestamp: "2026-10-01T10:00:05" }];
  assert.throws(() => replayScalpingSignals({ symbol: "XAUUSD", quotes: ambiguousTape, signals: [] }), /timezone-explicit/);
});

test("skips signals that occur after the final available tick", () => {
  const result = replayScalpingSignals({
    symbol: "XAUUSD",
    quotes: [q(0, 2650, 2650.2), q(5000, 2650.3, 2650.5)],
    signals: [{ symbol: "XAUUSD", side: "BUY", timestamp: new Date(base + 10000).toISOString() }],
    horizonsSeconds: [5]
  });
  assert.equal(result.results.length, 0);
  assert.equal(result.skipped.entry_quote_unavailable, 1);
});

test("MFE and MAE include the initial Bid/Ask spread at entry", () => {
  const result = replayScalpingSignals({
    symbol: "XAUUSD",
    quotes: [q(0, 2650, 2650.2), q(5000, 2650.5, 2650.7)],
    signals: [{ symbol: "XAUUSD", side: "BUY", timestamp: new Date(base).toISOString() }],
    horizonsSeconds: [5]
  });
  assert.equal(result.results[0].maxFavourableMovePriceUnits, 0.3);
  assert.equal(result.results[0].maxAdverseMovePriceUnits, -0.2);
});

test("reports gross and net outcomes when an additional round-trip cost is supplied", () => {
  const result = replayScalpingSignals({
    symbol: "XAUUSD",
    quotes: [q(0, 2650, 2650.2), q(5000, 2650.5, 2650.7)],
    signals: [{ symbol: "XAUUSD", side: "BUY", timestamp: new Date(base).toISOString() }],
    horizonsSeconds: [5],
    roundTripAdditionalCostPriceUnits: 0.35
  });
  const row = result.results[0];
  assert.equal(row.grossOutcome, "WIN");
  assert.equal(row.grossMovePriceUnits, 0.3);
  assert.equal(row.netMovePriceUnits, -0.05);
  assert.equal(row.netOutcome, "LOSS");
  assert.equal(result.summary[0].netHitRatePercent, 0);
});

test("leaves net results unavailable when additional round-trip costs are not supplied", () => {
  const result = replayScalpingSignals({
    symbol: "XAUUSD",
    quotes: [q(0, 2650, 2650.2), q(5000, 2650.5, 2650.7)],
    signals: [{ symbol: "XAUUSD", side: "BUY", timestamp: new Date(base).toISOString() }],
    horizonsSeconds: [5]
  });
  assert.equal(result.results[0].netMovePriceUnits, null);
  assert.equal(result.summary[0].netHitRatePercent, null);
});

test("rejects negative or non-finite additional round-trip costs", () => {
  assert.throws(() => replayScalpingSignals({
    symbol: "XAUUSD", quotes: [q(0, 2650, 2650.2), q(5000, 2650.5, 2650.7)],
    signals: [], roundTripAdditionalCostPriceUnits: -0.1
  }), /non-negative price-unit/);
});
