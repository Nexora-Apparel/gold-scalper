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
  const schemaVersion = input.schemaVersion === undefined ? 1 : Number(input.schemaVersion);
  const source = typeof input.source === "string" ? input.source.trim().toLowerCase() : "legacy";
  if (schemaVersion !== 1) return { ok: false, error: "Unsupported event schemaVersion." };
  if (!["android", "web", "server", "replay", "legacy"].includes(source)) return { ok: false, error: "Unsupported event source." };
  const readId = (value, label) => {
    if (value === undefined || value === null || value === "") return { ok: true, value: null };
    if (typeof value !== "string" || !value.trim() || value.trim().length > 160) return { ok: false, error: label + " must be a non-empty string up to 160 characters." };
    return { ok: true, value: value.trim() };
  };
  const correlation = readId(input.correlationId, "correlationId");
  const signal = readId(input.signalId ?? payload?.sourceSignalRef, "signalId");
  const position = readId(input.positionId ?? payload?.positionId, "positionId");
  for (const checked of [correlation, signal, position]) if (!checked.ok) return checked;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { ok: false, error: "payload must be an object." };
  if (input.signalId && payload.sourceSignalRef && input.signalId !== payload.sourceSignalRef) {
    return { ok: false, error: "signalId must match payload.sourceSignalRef when both are supplied." };
  }
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
  const envelope = {
    schemaVersion, source,
    correlationId: correlation.value || signal.value || position.value || eventId,
    signalId: signal.value || (type === "SIGNAL" ? eventId : null),
    positionId: position.value
  };
  return { ok: true, value: { eventId, type, symbol, side: input.side || null, occurredAt: occurredAt.toISOString(), envelope, payload } };
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


const POSITION_EVENTS = new Set([
  "POSITION_OPENED", "EXIT_RECOMMENDED", "EXIT_NOT_CONFIRMED",
  "EXIT_RECOMMENDATION_CLEARED", "POSITION_CLOSED", "POSITION_OUTCOME_RECORDED"
]);

// Reconstruct each MT5 ticket's lifecycle from persisted history plus the
// incoming batch. Missing position IDs remain legacy-compatible and are not
// silently assigned guessed identifiers.
export function validateScalpingEventTransitions(incoming = [], prior = []) {
  const all = [
    ...prior.map((event, index) => ({ ...event, _sequence: index, _prior: true })),
    ...incoming.map((event, index) => ({ ...event, _sequence: index, _prior: false }))
  ];
  const byPosition = new Map();
  for (const event of all) {
    if (!POSITION_EVENTS.has(event.type)) continue;
    const positionId = event.payload?.positionId || event.envelope?.positionId;
    if (typeof positionId !== "string" || !positionId.trim()) continue;
    if (!byPosition.has(positionId)) byPosition.set(positionId, []);
    byPosition.get(positionId).push(event);
  }

  const rank = {
    POSITION_OPENED: 0,
    EXIT_RECOMMENDED: 1,
    EXIT_NOT_CONFIRMED: 1,
    EXIT_RECOMMENDATION_CLEARED: 1,
    POSITION_CLOSED: 2,
    POSITION_OUTCOME_RECORDED: 3
  };
  for (const [positionId, events] of byPosition) {
    events.sort((a, b) => {
      const time = Date.parse(a.occurredAt || "") - Date.parse(b.occurredAt || "");
      return time || (rank[a.type] ?? 9) - (rank[b.type] ?? 9) || a._sequence - b._sequence;
    });
    let opened = false;
    let closed = false;
    let outcome = false;
    for (const event of events) {
      const fail = (message) => ({ ok: false, error: message, positionId, eventId: event.eventId });
      if (event.type === "POSITION_OPENED") {
        if (opened) return fail("MT5 position already has a POSITION_OPENED event.");
        if (closed) return fail("A closed MT5 position cannot be reopened under the same positionId.");
        opened = true;
      } else if (event.type === "POSITION_CLOSED") {
        if (!opened) return fail("POSITION_CLOSED requires a prior POSITION_OPENED event for the same positionId.");
        if (closed) return fail("MT5 position already has a POSITION_CLOSED event.");
        closed = true;
      } else if (event.type === "POSITION_OUTCOME_RECORDED") {
        if (!closed) return fail("POSITION_OUTCOME_RECORDED requires POSITION_CLOSED for the same positionId.");
        if (outcome) return fail("Only one settled outcome is allowed per MT5 position.");
        outcome = true;
      } else if (event.type.startsWith("EXIT_")) {
        if (!opened || closed) return fail("Exit lifecycle events require an open MT5 position.");
      }
    }
  }
  return { ok: true };
}


export function filterIdempotentLifecycleEvents(incoming = [], prior = []) {
  const priorIds = new Set(prior.map(event => event.eventId).filter(Boolean));
  const settledPositionIds = new Set(prior
    .filter(event => event.type === "POSITION_OUTCOME_RECORDED")
    .map(event => event.payload?.positionId)
    .filter(Boolean));
  return incoming.filter(event =>
    !priorIds.has(event.eventId) &&
    !(event.type === "POSITION_OUTCOME_RECORDED" && settledPositionIds.has(event.payload?.positionId))
  );
}
