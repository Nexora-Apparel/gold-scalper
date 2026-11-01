import { getRsiRejectionAlertState, saveRsiRejectionAlertState } from "./storage.js";
import { formatRsiRejectionSummary, recordDashboardMessage } from "./signal-formatters.js";

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
// new dashboard journal message every time a support/resistance calculation shifts.
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
// is held. A setup family is recorded at most once per six-hour episode, even
// if a scan briefly reports no setup or the calculated zone price shifts.
// Failed journal writes remain retryable on later scans.
export async function processRsiRejectionAlert(sql, symbol, result) {
  if (result?.marketDataVerified !== true) {
    return { attempted: false, recorded: false, reason: "MARKET_DATA_NOT_VERIFIED" };
  }

  const previous = await getRsiRejectionAlertState(sql, symbol);
  const setup = result?.potentialSetup;
  if (!setup) {
    // Keep the last successful alert through brief clean scans. A transient
    // NO_TRADE result must not reset deduplication and trigger the same warning
    // again on the very next 15-minute pass.
    return { attempted: false, recorded: false, reason: "NO_RSI_REJECTION" };
  }

  const now = Date.now();
  const fingerprint = rsiRejectionFingerprint(symbol, setup);
  const familyFingerprint = rsiRejectionFamilyFingerprint(symbol, setup);
  const previousFamily = previous?.familyFingerprint || previous?.fingerprint;
  const lastRecordedMs = Date.parse(previous?.recordedAt || "");
  if (
    previousFamily === familyFingerprint &&
    previous.recorded === true &&
    Number.isFinite(lastSentMs) &&
    now - lastSentMs < RSI_REJECTION_COOLDOWN_MS
  ) {
    return { attempted: false, recorded: true, suppressed: true, reason: "DUPLICATE_SETUP_COOLDOWN" };
  }

  const delivery = await recordDashboardMessage(formatRsiRejectionSummary(result, symbol));
  await saveRsiRejectionAlertState(sql, {
    fingerprint,
    familyFingerprint,
    recorded: delivery.recorded === true,
    lastAttemptAt: new Date(now).toISOString(),
    ...(delivery.recorded ? { recordedAt: new Date(now).toISOString() } : {}),
    ...(!delivery.recorded ? { lastError: delivery.message || "Dashboard journal recording failed." } : {})
  }, symbol);

  return {
    attempted: true,
    recorded: delivery.recorded === true,
    suppressed: false,
    reason: delivery.recorded ? "RSI_REJECTION_RECORDED" : "RSI_REJECTION_RECORD_FAILED",
    ...(delivery.message ? { deliveryMessage: delivery.message } : {})
  };
}
