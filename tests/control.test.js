import test from "node:test";
import assert from "node:assert/strict";
import { startMessage } from "../api/control.js";

test("start message includes BTCUSD only when saved settings enable it", () => {
  const enabled = startMessage({ btcEnabled: true });
  assert.match(enabled, /XAUUSD and BTCUSD/);
  assert.match(enabled, /BTCUSD monitoring is enabled/);
  assert.match(enabled, /no broker orders are placed/i);

  const disabled = startMessage({ btcEnabled: false });
  assert.match(disabled, /Scheduled XAUUSD monitoring enabled/);
  assert.match(disabled, /BTCUSD remains disabled in saved settings/);
  assert.doesNotMatch(disabled, /Scheduled XAUUSD and BTCUSD monitoring enabled/);
});
