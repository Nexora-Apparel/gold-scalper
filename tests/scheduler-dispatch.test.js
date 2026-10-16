import test from "node:test";
import assert from "node:assert/strict";
import { bearerMatches } from "../api/scheduler-dispatch.js";

test("scheduler relay accepts the configured bearer token", () => {
  assert.equal(bearerMatches("Bearer test-secret", "test-secret"), true);
});

test("scheduler relay rejects missing, malformed, or incorrect bearer tokens", () => {
  assert.equal(bearerMatches(undefined, "test-secret"), false);
  assert.equal(bearerMatches("test-secret", "test-secret"), false);
  assert.equal(bearerMatches("Bearer wrong-secret", "test-secret"), false);
  assert.equal(bearerMatches("Bearer test-secret", ""), false);
});
