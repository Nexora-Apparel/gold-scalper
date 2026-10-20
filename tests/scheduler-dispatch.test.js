import test from "node:test";
import assert from "node:assert/strict";
import { bearerMatches } from "../api/scheduler-dispatch.js";
import { getSchedulerHealth } from "../lib/scheduler-health.js";

test("scheduler relay accepts the configured bearer token", () => {
  assert.equal(bearerMatches("Bearer test-secret", "test-secret"), true);
});

test("scheduler relay rejects missing, malformed, or incorrect bearer tokens", () => {
  assert.equal(bearerMatches(undefined, "test-secret"), false);
  assert.equal(bearerMatches("test-secret", "test-secret"), false);
  assert.equal(bearerMatches("Bearer wrong-secret", "test-secret"), false);
  assert.equal(bearerMatches("Bearer test-secret", ""), false);
});


test("scheduler health reports recent and stale heartbeats", () => {
  const now = Date.parse("2026-10-20T12:00:00Z");
  assert.equal(getSchedulerHealth("2026-10-20T11:50:00Z", now).status, "RECENT");
  assert.equal(getSchedulerHealth("2026-10-20T11:30:00Z", now).status, "STALE");
  assert.equal(getSchedulerHealth(null, now).status, "NEVER_RUN");
  assert.equal(getSchedulerHealth("invalid", now).status, "UNVERIFIED");
  assert.equal(getSchedulerHealth("2026-10-20T12:01:00Z", now).status, "UNVERIFIED");
});
