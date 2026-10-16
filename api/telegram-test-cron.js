import { timingSafeEqual } from "node:crypto";
import { sendTelegramMessage } from "../lib/telegram.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 32) {
    return res.status(503).json({ ok: false, error: "Scheduler authentication is not configured." });
  }

  const supplied = typeof req.headers.authorization === "string"
    ? req.headers.authorization.replace(/^Bearer\s+/i, "")
    : "";
  const expectedBuffer = Buffer.from(secret);
  const suppliedBuffer = Buffer.from(supplied);
  if (expectedBuffer.length !== suppliedBuffer.length ||
      !timingSafeEqual(expectedBuffer, suppliedBuffer)) {
    return res.status(401).json({ ok: false, error: "Unauthorized." });
  }

  const delivery = await sendTelegramMessage(
    "GOLD SCALPER — Production Telegram delivery test successful.\n" +
    "This confirms message delivery only; it is not a trading signal."
  );
  if (delivery.status === "NOT_CONFIGURED") {
    return res.status(503).json({ ok: false, status: delivery.status, error: delivery.message });
  }
  if (!delivery.sent) {
    return res.status(502).json({ ok: false, status: delivery.status, error: delivery.message || "Telegram delivery failed." });
  }
  return res.status(200).json({ ok: true, status: delivery.status, message: "Production Telegram test message delivered.", messageId: delivery.messageId });
}
