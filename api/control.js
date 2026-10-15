import { hasOwnerSession } from "../lib/auth.js";

export default async function handler(req, res) {
  if (req.method !== "POST") { res.setHeader("Allow","POST"); return res.status(405).json({ error: "Method not allowed" }); }
  if (!hasOwnerSession(req)) return res.status(401).json({ error: "Owner login required. Sign in to use dashboard controls." });
  const { action } = req.body || {};
  const allowed = new Set(["start","pause","analyze-all","history","risk","emergency-stop"]);
  if (!allowed.has(action)) return res.status(400).json({ error: "Unknown action" });
  if (action === "emergency-stop") return res.status(503).json({ error: "The bot is fail-closed and cannot execute trades. Persistent emergency-stop state is not configured." });
  return res.status(503).json({ error: "Control not executed: durable storage is not configured. The engine remains paused." });
}