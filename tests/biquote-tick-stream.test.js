import test from "node:test";
import assert from "node:assert/strict";
import { BiquoteTickStream } from "../lib/biquote-tick-stream.js";

class FakeConnection {
  state = "Disconnected";
  handlers = new Map();
  calls = [];
  on(name, fn) { this.handlers.set(name, fn); }
  off(name) { this.handlers.delete(name); }
  onreconnected(fn) { this.reconnected = fn; }
  onclose(fn) { this.closed = fn; }
  async start() { this.state = "Connected"; }
  async stop() { this.state = "Disconnected"; }
  async invoke(method, symbols) { this.calls.push({ method, symbols }); }
  sendTick(payload) { this.handlers.get("ReceiveTick")?.(payload); }
}

const tick = (symbol, now) => ({
  symbol, bid: 2650.1, ask: 2650.2,
  timestamp: new Date(now).toISOString(),
  marketState: "open", stale: false
});

test("subscribes to both metals and normalizes incoming ticks", async () => {
  const now = Date.parse("2026-11-01T07:00:00.000Z");
  const connection = new FakeConnection();
  const received = [];
  const stream = new BiquoteTickStream({
    connection, now: () => now, onTick: (quote) => received.push(quote)
  });
  await stream.start();
  connection.sendTick(tick("XAUUSD", now));
  assert.equal(connection.calls[0].method, "Subscribe");
  assert.deepEqual(connection.calls[0].symbols, ["XAUUSD", "XAGUSD"]);
  assert.equal(received.length, 1);
  assert.equal(received[0].provider, "biquote");
  assert.equal(received[0].executableForExness, false);
  await stream.stop();
});

test("rejects unsupported symbols and stale ticks", async () => {
  const now = Date.now();
  const connection = new FakeConnection();
  const errors = [];
  assert.throws(() => new BiquoteTickStream({ connection, symbols: ["BTCUSD"] }));
  const stream = new BiquoteTickStream({
    connection, now: () => now, onError: (error) => errors.push(error)
  });
  await stream.start();
  connection.sendTick({ ...tick("XAUUSD", now - 6000) });
  assert.equal(errors.length, 1);
  assert.equal(stream.getLatest("XAUUSD"), null);
  await stream.stop();
});

test("re-subscribes after reconnect", async () => {
  const connection = new FakeConnection();
  const stream = new BiquoteTickStream({ connection });
  await stream.start();
  await connection.reconnected();
  assert.equal(connection.calls.filter((call) => call.method === "Subscribe").length, 2);
  await stream.stop();
});
