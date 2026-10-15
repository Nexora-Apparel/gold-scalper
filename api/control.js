export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const { action } = req.body || {};
  const allowed = new Set(["start", "pause", "analyze", "analyze-all", "history", "risk", "emergency-stop"]);
  if (!allowed.has(action)) return res.status(400).json({ error: "Unknown action" });
  // Deliberately fail closed until authenticated persistent settings,
  // market-data validation, and owner-only Telegram auth are connected.
  if (action === "emergency-stop") {
    return res.status(503).json({ error: "Emergency-stop persistence is not configured. Do not rely on this endpoint as a live safety control yet." });
  }
  return res.status(503).json({ error: "Control backend is not configured. No action was executed and no signal was generated." });
}
