import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const btc = read("../api/analyze-btc.js");
const btcFeed = read("../api/market-data-btc.js");
const gold = read("../api/analyze.js");
const storage = read("../lib/storage.js");
const telegram = read("../lib/telegram.js");
const dashboard = read("../index.html");
const workflow = read("../.github/workflows/gold-scalper-scheduled-monitor.yml");

test("BTCUSD endpoint fetches BTC/USD H1 and M15 candles and a live quote", () => {
  assert.match(btc, /searchParams\.set\("symbol", "BTC\/USD"\)/);
  assert.match(btc, /candles\("1h", 120\)/);
  assert.match(btc, /candles\("15min", 250\)/);
  assert.match(btc, /api\.twelvedata\.com\/price/);
  assert.match(btcFeed, /symbol: "BTC\/USD"/);
  assert.match(btcFeed, /Latest completed BTC\/USD candle is stale/);
});

test("BTC signal lifecycle and history are isolated from XAUUSD", () => {
  assert.match(btc, /getActiveSignal\(sql, "BTCUSD"\)/);
  assert.match(btc, /saveActiveSignal\(sql, active, "BTCUSD"\)/);
  assert.match(btc, /recordBTCHistory\(sql, result\)/);
  assert.match(btc, /result\.signal\.symbol = "BTCUSD"/);
  assert.match(storage, /active_signal:\$\{symbol\}/);
  assert.match(storage, /const symbol = result\?\.signal\?\.symbol \|\| result\?\.symbol \|\| "XAUUSD"/);
  assert.match(telegram, /const symbol = safeText\(s\.symbol \|\| "XAUUSD"\)/);
});

test("BTC analysis is independent of Gold's configured session hours", () => {
  assert.doesNotMatch(btc, /if \(!isWithinSession\(saved\)/);
  assert.match(btc, /saved\.btcEnabled === false/);
  assert.match(storage, /btcEnabled: true/);
});

test("scheduled monitor invokes BTC separately from the Gold session", () => {
  assert.match(workflow, /gold_should_run/);
  assert.match(workflow, /btc_should_run/);
  assert.match(workflow, /\/api\/analyze-btc/);
  assert.match(workflow, /BTC_SHOULD_RUN/);
});

test("dashboard exposes BTC enable, manual analysis, and analyze-enabled-markets controls", () => {
  assert.match(dashboard, /id="btcEnabled"/);
  assert.match(dashboard, /data-action="analyze-btc"/);
  assert.match(dashboard, /api\('\/api\/analyze-btc',s\)/);
  assert.match(dashboard, /btcEnabled:\$\('btcEnabled'\)\.checked/);
});

test("daily signal cap is shared across symbols", () => {
  const countQuery = storage.slice(storage.indexOf("export async function countSignalsToday"), storage.indexOf("export { defaults"));
  assert.match(countQuery, /COUNT\(\*\)::int AS count/);
  assert.doesNotMatch(countQuery, /WHERE[^\n]*symbol\s*=/);
});
