import { validateBrokerQuoteObservation } from "./broker-quote-adapter.js";

const TYPES = new Set(["QUOTE_STATE", "MARKET_STATE", "MT5_SPREAD_OBSERVED", "BROKER_QUOTE_OBSERVED", "SIGNAL", "NO_TRADE", "SIGNAL_REJECTED", "MISSED_OPPORTUNITY", "POSITION_OPENED", "EXIT_RECOMMENDED", "EXIT_NOT_CONFIRMED", "EXIT_RECOMMENDATION_CLEARED", "POSITION_CLOSED", "POSITION_OUTCOME_RECORDED", "FEED_ERROR", "ENGINE_STATE", "EMERGENCY_STOP"]);
const SYMBOLS = new Set(["XAUUSD", "XAGUSD"]);

export function validateScalpingEvent(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "Event must be an object." };
  const eventId = typeof input.eventId === "string" ? input.eventId.trim() : "";
  const type = typeof input.type === "string" ? input.type.toUpperCase() : "";
  const symbol = typeof input.symbol === "string" ? input.symbol.toUpperCase() : "";
  if (!eventId || eventId.length > 160) return { ok: false, error: "A unique eventId is required (max 160 characters)." };
  if (!TYPES.has(type)) return { ok: false, error: "Unsupported event type." };
  if (!SYMBOLS.has(symbol)) return { ok: false, error: "Unsupported market symbol." };
  if (input.side !== undefined && input.side !== null && !["BUY", "SELL"].includes(input.side)) return { ok: false, error: "side must be BUY, SELL, or null." };
  const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();
  if (!Number.isFinite(occurredAt.getTime()) || occurredAt.getTime() > Date.now() + 60000) return { ok: false, error: "Invalid event timestamp." };
  const payload = input.payload === undefined ? {} : input.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { ok: false, error: "payload must be an object." };
  if (type === "BROKER_QUOTE_OBSERVED") {
    const observedAtMs = Date.parse(payload.observedAt);
    const checkedQuote = validateBrokerQuoteObservation({
      source: payload.source, symbol, bid: payload.bid, ask: payload.ask, timestamp: payload.observedAt
    }, { now: observedAtMs, expectedSymbol: symbol });
    if (!checkedQuote.verified) return { ok: false, error: "Invalid broker quote observation: " + checkedQuote.reasons.join(", ") };
    if (payload.observationMethod !== "user_authorized_local_mt5_screen_ocr" || payload.rawScreenUploaded !== false) {
      return { ok: false, error: "Broker quote observations must identify local authorised OCR and confirm no raw screen upload." };
    }
  }
  if (type === "POSITION_OUTCOME_RECORDED" && (typeof payload.positionId !== "string" || !payload.positionId.trim() || payload.positionId.length > 160)) return { ok: false, error: "POSITION_OUTCOME_RECORDED requires the MT5 positionId." };
  if (type === "POSITION_OUTCOME_RECORDED" && (typeof payload.realizedR !== "number" || !Number.isFinite(payload.realizedR))) return { ok: false, error: "POSITION_OUTCOME_RECORDED requires a numeric realizedR value." };
  if (JSON.stringify(payload).length > 12000) return { ok: false, error: "Event payload exceeds 12 KB." };
  return { ok: true, value: { eventId, type, symbol, side: input.side || null, occurredAt: occurredAt.toISOString(), payload } };
}

export function validateScalpingEventBatch(body) {
  const items = Array.isArray(body) ? body : [body];
  if (!items.length || items.length > 100) return { ok: false, error: "Submit between 1 and 100 events per batch." };
  const checked = items.map(validateScalpingEvent);
  const invalid = checked.find((item) => !item.ok);
  if (invalid) return invalid;
  const values = checked.map((item) => item.value);
  const ids = values.map((item) => item.eventId);
  if (new Set(ids).size !== ids.length) return { ok: false, error: "Duplicate eventId values in one batch." };
  const outcomeIds = values.filter((item) => item.type === "POSITION_OUTCOME_RECORDED").map((item) => item.payload.positionId);
  if (new Set(outcomeIds).size !== outcomeIds.length) return { ok: false, error: "Only one outcome event is allowed per MT5 position." };
  return { ok: true, value: values };
}

export function summarizeScalpingEvents(rows = []) {
  const counts = {};
  for (const row of rows) counts[row.type] = (counts[row.type] || 0) + 1;
  const closed = rows.filter((row) => row.type === "POSITION_CLOSED");
  const outcomes = rows.filter((row) => row.type === "POSITION_OUTCOME_RECORDED")
    .map((row) => Number(row.payload?.realizedR)).filter(Number.isFinite);
  return { totalEvents: rows.length, counts, closedPositions: closed.length, realizedRRecorded: outcomes.length, netR: Number(outcomes.reduce((a, b) => a + b, 0).toFixed(3)) };
}
