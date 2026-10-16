import { hasOwnerSession } from "../lib/auth.js";
import { ensureStorage, getControlState, saveControlState, getStoredSettings, getHistory } from "../lib/storage.js";

export default async function handler(req, res) {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Method not allowed" }); }
  if (!hasOwnerSession(req)) return res.status(401).json({ error: "Owner login required. Sign in to use dashboard controls." });

  const { action } = req.body || {};
  const allowed = new Set(["start", "pause", "analyze-all", "history", "risk", "emergency-stop", "reset-emergency-stop"]);
  if (!allowed.has(action)) return res.status(400).json({ error: "Unknown action" });

  try {
    const sql = await ensureStorage();
    const state = await getControlState(sql);

    if (action === "history") {
      const rows = await getHistory(sql, 50);
      return res.status(200).json({ message: rows.length ? "Recent signal history" : "No analysis history yet.", history: rows });
    }
    if (action === "risk") {
      const settings = await getStoredSettings(sql);
      return res.status(200).json({ message: "Saved risk settings", settings });
    }
    if (action === "analyze-all") {
      return res.status(200).json({ message: "Only XAUUSD is currently supported by the verified strategy. Use ANALYZE GOLD NOW; other pairs were not analyzed.", supportedSymbols: ["XAUUSD"] });
    }
    if (action === "emergency-stop") {
      const next = { ...state, engine: "PAUSED", emergencyStop: true, mode: "manual", updatedAt: new Date().toISOString() };
      await saveControlState(sql, next);
      return res.status(200).json({ message: "EMERGENCY STOP ACTIVE. Analysis is blocked until you explicitly reset the stop.", control: next });
    }
    if (action === "reset-emergency-stop") {
      const next = { ...state, engine: "PAUSED", emergencyStop: false, mode: "manual", updatedAt: new Date().toISOString() };
      await saveControlState(sql, next);
      return res.status(200).json({ message: "Emergency stop reset. Engine remains PAUSED; press START BOT when ready.", control: next });
    }
    if (action === "start") {
      if (state.emergencyStop) return res.status(409).json({ error: "Emergency stop is active. Confirm a reset first." });
      const next = { ...state, engine: "RUNNING", mode: "manual", updatedAt: new Date().toISOString() };
      await saveControlState(sql, next);
      return res.status(200).json({ message: "Signal engine started in manual-review mode. No trades will be placed automatically.", control: next });
    }
    if (action === "pause") {
      const next = { ...state, engine: "PAUSED", mode: "manual", updatedAt: new Date().toISOString() };
      await saveControlState(sql, next);
      return res.status(200).json({ message: "Signal engine paused. No new analysis signals will be generated.", control: next });
    }
  } catch (error) {
    console.error("Control storage failure:", error?.message || "unknown error");
    return res.status(503).json({ error: "Control action failed because persistent storage is unavailable. No success is assumed." });
  }
}
