import { ensureStorage, getControlState, getStoredSettings, getActiveSignal, getRecordedOutcome } from "../lib/storage.js";

const MARKET_FRESHNESS_MS = 45 * 60 * 1000;

function withinSession(settings, now = new Date()) {
  if (settings.scanMode === "24h") return true;
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Lagos", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const current = Number(p.find(x => x.type === "hour")?.value) * 60 + Number(p.find(x => x.type === "minute")?.value);
  const a = String(settings.sessionStart || "08:00").split(":").map(Number);
  const b = String(settings.sessionEnd || "20:00").split(":").map(Number);
  const start = a[0] * 60 + a[1], end = b[0] * 60 + b[1];
  return start < end ? current >= start && current < end : current >= start || current < end;
}

function marketHealth(latest, keyConfigured, now = Date.now()) {
  const checkedAt = latest?.result?.checkedAt || latest?.createdAt || null;
  const checkedAtMs = checkedAt ? Date.parse(checkedAt) : NaN;
  const ageMs = now - checkedAtMs;
  const verified = keyConfigured &&
    latest?.result?.marketDataVerified === true &&
    Number.isFinite(checkedAtMs) &&
    ageMs >= 0 &&
    ageMs <= MARKET_FRESHNESS_MS;
  return {
    marketConnected: Boolean(verified),
    marketData: !keyConfigured
      ? "API key required"
      : verified
        ? "Fresh completed candles verified"
        : "Key configured; no recent fresh-candle verification",
    marketDataLastVerifiedAt: latest?.result?.marketDataVerified === true && Number.isFinite(checkedAtMs)
      ? new Date(checkedAtMs).toISOString()
      : null,
    lastAnalysisAt: checkedAt && Number.isFinite(checkedAtMs) ? new Date(checkedAtMs).toISOString() : null,
    lastAnalysisStatus: latest?.status || null,
    lastAnalysisMarketDataVerified: latest?.result?.marketDataVerified === true
  };
}

export default async function handler(req, res) {
  // Status is live operational telemetry; never let an intermediary reuse an old health snapshot.
  res.setHeader("Cache-Control", "no-store, max-age=0");
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); return res.status(405).json({ error: "Method not allowed" }); }
  const keyConfigured = Boolean(process.env.TWELVEDATA_API_KEY);
  const telegramConfigured = Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
  const cronSecretConfigured = Boolean(process.env.CRON_SECRET);
  try {
    const sql = await ensureStorage();
    const control = await getControlState(sql);
    const settings = await getStoredSettings(sql);
    let activeSignal = await getActiveSignal(sql);
    if (activeSignal?.state === "CONFIRMED_AND_NOTIFIED" && activeSignal.result?.signal?.signalRef) {
      const outcome = await getRecordedOutcome(sql, activeSignal.result.signal.signalRef);
      if (outcome) {
        activeSignal = { ...activeSignal, state: "CLOSED_WITH_OUTCOME", recordedOutcome: outcome.outcome };
      }
    }
    const latestRows = await sql`SELECT status, result, created_at AS "createdAt"
      FROM gold_scalper_history ORDER BY created_at DESC, id DESC LIMIT 1`;
    const latestAnalysis = latestRows[0] || null;
    const health = marketHealth(latestAnalysis, keyConfigured);
    const activeSignalNeedsMonitoring = Boolean(activeSignal && (["WAITING_FOR_ENTRY", "CONFIRMATION_PENDING_DELIVERY", "CONFIRMED_AND_NOTIFIED"].includes(activeSignal.state) || (activeSignal.state === "CONFIRMATION_EXPIRED" && activeSignal.lifecycleNotification?.sent !== true)));
    const sessionActive = withinSession(settings);
    return res.status(200).json({
      application: "ONLINE",
      database: "CONNECTED",
      ...health,
      marketKeyConfigured: keyConfigured,
      telegram: telegramConfigured ? "Configured; owner-authenticated delivery test available" : "Not configured",
      telegramConfigured,
      scheduler: cronSecretConfigured
        ? "Scheduler authentication configured; see lastAnalysisAt for the latest recorded monitoring result"
        : "Not configured; CRON_SECRET is missing, so scheduled monitoring cannot authenticate",
      cronSecretConfigured,
      scanMode: settings.scanMode || "session",
      sessionStart: settings.sessionStart || "08:00",
      sessionEnd: settings.sessionEnd || "20:00",
      sessionTimezone: "Africa/Lagos",
      sessionActive,
      activeSignalNeedsMonitoring,
      engine: control.emergencyStop ? "EMERGENCY STOP" : (control.engine || "PAUSED"),
      emergencyStop: control.emergencyStop === true,
      safeMode: true,
      backendConfigured: true,
      mode: "manual",
      note: "Market connectivity reflects the most recent analysis result and expires after 45 minutes without fresh-candle verification. Manual review only; no broker execution."
    });
  } catch (error) {
    console.error("Status storage failure:", error?.message || "unknown error");
    return res.status(503).json({
      application: "DEGRADED",
      database: "UNAVAILABLE",
      marketData: keyConfigured ? "Key configured; live feed unverified" : "API key required",
      marketConnected: false,
      marketKeyConfigured: keyConfigured,
      scheduler: cronSecretConfigured ? "API secret configured; latest monitoring result unavailable" : "Not configured; CRON_SECRET is missing",
      cronSecretConfigured,
      engine: "PAUSED",
      emergencyStop: true,
      safeMode: true,
      backendConfigured: false,
      mode: "manual",
      note: "Persistent storage could not be verified. The signal engine must remain fail-closed."
    });
  }
}

export { marketHealth };
