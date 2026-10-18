import test from "node:test";
import assert from "node:assert/strict";
import { bearerMatches } from "../api/market-data-btc.js";

test("BTC Telegram diagnostic accepts the exact scheduler bearer secret", () => {
  assert.equal(bearerMatches("Bearer test-secret", "test-secret"), true);
});

test("BTC Telegram diagnostic rejects wrong or missing credentials", () => {
  assert.equal(bearerMatches("Bearer wrong-secret", "test-secret"), false);
  assert.equal(bearerMatches(undefined, "test-secret"), false);
  assert.equal(bearerMatches("Basic test-secret", "test-secret"), false);
  assert.equal(bearerMatches("Bearer test-secret", ""), false);
});
