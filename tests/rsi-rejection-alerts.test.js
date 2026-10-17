import test from "node:test";
import assert from "node:assert/strict";
import { formatRsiRejectionMessage } from "../lib/telegram.js";
import { rsiRejectionFingerprint, rsiRejectionFamilyFingerprint, RSI_REJECTION_COOLDOWN_MS } from "../lib/rsi-rejection-alerts.js";

function rejectedSetup(overrides = {}) {
  return {
    status: "NO_TRADE",
    marketDataVerified: true,
    reason: "MSNR setup found, but M15 RSI momentum does not confirm the H1 direction.",
    indicators: { rsi: 72.4 },
    potentialSetup: {
      side: "BUY",
      setup: "MSNR support rejection",
      h1Direction: "BUY",
      h1Trend: "Bullish",
      zone: { type: "support", price: 65000.123, touches: 3, sources: ["H1", "M15"] },
      rsi: 72.4,
      candleTime: "2026-10-17T19:15:00Z",
      ...overrides
    }
  };
}

test("RSI rejection alert is clearly marked as potential and not confirmed", () => {
  const message = formatRsiRejectionMessage(rejectedSetup(), "BTCUSD");
  assert.match(message, /BTCUSD POTENTIAL SETUP — RSI REJECTION/);
  assert.match(message, /Direction:<\/b> BUY/);
  assert.match(message, /M15 RSI:<\/b> 72\.40/);
  assert.match(message, /Status: NOT CONFIRMED/);
  assert.match(message, /Do not enter a trade based on this alert/);
  assert.doesNotMatch(message, /Entry:<\/b>|Take-profit|Stop-loss price/);
});

test("RSI rejection alert safely escapes untrusted setup text", () => {
  const message = formatRsiRejectionMessage(rejectedSetup({ setup: "<script>bad</script>" }), "XAUUSD");
  assert.doesNotMatch(message, /<script>/i);
  assert.match(message, /bad/);
});

test("deduplication fingerprint stays stable for the same setup across scans", () => {
  const first = rejectedSetup().potentialSetup;
  const nextScan = { ...first, candleTime: "2026-10-17T19:30:00Z", rsi: 73.1 };
  assert.equal(rsiRejectionFingerprint("BTCUSD", first), rsiRejectionFingerprint("BTCUSD", nextScan));
});

test("deduplication fingerprint changes when market, direction, or zone changes", () => {
  const setup = rejectedSetup().potentialSetup;
  assert.notEqual(rsiRejectionFingerprint("BTCUSD", setup), rsiRejectionFingerprint("XAUUSD", setup));
  assert.notEqual(rsiRejectionFingerprint("BTCUSD", setup), rsiRejectionFingerprint("BTCUSD", { ...setup, side: "SELL" }));
  assert.notEqual(rsiRejectionFingerprint("BTCUSD", setup), rsiRejectionFingerprint("BTCUSD", { ...setup, zone: { ...setup.zone, price: 65100 } }));
});

test("same RSI rejection family remains stable when calculated zone price shifts", () => {
  const setup = rejectedSetup().potentialSetup;
  const shiftedZone = { ...setup, zone: { ...setup.zone, price: 81686.762 } };
  assert.equal(
    rsiRejectionFamilyFingerprint("BTCUSD", setup),
    rsiRejectionFamilyFingerprint("BTCUSD", shiftedZone)
  );
  assert.equal(RSI_REJECTION_COOLDOWN_MS, 6 * 60 * 60 * 1000);
});

test("different side or zone type is treated as a different rejection family", () => {
  const setup = rejectedSetup().potentialSetup;
  assert.notEqual(
    rsiRejectionFamilyFingerprint("BTCUSD", setup),
    rsiRejectionFamilyFingerprint("BTCUSD", { ...setup, side: "SELL" })
  );
  assert.notEqual(
    rsiRejectionFamilyFingerprint("BTCUSD", setup),
    rsiRejectionFamilyFingerprint("BTCUSD", { ...setup, zone: { ...setup.zone, type: "resistance" } })
  );
});
