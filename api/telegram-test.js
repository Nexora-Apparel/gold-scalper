import { hasOwnerSession } from "../lib/auth.js";
import { sendTelegramMessage } from "../lib/telegram.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!hasOwnerSession(req)) return res.status(401).json({ error: "Owner login required." });
  const result = await sendTelegramMessage(
    "GOLD SCALPER — Telegram test successful.\nThis confirms delivery only; it is not a trading signal."
  );
  if (result.status === "NOT_CONFIGURED") {
    return res.status(503).json({ ok: false, ...result });
  }
  if (!result.sent) return res.status(502).json({ ok: false, ...result });
  return res.status(200).json({ ok: true, status: result.status, message: "Test message delivered to Telegram.", messageId: result.messageId });
}
