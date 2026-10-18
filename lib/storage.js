import { neon } from "@neondatabase/serverless";

const defaults = {
  balance: 1000, currency: "USD", riskPercent: 0.5, minRR: 2,
  minQuality: 70, maxSignals: 3, timeframe: "M15", mode: "manual",
  goldEnabled: true, majorsEnabled: false, newsEnabled: true,
  scanMode: "24h", sessionStart: "08:00", sessionEnd: "20:00", timezone: "Africa/Lagos"
};

function getSql() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not configured");
  return neon(process.env.DATABASE_URL);
}

export async function ensureStorage() {
  const sql = getSql();
  await sql`CREATE TABLE IF NOT EXISTS gold_scalper_state (
    state_key TEXT PRIMARY KEY,
    state_value JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS gold_scalper_history (
    id BIGSERIAL PRIMARY KEY,
    status TEXT NOT NULL,
    symbol TEXT NOT NULL DEFAULT 'XAUUSD',
    result JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  await sql`INSERT INTO gold_scalper_state (state_key, state_value)
    VALUES ('settings', ${JSON.stringify(defaults)}::jsonb)
    ON CONFLICT (state_key) DO NOTHING`;
  await sql`INSERT INTO gold_scalper_state (state_key, state_value)
    VALUES ('control', '{"engine":"PAUSED","emergencyStop":false,"mode":"manual"}'::jsonb)
    ON CONFLICT (state_key) DO NOTHING`;
  return sql;
}

export async function getStoredSettings(sql) {
  const rows = await sql`SELECT state_value FROM gold_scalper_state WHERE state_key = 'settings' LIMIT 1`;
  const stored = rows[0]?.state_value || defaults;
  const requestedLimit = Number(stored.maxSignals);
  return {
    ...defaults,
    ...stored,
    // Hard cap the daily signal limit at three, including older saved settings.
    maxSignals: [1, 2, 3].includes(requestedLimit) ? requestedLimit : 3
  };
}

export async function saveStoredSettings(sql, settings) {
  await sql`INSERT INTO gold_scalper_state (state_key, state_value, updated_at)
    VALUES ('settings', ${JSON.stringify(settings)}::jsonb, NOW())
    ON CONFLICT (state_key) DO UPDATE SET state_value = EXCLUDED.state_value, updated_at = NOW()`;
}

export async function getControlState(sql) {
  const rows = await sql`SELECT state_value FROM gold_scalper_state WHERE state_key = 'control' LIMIT 1`;
  return rows[0]?.state_value || { engine: "PAUSED", emergencyStop: false, mode: "manual" };
}

export async function saveControlState(sql, state) {
  await sql`INSERT INTO gold_scalper_state (state_key, state_value, updated_at)
    VALUES ('control', ${JSON.stringify(state)}::jsonb, NOW())
    ON CONFLICT (state_key) DO UPDATE SET state_value = EXCLUDED.state_value, updated_at = NOW()`;
}

export async function recordHistory(sql, result) {
  const status = typeof result?.status === "string" ? result.status : "UNKNOWN";
  await sql`INSERT INTO gold_scalper_history (status, symbol, result)
    VALUES (${status}, 'XAUUSD', ${JSON.stringify(result)}::jsonb)`;
}

export async function getHistory(sql, limit = 50) {
  return await sql`SELECT id, status, result, created_at AS "createdAt"
    FROM gold_scalper_history ORDER BY created_at DESC, id DESC LIMIT ${limit}`;
}

export async function countSignalsToday(sql) {
  const rows = await sql`SELECT COUNT(*)::int AS count
    FROM gold_scalper_history
    WHERE status = 'SIGNAL_CANDIDATE'
      AND (
        result->'entryMonitoring'->>'created' = 'true'
        OR result->'telegramDelivery'->>'sent' = 'true'
      )
      AND created_at >= (date_trunc('day', NOW() AT TIME ZONE 'Africa/Lagos') AT TIME ZONE 'Africa/Lagos')`;
  return Number(rows[0]?.count || 0);
}

export { defaults as defaultSettings };


export async function getActiveSignal(sql) {
  const rows = await sql`SELECT state_value FROM gold_scalper_state WHERE state_key = 'active_signal' LIMIT 1`;
  if (rows[0]?.state_value) return rows[0].state_value;

  // Adopt the newest previously delivered candidate so the new lifecycle can
  // send a confirmation update for a signal that was already sent by older code.
  const legacy = await sql`SELECT result, created_at AS "createdAt"
    FROM gold_scalper_history
    WHERE status = 'SIGNAL_CANDIDATE'
      AND result->'telegramDelivery'->>'sent' = 'true'
      AND result->'signal' IS NOT NULL
    ORDER BY created_at DESC, id DESC
    LIMIT 1`;
  if (!legacy[0]?.result) return null;
  const adopted = {
    state: "WAITING_FOR_ENTRY",
    createdAt: legacy[0].createdAt,
    expiresAt: new Date(new Date(legacy[0].createdAt).getTime() + 8 * 60 * 60 * 1000).toISOString(),
    result: legacy[0].result,
    legacyPreviouslySent: true
  };
  await saveActiveSignal(sql, adopted);
  return adopted;
}

export async function saveActiveSignal(sql, signal) {
  await sql`INSERT INTO gold_scalper_state (state_key, state_value, updated_at)
    VALUES ('active_signal', ${JSON.stringify(signal)}::jsonb, NOW())
    ON CONFLICT (state_key) DO UPDATE SET state_value = EXCLUDED.state_value, updated_at = NOW()`;
}

export async function clearActiveSignal(sql) {
  await sql`DELETE FROM gold_scalper_state WHERE state_key = 'active_signal'`;
}
