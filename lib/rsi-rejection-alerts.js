import { getRsiRejectionAlertState, saveRsiRejectionAlertState } from "./storage.js";
import { formatRsiRejectionMessage, sendTelegramMessage } from "./telegram.js";

export function rsiRejectionFingerprint(symbol, setup) {
  if (!setup || !["BUY", "SELL"].includes(setup.side)) return null;
  const zoneType = String(setup.zone?.type || "unknown");
  const zonePrice = Number(setup.zone?.price);
  const roundedZone = Number.isFinite(zonePrice) ? zonePrice.toFixed(1) : "unknown";
  return [symbol, setup.side, setup.setup || "MSNR", zoneType, roundedZone].join("|");
}

// Call only from a verified market-analysis pass while the shared monitor lock
// is held. An identical setup is sent once; failed deliveries are retried on
// later scans, and a clean scan resets the dedupe state for a future episode.
export async function processRsiRejectionAlert(sql, symbol, result) {
  if (result?.marketDataVerified !== true) {
    return { attempted: false, sent: false, reason: "MARKET_DATA_NOT_VERIFIED" };
  }

  const previous = await getRsiRejectionAlertState(sql, symbol);
  const setup = result?.potentialSetup;
  if (!setup) {
    if (previous?.fingerprint) {
      await saveRsiRejectionAlertState(sql, { fingerprint: null, sent: false }, symbol);
    }
    return { attempted: false, sent: false, reason: "NO_RSI_REJECTION" };
  }

  const fingerprint = rsiRejectionFingerprint(symbol, setup);
  if (previous?.fingerprint === fingerprint && previous.sent === true) {
    return { attempted: false, sent: true, suppressed: true, reason: "DUPLICATE_SETUP" };
  }

  const delivery = await sendTelegramMessage(formatRsiRejectionMessage(result, symbol));
  await saveRsiRejectionAlertState(sql, {
    fingerprint,
    sent: delivery.sent === true,
    lastAttemptAt: new Date().toISOString(),
    ...(delivery.sent ? { messageId: delivery.messageId ?? null } : {}),
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
