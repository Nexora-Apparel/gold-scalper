import { analyzeGold } from "../lib/strategy.js";

const INTERVAL_MS = { "1h": 60 * 60 * 1000, "15min": 15 * 60 * 1000 };

function parseProviderTime(value) {
  if (typeof value !== "string") return NaN;
  // Requests explicitly ask Twelve Data for UTC timestamps.
  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  return Date.parse(normalized.endsWith("Z") ? normalized : normalized + "Z");
}

function validateCandles(values, interval, minimum) {
  if (!Array.isArray(values)) throw new Error("Provider returned no candle data");
  const intervalMs = INTERVAL_MS[interval];
  const now = Date.now();
  const parsed = values.map((v) => {
    const timeMs = parseProviderTime(v?.datetime);
    const candle = {
      time: v?.datetime,
      open: Number(v?.open),
      high: Number(v?.high),
      low: Number(v?.low),
      close: Number(v?.close),
      _timeMs: timeMs
    };
    const valid = Number.isFinite(timeMs) &&
      [candle.open, candle.high, candle.low, candle.close].every(Number.isFinite) &&
      candle.high >= Math.max(candle.open, candle.close, candle.low) &&
      candle.low <= Math.min(candle.open, candle.close, candle.high);
    if (!valid) throw new Error("Provider returned malformed OHLC candles");
    return candle;
  });

  // Provider data is usually newest-first; sort explicitly and remove the
  // still-forming candle so signals only use completed bars.
  const completed = parsed
    .filter((c) => c._timeMs + intervalMs <= now)
    .sort((a, b) => b._timeMs - a._timeMs);

  if (completed.length < minimum) throw new Error("Insufficient completed candle history");
  const latestAgeMs = now - completed[0]._timeMs;
  // Fail closed rather than using old quotes. A closed market/weekend will
  // therefore produce no signal until a fresh completed candle is available.
  const freshnessLimit = interval === "15min" ? 45 * 60 * 1000 : 90 * 60 * 1000;
  if (latestAgeMs < 0 || latestAgeMs > freshnessLimit) {
    throw new Error(`Stale ${interval} candles; latest completed candle is not fresh`);
  }
  return completed.map(({ _timeMs, ...c }) => c);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const key = process.env.TWELVEDATA_API_KEY;
  if (!key) return res.status(503).json({ status: "NO_TRADE", signal: null, marketDataVerified: false, error: "Market data is not configured. No signal generated." });

  const body = req.body || {};
  const settings = {
    balance: Number(body.balance ?? 1000),
    currency: ["USD", "NGN", "EUR", "GBP"].includes(body.currency) ? body.currency : "USD",
    riskPercent: Number(body.riskPercent ?? 0.5),
    minRR: Number(body.minRR ?? 2),
    minQuality: Number(body.minQuality ?? 70)
  };
  if (!(settings.balance > 0) || !(settings.riskPercent >= 0.1 && settings.riskPercent <= 1) || !(settings.minRR >= 1.5 && settings.minRR <= 3) || !(settings.minQuality >= 65 && settings.minQuality <= 80)) {
    return res.status(400).json({ status: "NO_TRADE", signal: null, error: "Invalid risk settings." });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    async function candles(interval, size) {
      const u = new URL("https://api.twelvedata.com/time_series");
      u.searchParams.set("symbol", "XAU/USD");
      u.searchParams.set("interval", interval);
      u.searchParams.set("outputsize", String(size));
      u.searchParams.set("format", "JSON");
      u.searchParams.set("timezone", "UTC");
      u.searchParams.set("apikey", key);
      const r = await fetch(u.toString(), { headers: { Accept: "application/json" }, signal: controller.signal });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j || j.status === "error" || !Array.isArray(j.values)) {
        throw new Error(j?.message || "Provider returned no candle data");
      }
      return validateCandles(j.values, interval, interval === "1h" ? 60 : 80);
    }

    const [hourly, fifteen] = await Promise.all([candles("1h", 120), candles("15min", 250)]);
    const result = analyzeGold(hourly, fifteen, settings);
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      ...result,
      source: "Twelve Data",
      checkedAt: new Date().toISOString(),
      marketDataVerified: true,
      latestCompletedCandle: { h1: hourly[0].time, m15: fifteen[0].time },
      dataFreshness: "verified"
    });
  } catch (e) {
    const timedOut = e?.name === "AbortError";
    return res.status(timedOut ? 504 : 502).json({
      status: "NO_TRADE",
      signal: null,
      marketDataVerified: false,
      dataFreshness: "unverified",
      error: "Unable to verify fresh, completed XAU/USD candles. No signal generated.",
      detail: String(e?.message || "provider error").slice(0, 200)
    });
  } finally {
    clearTimeout(timer);
  }
}
