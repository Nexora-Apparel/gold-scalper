import { hasOwnerSession } from "../lib/auth.js";
import { ensureStorage, getStoredSettings, saveStoredSettings } from "../lib/storage.js";

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!hasOwnerSession(req)) {
    return res.status(401).json({ error: "Owner login required to view or change saved settings." });
  }

  try {
    const sql = await ensureStorage();
    if (req.method === "GET") {
      const settings = await getStoredSettings(sql);
      return res.status(200).json({ settings, persisted: true });
    }

    const b = req.body || {};
    const s = {
      balance: Number(b.balance),
      currency: b.currency,
      riskPercent: Number(b.riskPercent),
      minQuality: Number(b.minQuality),
      maxSignals: Number(b.maxSignals),
      timeframe: b.timeframe,
      strategyMode: b.strategyMode === "EMA_RIBBON_RSI" ? "EMA_RIBBON_RSI" : "MSNR_SMC",
      atrTargetMultiple: Number(b.atrTargetMultiple) === 3 ? 3 : 4,
      mode: "manual",
      goldEnabled: b.goldEnabled === true,
      btcEnabled: b.btcEnabled === true,
      majorsEnabled: b.majorsEnabled === true,
      newsEnabled: true,
      scanMode: b.scanMode,
      sessionStart: b.sessionStart,
      sessionEnd: b.sessionEnd,
      timezone: "Africa/Lagos"
    };
    if (!(s.balance > 0) || !["USD", "NGN", "EUR", "GBP"].includes(s.currency) ||
        !(s.riskPercent >= 0.1 && s.riskPercent <= 1) ||
        ![65, 70, 75, 80].includes(s.minQuality) ||
        ![1, 2, 3].includes(s.maxSignals) ||
        !["M5", "M15"].includes(s.timeframe) ||
        !["MSNR_SMC", "EMA_RIBBON_RSI"].includes(s.strategyMode) ||
        !["session", "24h"].includes(s.scanMode) ||
        !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.sessionStart) ||
        !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.sessionEnd) ||
        s.sessionStart === s.sessionEnd ||
        b.mode !== "manual") {
      return res.status(400).json({ error: "Invalid settings." });
    }
    await saveStoredSettings(sql, s);
    return res.status(200).json({ persisted: true, settings: s, strategyMode: s.strategyMode, message: s.strategyMode === "EMA_RIBBON_RSI" ? `Settings saved. EMA Ribbon + RSI is active on ${s.timeframe}; ATR stop is 2× and target is ${s.atrTargetMultiple}×.` : "Settings saved. Combined MSNR + SMC remains active." });
  } catch (error) {
    console.error("Settings storage failure:", error?.message || "unknown error");
    return res.status(503).json({ persisted: false, error: "Database unavailable. Settings were not changed." });
  }
}
