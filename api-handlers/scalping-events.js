import { hasOwnerSession } from "../lib/auth.js";
import { ensureStorage } from "../lib/storage.js";
import { validateScalpingEventBatch } from "../lib/scalping-events.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!hasOwnerSession(req)) return res.status(401).json({ error: "Owner login required to access the scalping event journal." });
  try {
    const sql = await ensureStorage();
    if (req.method === "POST") {
      const checked = validateScalpingEventBatch(req.body);
      if (!checked.ok) return res.status(400).json({ error: checked.error });
      let inserted = 0;
      let duplicateOutcomes = 0;
      const outcomeIds = checked.value.filter(event => event.type === "POSITION_OUTCOME_RECORDED").map(event => event.payload.positionId);
      const existingOutcomeIds = new Set();
      for (const positionId of outcomeIds) {
        const existing = await sql`SELECT event_id FROM veltrix_scalping_events
          WHERE event_type = 'POSITION_OUTCOME_RECORDED' AND payload->>'positionId' = ${positionId} LIMIT 1`;
        if (existing.length) existingOutcomeIds.add(positionId);
      }
      for (const event of checked.value) {
        if (event.type === "POSITION_OUTCOME_RECORDED" && existingOutcomeIds.has(event.payload.positionId)) {
          duplicateOutcomes += 1;
          continue;
        }
        const rows = await sql`INSERT INTO veltrix_scalping_events (event_id, event_type, symbol, side, occurred_at, payload)
          VALUES (${event.eventId}, ${event.type}, ${event.symbol}, ${event.side}, ${event.occurredAt}, ${JSON.stringify(event.payload)}::jsonb)
          ON CONFLICT DO NOTHING RETURNING event_id`;
        inserted += rows.length;
        if (!rows.length && event.type === "POSITION_OUTCOME_RECORDED") duplicateOutcomes += 1;
      }
      return res.status(200).json({
        saved: true, received: checked.value.length, inserted,
        duplicates: checked.value.length - inserted, duplicateOutcomes
      });
    }
    const limit = Math.min(1000, Math.max(1, Math.trunc(Number(req.query?.limit) || 100)));
    const requestedSymbol = String(req.query?.symbol || "").toUpperCase();
    if (requestedSymbol && !["XAUUSD", "XAGUSD"].includes(requestedSymbol)) {
      return res.status(400).json({ error: "symbol must be XAUUSD or XAGUSD." });
    }
    const symbol = requestedSymbol || null;
    const requestedType = String(req.query?.type || "").toUpperCase();
    if (requestedType && requestedType !== "SIGNAL") {
      return res.status(400).json({ error: "Only type=SIGNAL export filtering is currently supported." });
    }
    const eventType = requestedType || null;
    const parseBound = (value) => {
      if (!value) return null;
      const parsed = new Date(value);
      return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : NaN;
    };
    const from = parseBound(req.query?.from);
    const to = parseBound(req.query?.to);
    if (Number.isNaN(from) || Number.isNaN(to) || (from && to && Date.parse(from) > Date.parse(to))) {
      return res.status(400).json({ error: "Invalid event time range." });
    }
    const rows = await sql`SELECT event_id AS "eventId", event_type AS type, symbol, side, occurred_at AS "occurredAt", payload
      FROM veltrix_scalping_events
      WHERE (${symbol}::text IS NULL OR symbol = ${symbol})
        AND (${eventType}::text IS NULL OR event_type = ${eventType})
        AND (${from}::timestamptz IS NULL OR occurred_at >= ${from})
        AND (${to}::timestamptz IS NULL OR occurred_at <= ${to})
      ORDER BY CASE WHEN ${eventType}::text IS NOT NULL THEN occurred_at END ASC, CASE WHEN ${eventType}::text IS NULL THEN occurred_at END DESC, CASE WHEN ${eventType}::text IS NOT NULL THEN id END ASC, CASE WHEN ${eventType}::text IS NULL THEN id END DESC LIMIT ${limit + 1}`;
    const truncated = rows.length > limit;
    const events = truncated ? rows.slice(0, limit) : rows;
    if (eventType === "SIGNAL") return res.status(200).json({ events, truncated });
    const totals = await sql`SELECT event_type AS type, COUNT(*)::int AS count FROM veltrix_scalping_events GROUP BY event_type ORDER BY event_type`;
    const totalRows = await sql`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE event_type = 'POSITION_CLOSED')::int AS closed_positions, COUNT(*) FILTER (WHERE event_type = 'MISSED_OPPORTUNITY')::int AS missed_opportunities FROM veltrix_scalping_events`;
    const outcomeRows = await sql`WITH outcomes AS (
        SELECT symbol, occurred_at, id, (payload->>'realizedR')::numeric AS realized_r
        FROM veltrix_scalping_events WHERE event_type = 'POSITION_OUTCOME_RECORDED'
      ), curve AS (
        SELECT *, SUM(realized_r) OVER (ORDER BY occurred_at, id) AS cumulative_r FROM outcomes
      ), drawdown AS (
        SELECT *, GREATEST(0, MAX(cumulative_r) OVER (ORDER BY occurred_at, id)) AS peak_r FROM curve
      )
      SELECT COUNT(*)::int AS settled,
        COUNT(*) FILTER (WHERE realized_r > 0)::int AS wins,
        COUNT(*) FILTER (WHERE realized_r < 0)::int AS losses,
        COUNT(*) FILTER (WHERE realized_r = 0)::int AS breakevens,
        COALESCE(SUM(realized_r), 0)::float8 AS net_r,
        AVG(realized_r)::float8 AS average_r,
        COALESCE(MAX(peak_r - cumulative_r), 0)::float8 AS max_drawdown_r
      FROM drawdown`;
    const outcomesBySymbol = await sql`SELECT symbol, COUNT(*)::int AS settled,
        COUNT(*) FILTER (WHERE (payload->>'realizedR')::numeric > 0)::int AS wins,
        COUNT(*) FILTER (WHERE (payload->>'realizedR')::numeric < 0)::int AS losses,
        COUNT(*) FILTER (WHERE (payload->>'realizedR')::numeric = 0)::int AS breakevens,
        COALESCE(SUM((payload->>'realizedR')::numeric), 0)::float8 AS net_r,
        AVG((payload->>'realizedR')::numeric)::float8 AS average_r
      FROM veltrix_scalping_events WHERE event_type = 'POSITION_OUTCOME_RECORDED'
      GROUP BY symbol ORDER BY symbol`;
    return res.status(200).json({
      events,
      truncated,
      summary: {
        totalEvents: Number(totalRows[0]?.total || 0),
        closedPositions: Number(totalRows[0]?.closed_positions || 0),
        missedOpportunities: Number(totalRows[0]?.missed_opportunities || 0),
        settledTrades: Number(outcomeRows[0]?.settled || 0),
        wins: Number(outcomeRows[0]?.wins || 0),
        losses: Number(outcomeRows[0]?.losses || 0),
        breakevens: Number(outcomeRows[0]?.breakevens || 0),
        winRate: Number(outcomeRows[0]?.wins || 0) + Number(outcomeRows[0]?.losses || 0) > 0 ? Number((Number(outcomeRows[0]?.wins || 0) / (Number(outcomeRows[0]?.wins || 0) + Number(outcomeRows[0]?.losses || 0)) * 100).toFixed(1)) : null,
        netR: Number(outcomeRows[0]?.net_r || 0),
        averageR: outcomeRows[0]?.average_r == null ? null : Number(Number(outcomeRows[0].average_r).toFixed(3)),
        maxDrawdownR: Number(Number(outcomeRows[0]?.max_drawdown_r || 0).toFixed(3)),
        bySymbol: outcomesBySymbol.map(row => ({ symbol: row.symbol, settled: Number(row.settled), wins: Number(row.wins), losses: Number(row.losses), breakevens: Number(row.breakevens), netR: Number(row.net_r), averageR: row.average_r == null ? null : Number(Number(row.average_r).toFixed(3)) })),
        counts: Object.fromEntries(totals.map(row => [row.type, Number(row.count)]))
      }
    });
  } catch (error) {
    console.error("Scalping event journal failure:", error?.message || "unknown error");
    return res.status(503).json({ error: "Scalping event journal is unavailable; no event was assumed saved." });
  }
}
