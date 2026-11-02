import test from "node:test";
import assert from "node:assert/strict";
import { isWithinTimePartition, partitionTimeSeries } from "../lib/time-partitions.js";

test("uses half-open boundaries so adjacent partitions never share a boundary event", () => {
  const first = { key: "train", startAt: 0, endAt: 10 };
  const second = { key: "validation", startAt: 10, endAt: 20 };
  assert.equal(isWithinTimePartition(10, first.startAt, first.endAt), false);
  assert.equal(isWithinTimePartition(10, second.startAt, second.endAt), true);
});

test("includes the final endpoint only in the final partition", () => {
  const result = partitionTimeSeries([0, 10, 20], [
    { key: "train", startAt: 0, endAt: 10 },
    { key: "heldOutTest", startAt: 10, endAt: 20 }
  ], value => value);
  assert.deepEqual(result, { train: [0], heldOutTest: [10, 20] });
});

test("rejects invalid ranges and excludes malformed timestamps", () => {
  assert.equal(isWithinTimePartition("not-a-date", 0, 10), false);
  assert.equal(isWithinTimePartition(5, 10, 0), false);
});
