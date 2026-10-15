export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.TWELVEDATA_API_KEY;
  if (!apiKey) {
    return res.status(503).json({
      ok: false,
      symbol: "XAU/USD",
      interval: "15min",
      error: "Market-data provider is not configured. Add TWELVEDATA_API_KEY as a server-side environment variable."
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 9000);
  try {
    const url = new URL("https://api.twelvedata.com/time_series");
    url.searchParams.set("symbol", "XAU/USD");
    url.searchParams.set("interval", "15min");
    url.searchParams.set("outputsize", "250");
    url.searchParams.set("format", "JSON");
    url.searchParams.set("apikey", apiKey);

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: { "Accept": "application/json" },
      signal: controller.signal
    });
    const payload = await response.json().catch(() => null);

    if (!response.ok || !payload || payload.status === "error" || !Array.isArray(payload.values)) {
      // Never return the upstream request URL or key to the browser.
      const providerMessage = payload && typeof payload.message === "string"
        ? payload.message.slice(0, 240)
        : "Provider returned an unexpected response.";
      return res.status(502).json({
        ok: false,
        symbol: "XAU/USD",
        interval: "15min",
        error: "Market-data request failed. Check provider access, symbol entitlement, and API quota.",
        providerMessage
      });
    }

    const candles = payload.values
      .map((v) => ({
        time: v.datetime,
        open: Number(v.open),
        high: Number(v.high),
        low: Number(v.low),
        close: Number(v.close)
      }))
      .filter((v) =>
        typeof v.time === "string" &&
        [v.open, v.high, v.low, v.close].every(Number.isFinite) &&
        v.high >= Math.max(v.open, v.close, v.low) &&
        v.low <= Math.min(v.open, v.close, v.high)
      );

    if (candles.length < 80) {
      return res.status(502).json({
        ok: false,
        symbol: "XAU/USD",
        interval: "15min",
        candleCount: candles.length,
        error: "Insufficient valid candle history for analysis. No signal was generated."
      });
    }

    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=30");
    return res.status(200).json({
      ok: true,
      symbol: "XAU/USD",
      interval: "15min",
      source: "Twelve Data",
      candleCount: candles.length,
      latestCandleTime: candles[0].time,
      candles
    });
  } catch (error) {
    const timedOut = error && error.name === "AbortError";
    return res.status(timedOut ? 504 : 502).json({
      ok: false,
      symbol: "XAU/USD",
      interval: "15min",
      error: timedOut ? "Market-data provider timed out." : "Could not reach market-data provider."
    });
  } finally {
    clearTimeout(timeout);
  }
}
