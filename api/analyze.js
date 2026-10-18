import { analyzeGold } from "../lib/strategy.js";
import { hasOwnerSession } from "../lib/auth.js";
import { ensureStorage, getControlState, getStoredSettings, recordHistory, countSignalsToday, getActiveSignal, saveActiveSignal } from "../lib/storage.js";
import { sendTelegramMessage, formatSignalMessage } from "../lib/telegram.js";
import { evaluateSignalLifecycle } from "../lib/signal-lifecycle.js";
import { getNewsStatus } from "../lib/news-filter.js";
import { getGoldMarketStatus } from "../lib/market-hours.js";

const INTERVAL_MS = { "1h": 60 * 60 * 1000, "15min": 15 * 60 * 1000 };

function parseProviderTime(value) {
  if (typeof value !== "string") return NaN;
  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  return Date.parse(normalized.endsWith("Z") ? normalized : normalized + "Z");
}

function isWithinSession(settings, now = new Date()) {
  if (settings.scanMode === "24h") return true;
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Lagos", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const hour = Number(parts.find(p => p.type === "hour")?.value);
  const minute = Number(parts.find(p => p.type === "minute")?.value);
  const current = hour * 60 + minute;
  const startParts = String(settings.sessionStart || "08:00").split(":").map(Number);
  const endParts = String(settings.sessionEnd || "20:00").split(":").map(Number);
  const start = startParts[0] * 60 + startParts[1];
  const end = endParts[0] * 60 + endParts[1];
  return start < end ? current >= start && current < end : current >= start || current < end;
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
  const cronSecret = process.env.CRON_SECRET;
  const cronAuthorized = Boolean(cronSecret && req.headers?.authorization === `Bearer ${cronSecret}`);
  if (!hasOwnerSession(req) && !cronAuthorized) {
    return res.status(401).json({ status: "NO_TRADE", signal: null, error: "Owner login or valid scheduled-monitor authorization required." });
  }

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
    const marketStatus = getGoldMarketStatus();
    if (!marketStatus.open) {
      const closed = {
        status: "NO_TRADE", signal: null, marketDataVerified: false,
        marketOpen: false, marketStatus: marketStatus.status,
        reason: marketStatus.reason,
        checkedAt: new Date().toISOString()
      };
      await recordHistory(sql, closed);
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json(closed);
    }
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
        ![1.5, 2, 2.5, 3].includes(settings.minRR) || ![65, 70, 75, 80].includes(settings.minQuality) || ![1, 2, 3].includes(settings.maxSignals)) {
      return res.status(400).json({ status: "NO_TRADE", signal: null, error: "Invalid risk settings." });
    }

    const signalCount = await countSignalsToday(sql);
    const existingActiveSignal = await getActiveSignal(sql);
    const activeNeedsMonitoring = existingActiveSignal && ["WAITING_FOR_ENTRY", "CONFIRMATION_PENDING_DELIVERY"].includes(existingActiveSignal.state);
    if (!isWithinSession(saved) && !activeNeedsMonitoring) {
      const outside = { status: "NO_TRADE", signal: null, marketDataVerified: false,
        reason: "Outside configured XAUUSD monitoring hours (" + (saved.sessionStart || "08:00") + "–" + (saved.sessionEnd || "20:00") + " Africa/Lagos). No market-data request was made.",
        checkedAt: new Date().toISOString(), scanMode: saved.scanMode || "session" };
      await recordHistory(sql, outside);
      return res.status(200).json(outside);
    }
    if (signalCount >= settings.maxSignals && !activeNeedsMonitoring) {
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
      const newsStatus = await getNewsStatus();
      let result = {
        ...analyzeGold(hourly, fifteen, settings),
        source: "Twelve Data",
        checkedAt: new Date().toISOString(),
        marketDataVerified: true,
        latestCompletedCandle: { h1: hourly[0].time, m15: fifteen[0].time },
        dataFreshness: "verified",
        newsStatus: {
          status: newsStatus.status,
          blocked: newsStatus.blocked,
          reason: newsStatus.reason,
          ...(newsStatus.event ? { event: newsStatus.event } : {})
        }
      };
      // News protection applies to new candidates. Existing pending signals still
      // advance through lifecycle monitoring, but no new candidate can be queued
      // if the calendar is unavailable or a high-impact USD event is nearby.
      if (result.status === "SIGNAL_CANDIDATE" && result.signal && newsStatus.blocked) {
        result = {
          ...result,
          status: "NO_TRADE",
          signal: null,
          newsBlocked: true,
          reason: newsStatus.reason
        };
      }
      // A candle-based trigger can be crossed before the next scheduled scan.
      // Verify the provider's current quote before persisting any new pending entry.
      if (result.status === "SIGNAL_CANDIDATE" && result.signal) {
        const priceUrl = new URL("https://api.twelvedata.com/price");
        priceUrl.searchParams.set("symbol", "XAU/USD");
        priceUrl.searchParams.set("apikey", key);
        const priceResponse = await fetch(priceUrl.toString(), {
          headers: { Accept: "application/json" },
          signal: controller.signal
        });
        const pricePayload = await priceResponse.json().catch(() => null);
        const livePrice = Number(pricePayload?.price);
        if (!priceResponse.ok || !pricePayload || pricePayload.status === "error" ||
            !Number.isFinite(livePrice) || livePrice <= 0) {
          result = {
            ...result, status: "NO_TRADE", signal: null, livePriceVerified: false,
            reason: "Unable to verify the current XAU/USD quote. The pending entry was not queued."
          };
        } else {
          const triggerStillAhead = result.signal.side === "BUY"
            ? result.signal.entry > livePrice
            : result.signal.entry < livePrice;
          if (!triggerStillAhead) {
            result = {
              ...result, status: "NO_TRADE", signal: null, livePriceVerified: true,
              currentPrice: livePrice,
              reason: "The proposed pending entry has already been crossed or is no longer ahead of the current quote. No signal was queued."
            };
          } else {
            result.livePriceVerified = true;
            result.currentPrice = livePrice;
          }
        }
      }

      // Lifecycle policy: never alert on a fresh candidate. Keep one active candidate
      // in persistent storage and notify only after a later completed M15 candle
      // trades through its entry. This is request-driven monitoring, not a background worker.
      let active = await getActiveSignal(sql);
      if (active && active.state === "WAITING_FOR_ENTRY") {
        const lifecycle = evaluateSignalLifecycle(active, fifteen);
        if (lifecycle.changed) {
          active = lifecycle.active;
          await saveActiveSignal(sql, active);
          if (lifecycle.event?.type === "INVALIDATED") {
            result.entryMonitoring = { state: "INVALIDATED", note: "The stop-loss or target was touched before entry could be safely confirmed; no Telegram signal was sent." };
          } else if (lifecycle.event?.type === "EXPIRED") {
            result.entryMonitoring = { state: "EXPIRED", note: "The setup expired after eight hours without safe entry confirmation; no Telegram signal was sent." };
          }
        }
      }
      if (active && active.state === "CONFIRMATION_PENDING_DELIVERY" && active.result?.signal) {
        if (newsStatus.blocked) {
          // Do not release an entry-confirmation alert during a high-impact USD
          // news window or when the calendar cannot be verified. Retry after it clears.
          result.entryMonitoring = {
            state: "CONFIRMED_AWAITING_NEWS_CLEAR",
            confirmationCandleTime: active.confirmationCandleTime,
            newsStatus: newsStatus.status,
            note: "Entry confirmation is held until the news calendar is verified clear."
          };
        } else {
          const confirmedResult = {
            ...active.result,
            signal: { ...active.result.signal, status: "CONFIRMED" },
            confirmation: { status: "ENTRY_CONFIRMED", confirmedAt: active.confirmedAt, candleTime: active.confirmationCandleTime },
            newsStatus: result.newsStatus,
            checkedAt: result.checkedAt
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
      }
      if (result.status === "SIGNAL_CANDIDATE" && result.signal) {
        if (signalCount >= settings.maxSignals && (!active || ["CONFIRMED_AND_NOTIFIED", "INVALIDATED", "EXPIRED"].includes(active.state))) {
          result.status = "NO_TRADE";
          result.signal = null;
          result.reason = `Daily signal limit reached (${signalCount}/${settings.maxSignals} Africa/Lagos time). No additional candidate was queued.`;
          result.entryMonitoring = { state: "DAILY_LIMIT_REACHED" };
        } else if (!active || ["CONFIRMED_AND_NOTIFIED", "INVALIDATED", "EXPIRED"].includes(active.state)) {
          const newActive = {
            state: "WAITING_FOR_ENTRY",
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
            result
          };
          await saveActiveSignal(sql, newActive);
          result.entryMonitoring = { state: "WAITING_FOR_ENTRY", created: true, telegramSent: false, note: "No Telegram alert is sent until a later completed M15 candle trades through the entry." };
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
