import test from "node:test";
import assert from "node:assert/strict";
import { validateHistoricalTickDataset } from "../lib/scalping-tick-dataset.js";
import { replayScalpingSignals } from "../lib/scalping-historical-replay.js";

const metadata = {
  symbol: "XAUUSD",
  provider: "Example Tick Archive",
  sourceReference: "user-supplied-export-2026-10",
  dataKind: "tick"
};
const quotes = [
  { symbol: "XAUUSD", timestamp: "2026-10-01T10:00:00.000Z", bid: 2650.1, ask: 2650.2 },
  { symbol: "XAUUSD", timestamp: "2026-10-01T10:00:00.250Z", bid: 2650.2, ask: 2650.3 },
  { symbol: "XAUUSD", timestamp: "2026-10-01T10:00:01.000Z", bid: 2650.15, ask: 2650.25 }
];

test("validates provenance-labelled chronological tick archive and reports coverage gaps", () => {
  const result = validateHistoricalTickDataset({ metadata, quotes });
  assert.equal(result.ok, true);
  assert.equal(result.manifest.tickCount, 3);
  assert.equal(result.manifest.medianIntervalMs, 250);
  assert.equal(result.manifest.maxGapMs, 750);
  assert.ok(Math.abs(result.quotes[0].spread - 0.1) < 1e-9);
});

test("validated archive output feeds the chronological replay engine directly", () => {
  const dataset = validateHistoricalTickDataset({ metadata, quotes });
  assert.equal(dataset.ok, true);
  const replay = replayScalpingSignals({
    symbol: "XAUUSD",
    quotes: dataset.quotes,
    signals: [{ id: "sample-1", symbol: "XAUUSD", side: "BUY", timestamp: quotes[0].timestamp }],
    horizonsSeconds: [1],
    maxEntryDelayMs: 0,
    maxExitWaitMs: 0
  });
  assert.equal(replay.evaluatedRows, 1);
  assert.equal(replay.results[0].entryPrice, quotes[0].ask);
  assert.equal(replay.results[0].exitPrice, quotes[2].bid);
});

test("rejects OHLC data and missing provenance", () => {
  assert.deepEqual(validateHistoricalTickDataset({ metadata: { ...metadata, dataKind: "ohlc" }, quotes }).errors, ["tick_data_required_ohlc_not_accepted"]);
  assert.equal(validateHistoricalTickDataset({ metadata: { ...metadata, sourceReference: "" }, quotes }).ok, false);
});

test("rejects duplicate, unordered, malformed and mixed-symbol ticks", () => {
  assert.equal(validateHistoricalTickDataset({ metadata, quotes: [quotes[0], quotes[0]] }).ok, false);
  assert.equal(validateHistoricalTickDataset({ metadata, quotes: [quotes[1], quotes[0]] }).ok, false);
  assert.equal(validateHistoricalTickDataset({ metadata, quotes: [quotes[0], { ...quotes[1], ask: "2650.3" }] }).ok, false);
  assert.equal(validateHistoricalTickDataset({ metadata, quotes: [quotes[0], { ...quotes[1], symbol: "XAGUSD" }] }).ok, false);
});

test("rejects impossible calendar dates and invalid timezone offsets", () => {
  assert.equal(validateHistoricalTickDataset({ metadata, quotes: [quotes[0], { ...quotes[1], timestamp: "2026-02-31T10:00:00.000Z" }] }).ok, false);
  assert.equal(validateHistoricalTickDataset({ metadata, quotes: [quotes[0], { ...quotes[1], timestamp: "2026-10-01T10:00:00+15:00" }] }).ok, false);
});

test("requires timezone-explicit timestamps and finite executable-side quotes", () => {
  assert.equal(validateHistoricalTickDataset({ metadata, quotes: [quotes[0], { ...quotes[1], timestamp: "2026-10-01 10:00:00" }] }).ok, false);
  assert.equal(validateHistoricalTickDataset({ metadata, quotes: [quotes[0], { ...quotes[1], bid: 0 }] }).ok, false);
});
