import { ensureStorage, getControlState } from "../lib/storage.js";

export default async function handler(req, res) {
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); return res.status(405).json({ error: "Method not allowed" }); }
  const keyConfigured = Boolean(process.env.TWELVEDATA_API_KEY);
  const telegramConfigured = Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
  try {
    const sql = await ensureStorage();
    const control = await getControlState(sql);
    return res.status(200).json({
      application: "ONLINE",
      database: "CONNECTED",
      marketData: keyConfigured ? "Key configured; live feed unverified" : "API key required",
      marketConnected: false,
      marketKeyConfigured: keyConfigured,
      telegram: telegramConfigured ? "Configured; delivery not yet tested" : "Not configured",
      telegramConfigured,
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
      engine: "PAUSED",
      emergencyStop: true,
      safeMode: true,
      backendConfigured: false,
      mode: "manual",
      note: "Persistent storage could not be verified. The signal engine must remain fail-closed."
    });
  }
}
