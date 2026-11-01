const SUPPORTED_SYMBOLS = new Set(["XAUUSD", "XAGUSD"]);

function parseTimestamp(value) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value !== "string") return NaN;
  const match = /^(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2}):(\\d{2})(?:\\.(\\d{1,3}))?(Z|[+-]\\d{2}:\\d{2})$/i.exec(value);
  if (!match) return NaN;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , zone] = match;
  const year = Number(yearText), month = Number(monthText), day = Number(dayText);
  const hour = Number(hourText), minute = Number(minuteText), second = Number(secondText);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth ||
      hour > 23 || minute > 59 || second > 59) return NaN;
  if (zone.toUpperCase() !== "Z") {
    const [offsetHour, offsetMinute] = zone.slice(1).split(":").map(Number);
    if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) return NaN;
  }
  const timestamp = Date.parse(value);
  return Number.isSafeInteger(timestamp) ? timestamp : NaN;
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
}

/**
 * Validate a provenance-labelled historical tick archive without sorting,
 * filling gaps, coercing numeric strings, or manufacturing quotes.
 */
export function validateHistoricalTickDataset({ metadata, quotes } = {}) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return { ok: false, errors: ["dataset_metadata_required"] };
  }
  const symbol = typeof metadata.symbol === "string" ? metadata.symbol.toUpperCase() : "";
  const provider = typeof metadata.provider === "string" ? metadata.provider.trim() : "";
  const sourceReference = typeof metadata.sourceReference === "string" ? metadata.sourceReference.trim() : "";
  if (!SUPPORTED_SYMBOLS.has(symbol)) return { ok: false, errors: ["unsupported_or_missing_symbol"] };
  if (!provider || provider.length > 120) return { ok: false, errors: ["provider_required"] };
  if (!sourceReference || sourceReference.length > 500) return { ok: false, errors: ["source_reference_required"] };
  if (metadata.dataKind !== "tick") return { ok: false, errors: ["tick_data_required_ohlc_not_accepted"] };
  if (!Array.isArray(quotes) || quotes.length < 2) return { ok: false, errors: ["at_least_two_ticks_required"] };
  if (quotes.length > 5_000_000) return { ok: false, errors: ["dataset_exceeds_five_million_ticks"] };

  const errors = [];
  const normalized = [];
  const intervals = [];
  let previousTimestamp = -Infinity;
  for (let index = 0; index < quotes.length; index += 1) {
    const item = quotes[index];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      errors.push("invalid_tick_at_" + index);
      continue;
    }
    const tickSymbol = typeof item.symbol === "string" ? item.symbol.toUpperCase() : symbol;
    const timestamp = parseTimestamp(item.timestamp);
    const bid = item.bid;
    const ask = item.ask;
    if (tickSymbol !== symbol) errors.push("symbol_mismatch_at_" + index);
    if (!Number.isSafeInteger(timestamp) || timestamp <= previousTimestamp) {
      errors.push(Number.isSafeInteger(timestamp) && timestamp === previousTimestamp
        ? "duplicate_or_non_increasing_timestamp_at_" + index
        : "invalid_or_non_increasing_timestamp_at_" + index);
      continue;
    }
    if (typeof bid !== "number" || typeof ask !== "number" ||
        !Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= bid) {
      errors.push("invalid_bid_ask_at_" + index);
      previousTimestamp = timestamp;
      continue;
    }
    if (normalized.length) intervals.push(timestamp - previousTimestamp);
    normalized.push({
      symbol,
      provider,
      dataKind: "tick",
      timestamp: new Date(timestamp).toISOString(),
      timestampMs: timestamp,
      bid,
      ask,
      spread: ask - bid,
      mid: (bid + ask) / 2
    });
    previousTimestamp = timestamp;
  }
  if (errors.length) return { ok: false, errors: [...new Set(errors)].slice(0, 100) };
  const maxGapMs = intervals.reduce((maximum, value) => Math.max(maximum, value), 0);
  const medianIntervalMs = percentile(intervals, 0.5);
  const p95IntervalMs = percentile(intervals, 0.95);
  const startMs = normalized[0].timestamp;
  const endMs = normalized[normalized.length - 1].timestamp;
  return {
    ok: true,
    manifest: Object.freeze({
      symbol,
      provider,
      sourceReference,
      dataKind: "tick",
      tickCount: normalized.length,
      startAt: new Date(startMs).toISOString(),
      endAt: new Date(endMs).toISOString(),
      durationMs: endMs - startMs,
      medianIntervalMs,
      p95IntervalMs,
      maxGapMs,
      chronological: true,
      quoteIntegrityValidated: true,
      importedAt: new Date().toISOString()
    }),
    quotes: normalized
  };
}
