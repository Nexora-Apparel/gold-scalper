import { ensureStorage, getControlState, getStoredSettings, getActiveSignal } from "../lib/storage.js";
import { getGoldMarketStatus } from "../lib/market-hours.js";

function withinSession(settings, now = new Date()) {
  if (settings.scanMode === "24h") return true;
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Lagos", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const current = Number(p.find(x => x.type === "hour")?.value) * 60 + Number(p.find(x => x.type === "minute")?.value);
  const a = String(settings.sessionStart || "08:00").split(":").map(Number);
  const b = String(settings.sessionEnd || "20:00").split(":").map(Number);
  const start = a[0] * 60 + a[1], end = b[0] * 60 + b[1];
  return start < end ? current >= start && current < end : current >= start || current < end;
}

export default async function handler(req, res) {
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); return res.status(405).json({ error: "Method not allowed" }); }
  const keyConfigured = Boolean(process.env.TWELVEDATA_API_KEY);
  const telegramConfigured = Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
  const cronSecretConfigured = Boolean(process.env.CRON_SECRET);
  try {
    const sql = await ensureStorage();
    const control = await getControlState(sql);
    const settings = await getStoredSettings(sql);
    const activeSignal = await getActiveSignal(sql);
    const activeSignalNeedsMonitoring = Boolean(activeSignal && ["WAITING_FOR_ENTRY", "CONFIRMATION_PENDING_DELIVERY"].includes(activeSignal.state));
    const sessionActive = withinSession(settings);
    const marketStatus = getGoldMarketStatus();
    return res.status(200).json({
      application: "ONLINE",
      database: "CONNECTED",
      marketData: keyConfigured ? "Key configured; live feed unverified" : "API key required",
      marketConnected: false,
      marketOpen: marketStatus.open,
      marketStatus: marketStatus.status,
      marketStatusReason: marketStatus.reason,
      marketKeyConfigured: keyConfigured,
      telegram: telegramConfigured ? "Configured; run a test to verify current deployment delivery" : "Not configured",
      telegramConfigured,
      scheduler: cronSecretConfigured
        ? "API scheduler authentication configured; GitHub Actions secret and workflow activation must also be verified"
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
      note: "Database connection verified for this request. Market data is not marked verified until fresh completed candles pass validation. Manual review only; no broker execution."
    });
  } catch (error) {
    console.error("Status storage failure:", error?.message || "unknown error");
    return res.status(503).json({
      application: "DEGRADED",
      database: "UNAVAILABLE",
      marketData: keyConfigured ? "Key configured; live feed unverified" : "API key required",
      marketConnected: false,
      marketKeyConfigured: keyConfigured,
      scheduler: cronSecretConfigured ? "API secret configured; GitHub Actions workflow not verified" : "Not configured; CRON_SECRET is missing",
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
