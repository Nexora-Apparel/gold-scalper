import { analyzeGold } from "../lib/strategy.js";
import { hasOwnerSession } from "../lib/auth.js";
import { ensureStorage, getControlState, getStoredSettings, recordHistory, countSignalsToday, getActiveSignal, saveActiveSignal, clearActiveSignal } from "../lib/storage.js";
import { sendTelegramMessage, formatSignalMessage } from "../lib/telegram.js";

const INTERVAL_MS = { "1h": 60 * 60 * 1000, "15min": 15 * 60 * 1000 };

function parseProviderTime(value) {
  if (typeof value !== "string") return NaN;
  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  return Date.parse(normalized.endsWith("Z") ? normalized : normalized + "Z");
}

function validateCandles(values, interval, minimum) {
  if (!Array.isArray(values)) throw new Error("Provider returned no candle data");
  const intervalMs = INTERVAL_MS[interval];
  const now = Date.now();
  const parsed = values.map((v) => {
    const timeMs = parseProviderTime(v?.datetime);
    const candle = { time: v?.datetime, open: Number(v?.open), high: Number(v?.high), low: Number(v?.low), close: Number(v?.close), _timeMs: timeMs };
    const valid = Number.isFinite(timeMs) &&
      [candle.open, candle.high, candle.low, candle.close].every(Number.isFinite) &&
      candle.high >= Math.max(candle.open, candle.close, candle.low) &&
      candle.low <= Math.min(candle.open, candle.close, candle.high);
    if (!valid) throw new Error("Provider returned malformed OHLC candles");
    return candle;
  });
  const completed = parsed.filter((c) => c._timeMs + intervalMs <= now).sort((a, b) => b._timeMs - a._timeMs);
  if (completed.length < minimum) throw new Error("Insufficient completed candle history");
  const latestAgeMs = now - completed[0]._timeMs;
  const freshnessLimit = interval === "15min" ? 45 * 60 * 1000 : 90 * 60 * 1000;
  if (latestAgeMs < 0 || latestAgeMs > freshnessLimit) throw new Error(`Stale ${interval} candles; latest completed candle is not fresh`);
  return completed.map(({ _timeMs, ...c }) => c);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!hasOwnerSession(req)) return res.status(401).json({ status: "NO_TRADE", signal: null, error: "Owner login required before analysis." });

  let sql;
  try {
    sql = await ensureStorage();
    const control = await getControlState(sql);
    if (control.emergencyStop || control.engine !== "RUNNING") {
      const blocked = {
        status: "NO_TRADE", signal: null, marketDataVerified: false,
        reason: control.emergencyStop ? "Emergency stop is active. Reset it explicitly before starting the engine." : "Signal engine is paused. Press START BOT before analysis.",
        checkedAt: new Date().toISOString()
      };
      await recordHistory(sql, blocked);
      return res.status(200).json(blocked);
    }

    const key = process.env.TWELVEDATA_API_KEY;
    if (!key) {
      const unavailable = { status: "NO_TRADE", signal: null, marketDataVerified: false, error: "Market data is not configured. No signal generated." };
      await recordHistory(sql, unavailable);
      return res.status(503).json(unavailable);
    }

    const body = req.body || {};
    const saved = await getStoredSettings(sql);
    if (saved.goldEnabled === false || body.goldEnabled === false) {
      const disabled = { status: "NO_TRADE", signal: null, marketDataVerified: false, reason: "XAUUSD is disabled in saved settings. Enable Gold before analysis." };
      await recordHistory(sql, disabled);
      return res.status(200).json(disabled);
    }
    const settings = {
      balance: Number(body.balance ?? saved.balance ?? 1000),
      currency: ["USD", "NGN", "EUR", "GBP"].includes(body.currency ?? saved.currency) ? (body.currency ?? saved.currency) : "USD",
      riskPercent: Number(body.riskPercent ?? saved.riskPercent ?? 0.5),
      minRR: Number(body.minRR ?? saved.minRR ?? 2),
      minQuality: Number(body.minQuality ?? saved.minQuality ?? 70),
      maxSignals: Number(body.maxSignals ?? saved.maxSignals ?? 3)
    };
    if (!(settings.balance > 0) || !(settings.riskPercent >= 0.1 && settings.riskPercent <= 1) ||
        ![1.5, 2, 2.5, 3].includes(settings.minRR) || ![65, 70, 75, 80].includes(settings.minQuality) || ![1, 3, 5, 8].includes(settings.maxSignals)) {
      return res.status(400).json({ status: "NO_TRADE", signal: null, error: "Invalid risk settings." });
    }

    const signalCount = await countSignalsToday(sql);
    if (signalCount >= settings.maxSignals) {
      const limited = { status: "NO_TRADE", signal: null, marketDataVerified: false, reason: `Daily signal limit reached (${signalCount}/${settings.maxSignals} Africa/Lagos time). No additional signal will be generated today.` };
      await recordHistory(sql, limited);
      return res.status(200).json(limited);
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
        if (!r.ok || !j || j.status === "error" || !Array.isArray(j.values)) throw new Error(j?.message || "Provider returned no candle data");
        return validateCandles(j.values, interval, interval === "1h" ? 60 : 80);
      }
      const [hourly, fifteen] = await Promise.all([candles("1h", 120), candles("15min", 250)]);
      const result = {
        ...analyzeGold(hourly, fifteen, settings),
        source: "Twelve Data",
        checkedAt: new Date().toISOString(),
        marketDataVerified: true,
        latestCompletedCandle: { h1: hourly[0].time, m15: fifteen[0].time },
        dataFreshness: "verified"
      };
      // Lifecycle policy: never alert on a fresh candidate. Keep one active candidate
      // in persistent storage and notify only after a later completed M15 candle
      // trades through its entry. This is request-driven monitoring, not a background worker.
      let active = await getActiveSignal(sql);
      const latestM15 = fifteen[0];
      if (active && active.state === "WAITING_FOR_ENTRY" && active.result?.signal) {
        const activeSignal = active.result.signal;
        const activeCandleMs = parseProviderTime(activeSignal.candleTime);
        const latestCandleMs = parseProviderTime(latestM15.time);
        const entry = Number(activeSignal.entry);
        const stop = Number(activeSignal.stopLoss);
        const target = Number(activeSignal.takeProfit);
        const isLaterCandle = Number.isFinite(activeCandleMs) && Number.isFinite(latestCandleMs) && latestCandleMs > activeCandleMs;
        const touched = Number.isFinite(entry) && isLaterCandle && latestM15.low <= entry && latestM15.high >= entry;
        // OHLC cannot establish intrabar order. If SL or TP was touched before/with
        // the entry touch, fail closed rather than send a potentially stale alert.
        const riskBoundaryTouched = isLaterCandle && (
          activeSignal.side === "BUY"
            ? latestM15.low <= stop || latestM15.high >= target
            : latestM15.high >= stop || latestM15.low <= target
        );
        if (riskBoundaryTouched) {
          active = { ...active, state: "INVALIDATED", invalidatedAt: new Date().toISOString(), invalidationCandleTime: latestM15.time };
          await saveActiveSignal(sql, active);
          result.entryMonitoring = { state: "INVALIDATED", note: "The stop-loss or target was touched before entry could be safely confirmed; no Telegram signal was sent." };
        } else if (touched) {
          active = { ...active, state: "CONFIRMATION_PENDING_DELIVERY", confirmedAt: new Date().toISOString(), confirmationCandleTime: latestM15.time };
          await saveActiveSignal(sql, active);
        }
      }
      if (active && active.state === "CONFIRMATION_PENDING_DELIVERY" && active.result?.signal) {
        const confirmedResult = {
          ...active.result,
          signal: { ...active.result.signal, status: "CONFIRMED" },
          confirmation: { status: "ENTRY_CONFIRMED", confirmedAt: active.confirmedAt, candleTime: active.confirmationCandleTime }
        };
        const delivery = await sendTelegramMessage(formatSignalMessage(confirmedResult));
        result.entryMonitoring = {
          state: delivery.sent ? "CONFIRMED_AND_NOTIFIED" : "CONFIRMED_AWAITING_TELEGRAM",
          confirmationCandleTime: active.confirmationCandleTime,
          ...(delivery.message ? { deliveryMessage: delivery.message } : {})
        };
        if (delivery.sent) {
          await saveActiveSignal(sql, { ...active, state: "CONFIRMED_AND_NOTIFIED", telegramMessageId: delivery.messageId ?? null, notifiedAt: new Date().toISOString() });
        }
      }
      if (result.status === "SIGNAL_CANDIDATE" && result.signal) {
        if (!active || ["CONFIRMED_AND_NOTIFIED", "INVALIDATED"].includes(active.state)) {
          const newActive = {
            state: "WAITING_FOR_ENTRY",
            createdAt: new Date().toISOString(),
            result
          };
          await saveActiveSignal(sql, newActive);
          result.entryMonitoring = { state: "WAITING_FOR_ENTRY", telegramSent: false, note: "No Telegram alert is sent until a later completed M15 candle trades through the entry." };
        } else {
          result.entryMonitoring = { state: active.state, note: "An existing signal is being monitored; this candidate was not sent and did not replace it." };
        }
      }
      await recordHistory(sql, result);
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json(result);
    } catch (error) {
      const timedOut = error?.name === "AbortError";
      const unavailable = {
        status: "NO_TRADE", signal: null, marketDataVerified: false, dataFreshness: "unverified",
        error: "Unable to verify fresh, completed XAU/USD candles. No signal generated.",
        detail: String(error?.message || "provider error").slice(0, 200),
        checkedAt: new Date().toISOString()
      };
      await recordHistory(sql, unavailable);
      return res.status(timedOut ? 504 : 502).json(unavailable);
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    console.error("Analysis/storage failure:", error?.message || "unknown error");
    return res.status(503).json({ status: "NO_TRADE", signal: null, marketDataVerified: false, error: "Persistent storage is unavailable. No signal generated." });
  }
}
