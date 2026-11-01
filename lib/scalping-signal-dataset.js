const SYMBOLS = new Set(["XAUUSD", "XAGUSD"]);
const MAX_SIGNALS = 1000;

export function parseExplicitSignalTime(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return NaN;
  const zone = value.match(/(Z|[+-]\d{2}:\d{2})$/i)?.[1];
  if (zone && zone.toUpperCase() !== "Z") {
    const [hours, minutes] = zone.slice(1).split(":").map(Number);
    if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0)) return NaN;
  }
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return NaN;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : NaN;
}

export function parseHistoricalSignalLog({ name, text, expectedSymbol } = {}) {
  const filename = String(name || "").toLowerCase();
  if (typeof text !== "string") throw new Error("Signal log content is unreadable.");
  const symbol = String(expectedSymbol || "").toUpperCase();
  if (!SYMBOLS.has(symbol)) throw new Error("Expected replay symbol must be XAUUSD or XAGUSD.");
  let metadata, rawSignals;
  if (filename.endsWith(".json")) {
    const parsed = JSON.parse(text);
    metadata = parsed?.metadata;
    rawSignals = parsed?.signals;
  } else if (filename.endsWith(".csv")) {
    const lines = text.replace(/^\uFEFF/, "").trim().split(/\r?\n/);
    if (lines.length < 2 || !lines[0]) throw new Error("Signal CSV requires a header and at least one signal row.");
    const headers = lines.shift().split(",").map((value) => value.trim().toLowerCase());
    if (new Set(headers).size !== headers.length) throw new Error("Signal CSV contains duplicate column names.");
    const indexes = Object.fromEntries(headers.map((value, index) => [value, index]));
    if (["timestamp", "symbol", "side", "provider"].some((key) => indexes[key] === undefined)) {
      throw new Error("Signal CSV requires timestamp,symbol,side,provider columns; id is optional.");
    }
    rawSignals = lines.filter(Boolean).map((line, index) => {
      if (line.includes('"')) throw new Error("Quoted CSV fields are not supported in signal logs; use plain comma-separated fields.");
      const cells = line.split(",");
      if (cells.length !== headers.length) throw new Error("Signal CSV column mismatch at data row " + (index + 1) + ".");
      return {
        id: indexes.id === undefined ? null : cells[indexes.id].trim(),
        timestamp: cells[indexes.timestamp].trim(),
        symbol: cells[indexes.symbol].trim(),
        side: cells[indexes.side].trim(),
        provider: cells[indexes.provider].trim()
      };
    });
    const providers = [...new Set(rawSignals.map((signal) => signal.provider).filter(Boolean))];
    if (providers.length !== 1 || rawSignals.some((signal) => !signal.provider)) {
      throw new Error("All signal CSV rows must identify one consistent provider.");
    }
    metadata = { sourceReference: filename, strategy: "imported_signal_log", provider: providers[0] };
  } else {
    throw new Error("Import a .json or .csv signal log.");
  }

  if (!metadata || typeof metadata.sourceReference !== "string" || !metadata.sourceReference.trim()) {
    throw new Error("Signal-log provenance is required in metadata.sourceReference.");
  }
  if (typeof metadata.provider !== "string" || !metadata.provider.trim()) {
    throw new Error("Signal-log provider is required so cross-provider replay can be blocked.");
  }
  if (!Array.isArray(rawSignals) || !rawSignals.length || rawSignals.length > MAX_SIGNALS) {
    throw new Error("Signal log must contain 1–1,000 signals.");
  }

  const ids = new Set();
  const signals = rawSignals.map((item, index) => {
    const timestampMs = parseExplicitSignalTime(item?.timestamp);
    const side = String(item?.side || "").toUpperCase();
    const itemSymbol = String(item?.symbol || "").toUpperCase();
    const provider = typeof item?.provider === "string" && item.provider.trim()
      ? item.provider.trim() : metadata.provider.trim();
    if (!Number.isFinite(timestampMs)) throw new Error("Signal " + (index + 1) + " has an invalid or timezone-ambiguous timestamp.");
    if (itemSymbol !== symbol) throw new Error("Signal " + (index + 1) + " has the wrong symbol.");
    if (side !== "BUY" && side !== "SELL") throw new Error("Signal " + (index + 1) + " must be BUY or SELL.");
    if (provider.toLowerCase() !== metadata.provider.trim().toLowerCase()) throw new Error("Signal " + (index + 1) + " provider does not match signal-log metadata.");
    const id = typeof item?.id === "string" && item.id.trim() ? item.id.trim() : "signal-" + (index + 1);
    if (ids.has(id)) throw new Error("Signal log contains duplicate signal IDs.");
    ids.add(id);
    return { id, symbol, side, provider: metadata.provider.trim(), timestamp: new Date(timestampMs).toISOString(), timestampMs };
  });
  signals.sort((a, b) => a.timestampMs - b.timestampMs);
  return {
    metadata: {
      sourceReference: metadata.sourceReference.trim(),
      strategy: typeof metadata.strategy === "string" && metadata.strategy.trim() ? metadata.strategy.trim() : "unspecified",
      provider: metadata.provider.trim()
    },
    signals
  };
}
