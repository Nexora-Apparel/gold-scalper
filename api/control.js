export default async function handler(req, res) {
  if (req.method !== "POST") { res.setHeader("Allow","POST"); return res.status(405).json({ error: "Method not allowed" }); }
  const { action } = req.body || {};
  const allowed = new Set(["start","pause","analyze-all","history","risk","emergency-stop"]);
  if (!allowed.has(action)) return res.status(400).json({ error: "Unknown action" });
  if (action === "emergency-stop") return res.status(503).json({ error: "The bot is already fail-closed and cannot execute trades. Persistent emergency-stop state is not configured." });
  return res.status(503).json({ error: "This control requires owner authentication and durable storage, which are not configured. No action was executed." });
}
