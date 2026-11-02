import { fetchBiquoteQuotes, VELTRIX_SYMBOLS } from "../lib/biquote-market-data.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Vary", "Authorization, Cookie");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "Method not allowed." });
  }

  const requested = typeof req.query?.symbols === "string"
    ? req.query.symbols.split(",").map((value) => value.trim().toUpperCase()).filter(Boolean)
    : [...VELTRIX_SYMBOLS];
  if (!requested.length || requested.some((symbol) => !VELTRIX_SYMBOLS.includes(symbol))) {
    return res.status(400).json({
      ok: false,
      error: "Supported symbols are XAUUSD and XAGUSD.",
      supportedSymbols: VELTRIX_SYMBOLS
    });
  }

  try {
    const snapshot = await fetchBiquoteQuotes({ symbols: requested, maxAgeMs: 5000, timeoutMs: 3500 });
    return res.status(200).json({
      ok: true,
      provider: "biquote",
      mode: "REST_SNAPSHOT",
      streamingRequiredForScalping: true,
      executionCompatible: false,
      receivedAt: snapshot.receivedAt,
      quotes: snapshot.quotes
    });
  } catch (error) {
    return res.status(503).json({
      ok: false,
      provider: "biquote",
      mode: "REST_SNAPSHOT",
      error: "Fresh market quotes are unavailable. Do not generate a trade signal.",
      detail: String(error?.message || "Unknown provider error").slice(0, 180)
    });
  }
}
