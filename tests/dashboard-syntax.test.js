import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

test("dashboard inline JavaScript parses without executing it", () => {
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
  const inline = scripts.map((match) => match[1]).filter((source) => source.trim() && !source.trim().startsWith("{"));
  assert.ok(inline.length > 0, "expected dashboard inline script");
  assert.doesNotThrow(() => new Function(inline[inline.length - 1]));
});

test("dashboard exposes BTC controls and keeps broker execution disconnected", () => {
  assert.match(html, /ANALYZE BTCUSD NOW/);
  assert.match(html, /SUPPORTED PAIRS/);
  assert.match(html, /id="btcEnabled"/);
  assert.match(html, /\/api\/analyze-btc/);
  assert.match(html, /No broker order execution or automatic trading is connected/);
  assert.match(html, /PENDING ENTRY — Setup identified; wait for the planned entry/);
  assert.match(html, /ENTRY CONFIRMED — Entry conditions were satisfied/);
  assert.match(html, /INVALIDATED \/ EXPIRED — The setup is no longer valid; do not enter/);
});
