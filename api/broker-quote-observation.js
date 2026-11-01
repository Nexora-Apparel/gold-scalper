import { hasOwnerSession } from "../lib/auth.js";
import { ensureStorage } from "../lib/storage.js";
import { validateBrokerQuoteTransport } from "../lib/broker-quote-transport.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Vary", "Cookie");
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ ok: false, error: "Method not allowed." });
  }
  if (!hasOwnerSession(req)) return res.status(401).json({ ok: false, error: "Owner login required." });

  try {
    const sql = await ensureStorage();
    if (req.method === "POST") {
      const checked = validateBrokerQuoteTransport(req.body, {
        now: Date.now(),
        expectedSymbol: String(req.body?.symbol || "").toUpperCase()
      });
      if (!checked.ok) return res.status(400).json(checked);
      const { sequence, observedAt, receivedAt, quote } = checked.value;
      const stateKey = "broker_quote_latest:" + quote.symbol;
      const rows = await sql`INSERT INTO gold_scalper_state (state_key, state_value, updated_at)
        VALUES (${stateKey}, ${JSON.stringify(checked.value)}::jsonb, NOW())
        ON CONFLICT (state_key) DO UPDATE
          SET state_value = EXCLUDED.state_value, updated_at = NOW()
          WHERE COALESCE((gold_scalper_state.state_value->>'sequence')::bigint, 0) < ${sequence}
            AND (gold_scalper_state.state_value->>'observedAt')::timestamptz < ${observedAt}::timestamptz
        RETURNING state_value->>'sequence' AS sequence`;
      if (!rows.length) return res.status(409).json({ ok: false, error: "Duplicate or out-of-order broker quote observation." });
      return res.status(200).json({
        ok: true,
        accepted: true,
        symbol: quote.symbol,
        sequence,
        observedAt,
        receivedAt,
        quoteAgeMs: Math.max(0, Date.now() - Date.parse(observedAt)),
        executableForBroker: false
      });
    }

    const symbol = String(req.query?.symbol || "").toUpperCase();
    if (symbol !== "XAUUSD" && symbol !== "XAGUSD") {
      return res.status(400).json({ ok: false, error: "symbol must be XAUUSD or XAGUSD." });
    }
    const rows = await sql`SELECT state_value AS observation
      FROM gold_scalper_state WHERE state_key = ${"broker_quote_latest:" + symbol} LIMIT 1`;
    const observation = rows[0]?.observation || null;
    const ageMs = observation?.observedAt ? Date.now() - Date.parse(observation.observedAt) : Infinity;
    const fresh = Number.isFinite(ageMs) && ageMs >= -1000 && ageMs <= 2500;
    return res.status(fresh ? 200 : 503).json({
      ok: fresh,
      status: fresh ? "BROKER_QUOTE_VERIFIED" : "BROKER_QUOTE_STALE_OR_UNAVAILABLE",
      observation: fresh ? observation : null,
      quoteAgeMs: Number.isFinite(ageMs) ? Math.max(0, ageMs) : null,
      maxAgeMs: 2500,
      executableForBroker: false
    });
  } catch (error) {
    console.error("Broker quote transport failure:", error?.message || "unknown error");
    return res.status(503).json({ ok: false, error: "Broker quote transport unavailable; no quote was assumed accepted." });
  }
}
