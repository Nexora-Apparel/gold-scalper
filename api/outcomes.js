import { hasOwnerSession } from "../lib/auth.js";
import { ensureStorage } from "../lib/storage.js";
import { validateOutcomeInput } from "../lib/outcomes.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!hasOwnerSession(req)) {
    return res.status(401).json({ error: "Owner login required to view or save manual trade outcomes." });
  }

  try {
    const sql = await ensureStorage();
    if (req.method === "GET") {
      const rows = await sql`
        SELECT h.id, h.created_at AS "createdAt", h.result->'signal' AS signal,
          o.outcome, o.realized_r AS "realizedR", o.notes, o.recorded_at AS "recordedAt"
        FROM gold_scalper_history h
        LEFT JOIN gold_scalper_outcomes o
          ON o.signal_ref = h.result->'signal'->>'signalRef'
        WHERE h.status = 'SIGNAL_CANDIDATE'
          AND h.result->'signal'->>'signalRef' IS NOT NULL
        ORDER BY h.created_at DESC, h.id DESC
        LIMIT 50
      `;
      const statsRows = await sql`
        SELECT
          COUNT(*) FILTER (WHERE outcome IN ('WIN', 'LOSS'))::int AS decided,
          COUNT(*) FILTER (WHERE outcome = 'WIN')::int AS wins,
          COUNT(*) FILTER (WHERE outcome = 'LOSS')::int AS losses,
          COALESCE(SUM(realized_r), 0)::float AS "netR"
        FROM gold_scalper_outcomes
      `;
      const stats = statsRows[0] || { decided: 0, wins: 0, losses: 0, netR: 0 };
      const decided = Number(stats.decided || 0);
      return res.status(200).json({
        signals: rows,
        statistics: {
          decided,
          wins: Number(stats.wins || 0),
          losses: Number(stats.losses || 0),
          winRate: decided ? Number((Number(stats.wins || 0) / decided * 100).toFixed(1)) : null,
          netR: Number(Number(stats.netR || 0).toFixed(3))
        }
      });
    }

    const checked = validateOutcomeInput(req.body || {});
    if (!checked.ok) return res.status(400).json({ error: checked.error });
    const { signalRef, outcome, realizedR, notes } = checked.value;
    const candidates = await sql`
      SELECT id FROM gold_scalper_history
      WHERE status = 'SIGNAL_CANDIDATE'
        AND result->'signal'->>'signalRef' = ${signalRef}
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `;
    if (!candidates[0]) {
      return res.status(404).json({ error: "Signal reference was not found in recorded candidate history. Refresh signal history and choose a recorded signal." });
    }
    await sql`
      INSERT INTO gold_scalper_outcomes (signal_ref, history_id, outcome, realized_r, notes, recorded_at)
      VALUES (${signalRef}, ${candidates[0].id}, ${outcome}, ${realizedR}, ${notes}, NOW())
      ON CONFLICT (signal_ref) DO UPDATE SET
        history_id = EXCLUDED.history_id,
        outcome = EXCLUDED.outcome,
        realized_r = EXCLUDED.realized_r,
        notes = EXCLUDED.notes,
        recorded_at = NOW()
    `;
    return res.status(200).json({ saved: true, message: "Manual outcome saved for forward testing. No broker action was performed." });
  } catch (error) {
    console.error("Outcome tracking failure:", error?.message || "unknown error");
    return res.status(503).json({ error: "Outcome tracking storage is unavailable. The outcome was not saved." });
  }
}
