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
  assert.deepEqual(result, { decided: 2, wins: 1, losses: 1, winRate: 50, netR: 1 });
});
