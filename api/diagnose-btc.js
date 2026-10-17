import { timingSafeEqual } from "node:crypto";
import { analyzeGold } from "../lib/strategy.js";
import { validateCandles } from "./analyze-btc.js";
import { ensureStorage } from "../lib/storage.js";
import { sendTelegramMessage } from "../lib/telegram.js";

export function bearerMatches(header, expected) {
  if (typeof header !== "string" || !expected) return false;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return false;
  const supplied = Buffer.from(match[1], "utf8");
  const configured = Buffer.from(expected, "utf8");
  return supplied.length === configured.length && timingSafeEqual(supplied, configured);
}

async function providerJson(url, signal) {
  const response = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || payload.status === "error") {
    throw new Error(typeof payload?.message === "string" ? payload.message.slice(0, 180) : "Market-data provider request failed.");
  }
  return payload;
}

function timeSeriesUrl(key, interval, size) {
  const url = new URL("https://api.twelvedata.com/time_series");
  url.searchParams.set("symbol", "BTC/USD");
  url.searchParams.set("interval", interval);
  url.searchParams.set("outputsize", String(size));
  url.searchParams.set("format", "JSON");
  url.searchParams.set("timezone", "UTC");
  url.searchParams.set("apikey", key);
  return url;
}

async function runTelegramDiagnostic(res) {
  try {
    const sql = await ensureStorage();
    const startedAt = new Date().toISOString();
    const claim = await sql`INSERT INTO gold_scalper_state (state_key, state_value, updated_at)
      VALUES ('btc_telegram_diagnostic', ${JSON.stringify({ sending: true, startedAt })}::jsonb, NOW())
      ON CONFLICT (state_key) DO UPDATE
        SET state_value = EXCLUDED.state_value, updated_at = NOW()
        WHERE COALESCE(gold_scalper_state.state_value->>'sent', 'false') <> 'true'
          AND (COALESCE(gold_scalper_state.state_value->>'sending', 'false') <> 'true'
            OR COALESCE((gold_scalper_state.state_value->>'startedAt')::timestamptz, NOW() - INTERVAL '3 minutes') < NOW() - INTERVAL '2 minutes')
      RETURNING state_key`;
    if (!claim.length) {
      const rows = await sql`SELECT state_value FROM gold_scalper_state WHERE state_key = 'btc_telegram_diagnostic' LIMIT 1`;
      if (rows[0]?.state_value?.sent === true) return res.status(200).json({ ok: true, alreadySent: true, messageSent: false, note: 'The one-time BTCUSD Telegram connectivity test was already delivered. No duplicate message was sent.' });
      return res.status(409).json({ ok: false, error: 'A BTCUSD Telegram diagnostic is already in progress.' });
    }
    const delivery = await sendTelegramMessage('BTCUSD READINESS CHECK — Telegram delivery confirmed.\nThis is a system connectivity test only, NOT a trading signal. No order was generated or placed. BTCUSD remains disabled until all launch checks pass.');
    const recordedAt = new Date().toISOString();
    await sql`INSERT INTO gold_scalper_state (state_key, state_value, updated_at)
      VALUES ('btc_telegram_diagnostic', ${JSON.stringify({ sending: false, sent: delivery.sent === true, sentAt: delivery.sent ? recordedAt : null, lastAttemptAt: recordedAt, messageId: delivery.messageId ?? null, error: delivery.sent ? null : String(delivery.message || 'Telegram delivery failed.').slice(0, 180) })}::jsonb, NOW())
      ON CONFLICT (state_key) DO UPDATE SET state_value = EXCLUDED.state_value, updated_at = NOW()`;
    if (!delivery.sent) return res.status(502).json({ ok: false, messageSent: false, error: String(delivery.message || 'Telegram delivery failed.').slice(0, 180) });
    return res.status(200).json({ ok: true, messageSent: true, messageId: delivery.messageId ?? null, note: 'One-time non-trade Telegram diagnostic delivered. No trading signal was sent.' });
  } catch (error) {
    console.error('BTC Telegram diagnostic failed:', error?.message || 'unknown error');
    return res.status(503).json({ ok: false, messageSent: false, error: 'Telegram diagnostic could not complete.' });
  }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const cronSecret = process.env.CRON_SECRET;
  if (!bearerMatches(req.headers?.authorization, cronSecret)) {
    return res.status(401).json({ ok: false, error: "Valid scheduler authorization required." });
  }
  if (req.body?.diagnostic !== true) {
    return res.status(400).json({ ok: false, error: "Diagnostic flag required." });
  }
  if (req.body?.mode === "telegram") return runTelegramDiagnostic(res);
  if (req.body?.mode !== undefined && req.body.mode !== "market") {
    return res.status(400).json({ ok: false, error: "Unsupported diagnostic mode." });
  }

  const key = process.env.TWELVEDATA_API_KEY;
  if (!key) return res.status(503).json({ ok: false, error: "Market-data provider is not configured." });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const [h1Payload, m15Payload] = await Promise.all([
      providerJson(timeSeriesUrl(key, "1h", 120), controller.signal),
      providerJson(timeSeriesUrl(key, "15min", 250), controller.signal)
    ]);
    if (!Array.isArray(h1Payload.values) || !Array.isArray(m15Payload.values)) {
      throw new Error("Provider returned no BTC/USD candle arrays.");
    }
    const h1 = validateCandles(h1Payload.values, "1h", 60);
    const m15 = validateCandles(m15Payload.values, "15min", 80);

    const priceUrl = new URL("https://api.twelvedata.com/price");
    priceUrl.searchParams.set("symbol", "BTC/USD");
    priceUrl.searchParams.set("apikey", key);
    const pricePayload = await providerJson(priceUrl, controller.signal);
    const currentPrice = Number(pricePayload.price);
    if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
      throw new Error("Provider returned an invalid current BTC/USD quote.");
    }

    const analysis = analyzeGold(h1, m15, {
      balance: 1000,
      currency: "USD",
      riskPercent: 0.5,
      minRR: 2,
      minQuality: 70
    });
    const candidateSuppressed = analysis.status === "SIGNAL_CANDIDATE";
    return res.status(200).json({
      ok: true,
      diagnosticOnly: true,
      symbol: "BTC/USD",
      marketDataVerified: true,
      dataFreshness: "verified",
      h1CandleCount: h1.length,
      m15CandleCount: m15.length,
      latestCompletedCandle: { h1: h1[0].time, m15: m15[0].time },
      currentPrice,
      livePriceVerified: true,
      analysisStatus: candidateSuppressed ? "SIGNAL_CANDIDATE_SUPPRESSED" : "NO_TRADE",
      analysisReason: analysis.reason || null,
      indicators: analysis.indicators || null,
      candidateSuppressed,
      signal: null,
      telegramSent: false,
      databaseWrites: false,
      brokerExecution: false,
      checkedAt: new Date().toISOString()
    });
  } catch (error) {
    const timedOut = error?.name === "AbortError";
    return res.status(timedOut ? 504 : 502).json({
      ok: false,
      diagnosticOnly: true,
      symbol: "BTC/USD",
      marketDataVerified: false,
      dataFreshness: "unverified",
      signal: null,
      telegramSent: false,
      databaseWrites: false,
      brokerExecution: false,
      error: timedOut ? "BTC/USD read-only diagnostic timed out." : "Could not verify fresh BTC/USD H1/M15 data and current quote.",
      detail: String(error?.message || "provider error").slice(0, 180),
      checkedAt: new Date().toISOString()
    });
  } finally {
    clearTimeout(timeout);
  }
}
