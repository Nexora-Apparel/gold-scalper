import { hasOwnerSession } from "../lib/auth.js";

function parseProviderTime(value) {
  if (typeof value !== "string") return NaN;
  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  return Date.parse(normalized.endsWith("Z") ? normalized : normalized + "Z");
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const cronSecret = process.env.CRON_SECRET;
  const cronAuthorized = Boolean(cronSecret && req.headers?.authorization === `Bearer ${cronSecret}`);
  if (!hasOwnerSession(req) && !cronAuthorized) {
    return res.status(401).json({ ok: false, error: "Owner login or valid scheduled-monitor authorization required." });
  }

  const apiKey = process.env.TWELVEDATA_API_KEY;
  if (!apiKey) {
    return res.status(503).json({
      ok: false,
      symbol: "BTC/USD",
      interval: "15min",
      error: "Market-data provider is not configured. Add TWELVEDATA_API_KEY as a server-side environment variable."
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 9000);
  try {
    const url = new URL("https://api.twelvedata.com/time_series");
    url.searchParams.set("symbol", "BTC/USD");
    url.searchParams.set("interval", "15min");
    url.searchParams.set("outputsize", "250");
    url.searchParams.set("format", "JSON");
    url.searchParams.set("timezone", "UTC");
    url.searchParams.set("apikey", apiKey);

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal
    });
    const payload = await response.json().catch(() => null);

    if (!response.ok || !payload || payload.status === "error" || !Array.isArray(payload.values)) {
      const providerMessage = payload && typeof payload.message === "string"
        ? payload.message.slice(0, 240)
        : "Provider returned an unexpected response.";
      return res.status(502).json({
        ok: false,
        symbol: "BTC/USD",
        interval: "15min",
        error: "Market-data request failed. Check provider access, symbol entitlement, and API quota.",
        providerMessage
      });
    }

    const now = Date.now();
    const intervalMs = 15 * 60 * 1000;
    const candles = payload.values.map((v) => ({
      time: v.datetime,
      _timeMs: parseProviderTime(v.datetime),
      open: Number(v.open),
      high: Number(v.high),
      low: Number(v.low),
      close: Number(v.close)
    })).filter((v) =>
      Number.isFinite(v._timeMs) &&
      [v.open, v.high, v.low, v.close].every(Number.isFinite) &&
      v.high >= Math.max(v.open, v.close, v.low) &&
      v.low <= Math.min(v.open, v.close, v.high) &&
      v._timeMs + intervalMs <= now
    ).sort((a, b) => b._timeMs - a._timeMs);

    if (candles.length < 80) {
      return res.status(502).json({
        ok: false,
        symbol: "BTC/USD",
        interval: "15min",
        candleCount: candles.length,
        error: "Insufficient valid completed candle history. No signal should be generated."
      });
    }

    // Provider timestamps mark candle open time; freshness is measured from close.
    const latestAgeMs = now - (candles[0]._timeMs + intervalMs);
    if (latestAgeMs < 0 || latestAgeMs > 45 * 60 * 1000) {
      return res.status(502).json({
        ok: false,
        symbol: "BTC/USD",
        interval: "15min",
        candleCount: candles.length,
        latestCandleTime: candles[0].time,
        dataFreshness: "stale",
        error: "Latest completed BTC/USD candle is stale. No signal should be generated."
      });
    }

    const cleanCandles = candles.map(({ _timeMs, ...c }) => c);
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      ok: true,
      symbol: "BTC/USD",
      interval: "15min",
      source: "Twelve Data",
      candleCount: cleanCandles.length,
      latestCandleTime: cleanCandles[0].time,
      dataFreshness: "verified",
      candles: cleanCandles
    });
  } catch (error) {
    const timedOut = error && error.name === "AbortError";
    return res.status(timedOut ? 504 : 502).json({
      ok: false,
      symbol: "BTC/USD",
      interval: "15min",
      error: timedOut ? "Market-data provider timed out." : "Could not verify fresh market data."
    });
  } finally {
    clearTimeout(timeout);
  }
}
