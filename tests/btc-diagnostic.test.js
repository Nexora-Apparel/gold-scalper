import test from "node:test";
import assert from "node:assert/strict";
import { bearerMatches } from "../api/diagnose-btc.js";

test("BTC read-only diagnostic accepts the exact configured bearer secret", () => {
  assert.equal(bearerMatches("Bearer test-secret", "test-secret"), true);
});

test("BTC read-only diagnostic rejects wrong, missing, or malformed credentials", () => {
  assert.equal(bearerMatches("Bearer wrong-secret", "test-secret"), false);
  assert.equal(bearerMatches(undefined, "test-secret"), false);
  assert.equal(bearerMatches("Basic test-secret", "test-secret"), false);
  assert.equal(bearerMatches("Bearer test-secret", ""), false);
});
