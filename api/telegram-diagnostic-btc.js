import { timingSafeEqual } from "node:crypto";
import { ensureStorage } from "../lib/storage.js";
import { sendTelegramMessage } from "../lib/telegram.js";

function bearerMatches(header, expected) {
  if (typeof header !== "string" || !expected) return false;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return false;
  const supplied = Buffer.from(match[1], "utf8");
  const configured = Buffer.from(expected, "utf8");
  return supplied.length === configured.length && timingSafeEqual(supplied, configured);
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }
  if (!bearerMatches(req.headers?.authorization, process.env.CRON_SECRET)) {
    return res.status(401).json({ ok: false, error: "Valid scheduler authorization required." });
  }
  if (req.body?.diagnostic !== true) {
    return res.status(400).json({ ok: false, error: "Explicit diagnostic flag required." });
  }

  try {
    const sql = await ensureStorage();
    const startedAt = new Date().toISOString();
    const claim = await sql`INSERT INTO gold_scalper_state (state_key, state_value, updated_at)
      VALUES ('btc_telegram_diagnostic', ${JSON.stringify({ sending: true, startedAt })}::jsonb, NOW())
      ON CONFLICT (state_key) DO UPDATE
        SET state_value = EXCLUDED.state_value, updated_at = NOW()
        WHERE COALESCE(gold_scalper_state.state_value->>'sent', 'false') <> 'true'
          AND (
            COALESCE(gold_scalper_state.state_value->>'sending', 'false') <> 'true'
            OR COALESCE((gold_scalper_state.state_value->>'startedAt')::timestamptz, NOW() - INTERVAL '3 minutes')
              < NOW() - INTERVAL '2 minutes'
          )
      RETURNING state_key`;
    if (!claim.length) {
      const rows = await sql`SELECT state_value FROM gold_scalper_state WHERE state_key = 'btc_telegram_diagnostic' LIMIT 1`;
      if (rows[0]?.state_value?.sent === true) {
        return res.status(200).json({
          ok: true,
          alreadySent: true,
          messageSent: false,
          note: "The one-time BTCUSD Telegram connectivity test was already delivered. No duplicate message was sent."
        });
      }
      return res.status(409).json({ ok: false, error: "A BTCUSD Telegram diagnostic is already in progress." });
    }

    const delivery = await sendTelegramMessage(
      "BTCUSD READINESS CHECK — Telegram delivery confirmed.\nThis is a system connectivity test only, NOT a trading signal. No order was generated or placed. BTCUSD remains disabled until all launch checks pass."
    );
    const recordedAt = new Date().toISOString();
    await sql`INSERT INTO gold_scalper_state (state_key, state_value, updated_at)
      VALUES ('btc_telegram_diagnostic', ${JSON.stringify({
        sending: false,
        sent: delivery.sent === true,
        sentAt: delivery.sent ? recordedAt : null,
        lastAttemptAt: recordedAt,
        messageId: delivery.messageId ?? null,
        error: delivery.sent ? null : String(delivery.message || "Telegram delivery failed.").slice(0, 180)
      })}::jsonb, NOW())
      ON CONFLICT (state_key) DO UPDATE
        SET state_value = EXCLUDED.state_value, updated_at = NOW()`;

    if (!delivery.sent) {
      return res.status(502).json({ ok: false, messageSent: false, error: String(delivery.message || "Telegram delivery failed.").slice(0, 180) });
    }
    return res.status(200).json({
      ok: true,
      messageSent: true,
      messageId: delivery.messageId ?? null,
      note: "One-time non-trade Telegram diagnostic delivered. No trading signal was sent."
    });
  } catch (error) {
    console.error("BTC Telegram diagnostic failed:", error?.message || "unknown error");
    return res.status(503).json({ ok: false, messageSent: false, error: "Telegram diagnostic could not complete." });
  }
}

export { bearerMatches };
