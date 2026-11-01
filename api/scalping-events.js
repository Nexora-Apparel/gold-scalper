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
      for (const event of checked.value) {
        const rows = await sql`INSERT INTO veltrix_scalping_events (event_id, event_type, symbol, side, occurred_at, payload)
          VALUES (${event.eventId}, ${event.type}, ${event.symbol}, ${event.side}, ${event.occurredAt}, ${JSON.stringify(event.payload)}::jsonb)
          ON CONFLICT (event_id) DO NOTHING RETURNING event_id`;
        inserted += rows.length;
      }
      return res.status(200).json({ saved: true, received: checked.value.length, inserted, duplicates: checked.value.length - inserted });
    }
    const limit = Math.min(200, Math.max(1, Number(req.query?.limit) || 100));
    const symbol = ["XAUUSD", "XAGUSD"].includes(String(req.query?.symbol || "").toUpperCase()) ? String(req.query.symbol).toUpperCase() : null;
    const rows = symbol
      ? await sql`SELECT event_id AS "eventId", event_type AS type, symbol, side, occurred_at AS "occurredAt", payload FROM veltrix_scalping_events WHERE symbol = ${symbol} ORDER BY occurred_at DESC, id DESC LIMIT ${limit}`
      : await sql`SELECT event_id AS "eventId", event_type AS type, symbol, side, occurred_at AS "occurredAt", payload FROM veltrix_scalping_events ORDER BY occurred_at DESC, id DESC LIMIT ${limit}`;
    const totals = await sql`SELECT event_type AS type, COUNT(*)::int AS count
      FROM veltrix_scalping_events GROUP BY event_type ORDER BY event_type`;
    const totalRows = await sql`SELECT COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE event_type = 'POSITION_CLOSED')::int AS closed_positions,
      COUNT(*) FILTER (WHERE event_type = 'MISSED_OPPORTUNITY')::int AS missed_opportunities
      FROM veltrix_scalping_events`;
    const performanceRows = await sql`SELECT
      COUNT(*) FILTER (WHERE event_type = 'POSITION_CLOSED' AND payload->>'realizedR' ~ '^-?[0-9]+(\\.[0-9]+)?
      events: rows,
      summary: {
        totalEvents: Number(totalRows[0]?.total || 0),
        closedPositions: Number(totalRows[0]?.closed_positions || 0),
        missedOpportunities: Number(totalRows[0]?.missed_opportunities || 0),
        settledTrades: Number(performanceRows[0]?.settled_trades || 0),
        winRate: Number(performanceRows[0]?.settled_trades || 0) > 0
          ? Number((Number(performanceRows[0]?.winning_trades || 0) / Number(performanceRows[0].settled_trades) * 100).toFixed(1)) : null,
        netR: performanceRows[0]?.net_r == null ? null : Number(Number(performanceRows[0].net_r).toFixed(3)),
        averageR: performanceRows[0]?.average_r == null ? null : Number(Number(performanceRows[0].average_r).toFixed(3)),
        counts: Object.fromEntries(totals.map(row => [row.type, Number(row.count)]))
      }
    });
  } catch (error) {
    console.error("Scalping event journal failure:", error?.message || "unknown error");
    return res.status(503).json({ error: "Scalping event journal is unavailable; no event was assumed saved." });
  }
}
)::int AS settled_trades,
      COUNT(*) FILTER (WHERE event_type = 'POSITION_CLOSED' AND payload->>'realizedR' ~ '^-?[0-9]+(\\.[0-9]+)?
      events: rows,
      summary: {
        totalEvents: Number(totalRows[0]?.total || 0),
        closedPositions: Number(totalRows[0]?.closed_positions || 0),
        missedOpportunities: Number(totalRows[0]?.missed_opportunities || 0),
        counts: Object.fromEntries(totals.map(row => [row.type, Number(row.count)]))
      }
    });
  } catch (error) {
    console.error("Scalping event journal failure:", error?.message || "unknown error");
    return res.status(503).json({ error: "Scalping event journal is unavailable; no event was assumed saved." });
  }
}
 AND (payload->>'realizedR')::numeric > 0)::int AS winning_trades,
      SUM((payload->>'realizedR')::numeric) FILTER (WHERE event_type = 'POSITION_CLOSED' AND payload->>'realizedR' ~ '^-?[0-9]+(\\.[0-9]+)?
      events: rows,
      summary: {
        totalEvents: Number(totalRows[0]?.total || 0),
        closedPositions: Number(totalRows[0]?.closed_positions || 0),
        missedOpportunities: Number(totalRows[0]?.missed_opportunities || 0),
        counts: Object.fromEntries(totals.map(row => [row.type, Number(row.count)]))
      }
    });
  } catch (error) {
    console.error("Scalping event journal failure:", error?.message || "unknown error");
    return res.status(503).json({ error: "Scalping event journal is unavailable; no event was assumed saved." });
  }
}
) AS net_r,
      AVG((payload->>'realizedR')::numeric) FILTER (WHERE event_type = 'POSITION_CLOSED' AND payload->>'realizedR' ~ '^-?[0-9]+(\\.[0-9]+)?
      events: rows,
      summary: {
        totalEvents: Number(totalRows[0]?.total || 0),
        closedPositions: Number(totalRows[0]?.closed_positions || 0),
        missedOpportunities: Number(totalRows[0]?.missed_opportunities || 0),
        counts: Object.fromEntries(totals.map(row => [row.type, Number(row.count)]))
      }
    });
  } catch (error) {
    console.error("Scalping event journal failure:", error?.message || "unknown error");
    return res.status(503).json({ error: "Scalping event journal is unavailable; no event was assumed saved." });
  }
}
) AS average_r
      FROM veltrix_scalping_events`;
    return res.status(200).json({
      events: rows,
      summary: {
        totalEvents: Number(totalRows[0]?.total || 0),
        closedPositions: Number(totalRows[0]?.closed_positions || 0),
        missedOpportunities: Number(totalRows[0]?.missed_opportunities || 0),
        counts: Object.fromEntries(totals.map(row => [row.type, Number(row.count)]))
      }
    });
  } catch (error) {
    console.error("Scalping event journal failure:", error?.message || "unknown error");
    return res.status(503).json({ error: "Scalping event journal is unavailable; no event was assumed saved." });
  }
}
