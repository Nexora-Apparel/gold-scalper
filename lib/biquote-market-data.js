const BASE_URL = "https://biquote.io";
export const VELTRIX_SYMBOLS = Object.freeze(["XAUUSD", "XAGUSD"]);

export function normalizeBiquoteTick(payload, {
  symbol,
  now = Date.now(),
  maxAgeMs = 5000,
  maxFutureSkewMs = 1000
} = {}) {
  const expected = String(symbol || "").toUpperCase();
  if (!VELTRIX_SYMBOLS.includes(expected)) throw new Error("Unsupported VELTRIX symbol.");
  if (!payload || typeof payload !== "object") throw new Error("Invalid biquote payload.");
  if (String(payload.symbol || "").toUpperCase() !== expected) throw new Error("Symbol mismatch.");

  const bid = Number(payload.bid);
  const ask = Number(payload.ask);
  const timestamp = Date.parse(payload.timestamp);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask < bid) {
    throw new Error("Invalid bid/ask quote.");
  }
  if (!Number.isFinite(timestamp)) throw new Error("Missing or invalid quote timestamp.");

  const ageMs = now - timestamp;
  if (ageMs > maxAgeMs || ageMs < -maxFutureSkewMs) {
    throw new Error("Quote is stale or has an invalid future timestamp.");
  }
  if (payload.stale === true) throw new Error("Provider marked quote as stale.");
  if (payload.marketState && payload.marketState !== "open") {
    throw new Error("Market is not open.");
  }

  const providerAge = Number(payload.quoteAgeSeconds);
  if (Number.isFinite(providerAge) && providerAge * 1000 > maxAgeMs) {
    throw new Error("Provider quote age exceeds the freshness limit.");
  }

  return Object.freeze({
    symbol: expected,
    bid,
    ask,
    mid: (bid + ask) / 2,
    spread: ask - bid,
    timestamp: new Date(timestamp).toISOString(),
    receivedAt: new Date(now).toISOString(),
    ageMs: Math.max(0, ageMs),
    source: typeof payload.source === "string" ? payload.source : "biquote",
    provider: "biquote",
    executableForExness: false
  });
}

export async function fetchBiquoteQuotes({
  symbols = VELTRIX_SYMBOLS,
  fetchImpl = globalThis.fetch,
  now = Date.now(),
  maxAgeMs = 5000,
  timeoutMs = 4000
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("Fetch implementation unavailable.");
  const requested = [...new Set(symbols.map((item) => String(item).toUpperCase()))];
  if (!requested.length || requested.some((item) => !VELTRIX_SYMBOLS.includes(item))) {
    throw new Error("Only XAUUSD and XAGUSD are enabled for VELTRIX LIVE.");
  }

  const url = new URL("/api/latest", BASE_URL);
  for (const symbol of requested) url.searchParams.append("symbols", symbol);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url.toString(), {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: controller.signal
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload || typeof payload !== "object") {
      throw new Error(`biquote request failed (HTTP ${response.status}).`);
    }

    const quotes = {};
    for (const symbol of requested) {
      quotes[symbol] = normalizeBiquoteTick(payload[symbol], {
        symbol,
        now,
        maxAgeMs
      });
    }
    return Object.freeze({
      provider: "biquote",
      receivedAt: new Date(now).toISOString(),
      quotes: Object.freeze(quotes)
    });
  } finally {
    clearTimeout(timer);
  }
}
