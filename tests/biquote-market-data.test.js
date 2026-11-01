import test from "node:test";
import assert from "node:assert/strict";
import { normalizeBiquoteTick, fetchBiquoteQuotes } from "../lib/biquote-market-data.js";

const NOW = Date.parse("2026-11-01T09:00:00.000Z");
const tick = (overrides = {}) => ({
  symbol: "XAUUSD",
  bid: 4391.999,
  ask: 4392.181,
  timestamp: new Date(NOW - 500).toISOString(),
  quoteAgeSeconds: 0.5,
  marketState: "open",
  stale: false,
  source: "MetaTrader 5 (Broker 1)",
  ...overrides
});

test("normalizes fresh XAUUSD bid/ask and derives midpoint", () => {
  const quote = normalizeBiquoteTick(tick(), { symbol: "XAUUSD", now: NOW });
  assert.equal(quote.mid, (4391.999 + 4392.181) / 2);
  assert.equal(quote.spread, 0.18200000000040745);
  assert.equal(quote.executableForExness, false);
});

test("accepts fresh XAGUSD quotes", () => {
  const quote = normalizeBiquoteTick(tick({ symbol: "XAGUSD", bid: 30, ask: 30.02 }), {
    symbol: "XAGUSD", now: NOW
  });
  assert.equal(quote.symbol, "XAGUSD");
});

test("rejects stale, closed, malformed and mismatched quotes", () => {
  assert.throws(() => normalizeBiquoteTick(tick({ timestamp: new Date(NOW - 6000).toISOString() }), {
    symbol: "XAUUSD", now: NOW
  }), /stale/);
  assert.throws(() => normalizeBiquoteTick(tick({ marketState: "closed" }), {
    symbol: "XAUUSD", now: NOW
  }), /not open/);
  assert.throws(() => normalizeBiquoteTick(tick({ ask: 4391 }), {
    symbol: "XAUUSD", now: NOW
  }), /Invalid bid\/ask/);
  assert.throws(() => normalizeBiquoteTick(tick(), { symbol: "XAGUSD", now: NOW }), /mismatch/);
});

test("fetches both instruments in one batch and rejects a stale leg", async () => {
  const fetchImpl = async (url) => {
    assert.match(url, /symbols=XAUUSD/);
    assert.match(url, /symbols=XAGUSD/);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        XAUUSD: tick(),
        XAGUSD: tick({ symbol: "XAGUSD", bid: 30, ask: 30.02 })
      })
    };
  };
  const result = await fetchBiquoteQuotes({ fetchImpl, now: NOW });
  assert.deepEqual(Object.keys(result.quotes), ["XAUUSD", "XAGUSD"]);

  const staleFetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ XAUUSD: tick({ timestamp: new Date(NOW - 7000).toISOString() }) })
  });
  await assert.rejects(fetchBiquoteQuotes({ symbols: ["XAUUSD"], fetchImpl: staleFetch, now: NOW }), /stale/);
});
