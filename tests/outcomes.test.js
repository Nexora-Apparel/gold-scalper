import test from "node:test";
import assert from "node:assert/strict";
import { summarizeOutcomes, validateOutcomeInput } from "../lib/outcomes.js";

test("accepts a valid manual win outcome", () => {
  const result = validateOutcomeInput({ signalRef: "2026-10-17T02:00:00Z|BUY|4171.250", outcome: "WIN", realizedR: 2, notes: "target reached" });
  assert.equal(result.ok, true);
  assert.equal(result.value.outcome, "WIN");
  assert.equal(result.value.realizedR, 2);
});

test("rejects missing signal reference and unsupported outcomes", () => {
  assert.equal(validateOutcomeInput({ outcome: "WIN" }).ok, false);
  assert.equal(validateOutcomeInput({ signalRef: "ref", outcome: "OPEN" }).ok, false);
});

test("rejects invalid realized R and non-text notes", () => {
  assert.equal(validateOutcomeInput({ signalRef: "ref", outcome: "LOSS", realizedR: 99 }).ok, false);
  assert.equal(validateOutcomeInput({ signalRef: "ref", outcome: "LOSS", realizedR: "NaN" }).ok, false);
  assert.equal(validateOutcomeInput({ signalRef: "ref", outcome: "LOSS", notes: { html: true } }).ok, false);
});

test("caps notes and accepts an outcome without realized R", () => {
  const result = validateOutcomeInput({ signalRef: "ref", outcome: "NOT_TAKEN", notes: "x".repeat(600) });
  assert.equal(result.ok, true);
  assert.equal(result.value.realizedR, null);
  assert.equal(result.value.notes.length, 500);
});

test("summarizes decided trades separately from not-taken outcomes", () => {
  const result = summarizeOutcomes([
    { outcome: "WIN", realizedR: 2 },
    { outcome: "LOSS", realizedR: -1 },
    { outcome: "NOT_TAKEN", realizedR: null }
  ]);
  assert.equal(result.decided, 2);
  assert.equal(result.wins, 1);
  assert.equal(result.losses, 1);
  assert.equal(result.winRate, 50);
  assert.equal(result.netR, 1);
  assert.equal(result.averageR, 0.5);
  assert.equal(result.expectancyR, 0.5);
  assert.equal(result.maxDrawdownR, 1);
  assert.deepEqual(result.bySymbol, [{ key: "Unknown", recordedOutcomes: 3, performanceSampleSize: 2, decided: 2, wins: 1, losses: 1, winRate: 50, netR: 1, averageR: 0.5, expectancyR: 0.5, maxDrawdownR: 1 }]);
});


test("performance metrics include drawdown and symbol/session/quality breakdowns", () => {
  const result = summarizeOutcomes([
    { outcome: "WIN", realizedR: 2, symbol: "XAUUSD", quality: "90", signalCreatedAt: "2026-10-20T02:00:00Z", recordedAt: "2026-10-20T02:20:00Z" },
    { outcome: "LOSS", realizedR: -1, symbol: "XAUUSD", quality: "80", signalCreatedAt: "2026-10-20T10:00:00Z", recordedAt: "2026-10-20T10:20:00Z" },
    { outcome: "BREAKEVEN", realizedR: 0, symbol: "XAUUSD", quality: "75", signalCreatedAt: "2026-10-20T15:00:00Z", recordedAt: "2026-10-20T15:20:00Z" },
    { outcome: "LOSS", realizedR: -2, symbol: "BTCUSD", quality: "95", signalCreatedAt: "2026-10-20T16:00:00Z", recordedAt: "2026-10-20T16:20:00Z" },
    { outcome: "NOT_TAKEN", realizedR: null, symbol: "BTCUSD", quality: "75", signalCreatedAt: "2026-10-20T16:30:00Z", recordedAt: "2026-10-20T16:31:00Z" }
  ]);
  assert.equal(result.recordedOutcomes, 5);
  assert.equal(result.performanceSampleSize, 4);
  assert.equal(result.decided, 3);
  assert.equal(result.winRate, 33.3);
  assert.equal(result.netR, -1);
  assert.equal(result.averageR, -0.25);
  assert.equal(result.expectancyR, -0.333);
  assert.equal(result.maxDrawdownR, 3);
  assert.equal(result.bySymbol.find((x) => x.key === "BTCUSD").netR, -2);
  assert.ok(result.bySession.some((x) => x.key === "Asia (00–08 WAT)"));
  assert.ok(result.byQualityBand.some((x) => x.key === "90+"));
});
