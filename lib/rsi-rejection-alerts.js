import { getRsiRejectionAlertState, saveRsiRejectionAlertState } from "./storage.js";
import { formatRsiRejectionMessage, sendTelegramMessage } from "./telegram.js";

export const RSI_REJECTION_COOLDOWN_MS = 6 * 60 * 60 * 1000;

export function rsiRejectionFingerprint(symbol, setup) {
  if (!setup || !["BUY", "SELL"].includes(setup.side)) return null;
  const zoneType = String(setup.zone?.type || "unknown");
  const zonePrice = Number(setup.zone?.price);
  const roundedZone = Number.isFinite(zonePrice) ? zonePrice.toFixed(1) : "unknown";
  return [symbol, setup.side, setup.setup || "MSNR", zoneType, roundedZone].join("|");
}

// Group small price-zone fluctuations into the same warning episode. The exact
// price fingerprint remains available for diagnostics, but it must not cause a
// new Telegram message every time a support/resistance calculation shifts.
export function rsiRejectionFamilyFingerprint(symbol, setup) {
  if (!setup || !["BUY", "SELL"].includes(setup.side)) return null;
  return [
    symbol,
    setup.side,
    String(setup.setup || "MSNR").trim().toLowerCase(),
    String(setup.zone?.type || "unknown").trim().toLowerCase()
  ].join("|");
}

// Call only from a verified market-analysis pass while the shared monitor lock
// is held. A setup family is notified at most once per six-hour episode, even
// if a scan briefly reports no setup or the calculated zone price shifts.
// Failed deliveries remain retryable on later scans.
export async function processRsiRejectionAlert(sql, symbol, result) {
  if (result?.marketDataVerified !== true) {
    return { attempted: false, sent: false, reason: "MARKET_DATA_NOT_VERIFIED" };
  }

  const previous = await getRsiRejectionAlertState(sql, symbol);
  const setup = result?.potentialSetup;
  if (!setup) {
    // Keep the last successful alert through brief clean scans. A transient
    // NO_TRADE result must not reset deduplication and trigger the same warning
    // again on the very next 15-minute pass.
    return { attempted: false, sent: false, reason: "NO_RSI_REJECTION" };
  }

  const now = Date.now();
  const fingerprint = rsiRejectionFingerprint(symbol, setup);
  const familyFingerprint = rsiRejectionFamilyFingerprint(symbol, setup);
  const previousFamily = previous?.familyFingerprint || previous?.fingerprint;
  const lastSentMs = Date.parse(previous?.sentAt || "");
  if (
    previousFamily === familyFingerprint &&
    previous.sent === true &&
    Number.isFinite(lastSentMs) &&
    now - lastSentMs < RSI_REJECTION_COOLDOWN_MS
  ) {
    return { attempted: false, sent: true, suppressed: true, reason: "DUPLICATE_SETUP_COOLDOWN" };
  }

  const delivery = await sendTelegramMessage(formatRsiRejectionMessage(result, symbol));
  await saveRsiRejectionAlertState(sql, {
    fingerprint,
    familyFingerprint,
    sent: delivery.sent === true,
    lastAttemptAt: new Date(now).toISOString(),
    ...(delivery.sent ? { sentAt: new Date(now).toISOString(), messageId: delivery.messageId ?? null } : {}),
    ...(!delivery.sent ? { lastError: delivery.message || "Telegram delivery failed." } : {})
  }, symbol);

  return {
    attempted: true,
    sent: delivery.sent === true,
    suppressed: false,
    reason: delivery.sent ? "RSI_REJECTION_ALERT_SENT" : "RSI_REJECTION_ALERT_DELIVERY_FAILED",
    ...(delivery.message ? { deliveryMessage: delivery.message } : {})
  };
}
