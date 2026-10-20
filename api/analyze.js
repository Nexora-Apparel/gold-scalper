import { randomUUID } from "node:crypto";
import { analyzeGold } from "../lib/strategy.js";
import { hasOwnerSession } from "../lib/auth.js";
import { ensureStorage, getControlState, getStoredSettings, recordHistory, countSignalsToday, getActiveSignal, saveActiveSignal, claimMonitorLock, releaseMonitorLock, getRecordedOutcome } from "../lib/storage.js";
import { sendTelegramMessage, sendTelegramSignal } from "../lib/telegram.js";
import { evaluateSignalLifecycle } from "../lib/signal-lifecycle.js";
import { processRsiRejectionAlert } from "../lib/rsi-rejection-alerts.js";
import { getNewsStatus } from "../lib/news-filter.js";
import { getGoldMarketStatus } from "../lib/market-hours.js";

const INTERVAL_MS = { "1h": 60 * 60 * 1000, "15min": 15 * 60 * 1000, "5min": 5 * 60 * 1000 };

function parseProviderTime(value) {
  if (typeof value !== "string") return NaN;
  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  return Date.parse(normalized.endsWith("Z") ? normalized : normalized + "Z");
}

export function isWithinSession(settings, now = new Date()) {
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

export function validateCandles(values, interval, minimum, now = Date.now()) {
  if (!Array.isArray(values)) throw new Error("Provider returned no candle data");
  const intervalMs = INTERVAL_MS[interval];
  if (!Number.isFinite(intervalMs)) throw new Error(`Unsupported candle interval: ${interval}`);
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
  const timestamps = parsed.map((c) => c._timeMs);
  if (new Set(timestamps).size !== timestamps.length) throw new Error("Provider returned duplicate candle timestamps");
  const completed = parsed.filter((c) => c._timeMs + intervalMs <= now).sort((a, b) => b._timeMs - a._timeMs);
  if (completed.length < minimum) throw new Error("Insufficient completed candle history");
  // Provider timestamps mark candle open time; freshness must be measured from candle close.
  const latestAgeMs = now - (completed[0]._timeMs + intervalMs);
  const freshnessLimit = interval === "5min" ? 20 * 60 * 1000 : interval === "15min" ? 45 * 60 * 1000 : 90 * 60 * 1000;
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
      let pausedSignal = await getActiveSignal(sql);
      if (pausedSignal && ["WAITING_FOR_ENTRY", "CONFIRMATION_PENDING_DELIVERY"].includes(pausedSignal.state)) {
        pausedSignal = {
          ...pausedSignal,
          state: pausedSignal.state === "CONFIRMATION_PENDING_DELIVERY" ? "CONFIRMATION_EXPIRED" : "CANCELLED_BY_PAUSE",
          pausedAt: new Date().toISOString(),
          confirmationExpiryReason: "The engine was paused before the confirmation alert could be safely delivered."
        };
        await saveActiveSignal(sql, pausedSignal);
      }
      const needsPauseNotice = pausedSignal &&
        ["CANCELLED_BY_PAUSE", "CONFIRMATION_EXPIRED", "INVALIDATED", "EXPIRED"].includes(pausedSignal.state) &&
        pausedSignal.candidateNotification?.sent === true &&
        pausedSignal.lifecycleNotification?.sent !== true;
      if (needsPauseNotice) {
        const confirmationExpired = pausedSignal.state === "CONFIRMATION_EXPIRED";
        const cancelled = pausedSignal.state === "CANCELLED_BY_PAUSE";
        const message = confirmationExpired
          ? "⚠️ <b>EXPIRED — DO NOT ENTER (XAUUSD)</b>\nThe engine was paused before a safe confirmation alert could be delivered. Do not act on a delayed confirmation."
          : cancelled
            ? "⏸️ <b>XAUUSD PENDING SETUP CANCELLED</b>\nThe signal engine was paused. Do not place this pending order; cancel it if you already placed it manually."
            : pausedSignal.state === "INVALIDATED"
              ? "⚠️ <b>INVALIDATED — DO NOT ENTER (XAUUSD)</b>\nPrice touched the stop-loss or target before entry confirmation. Cancel this pending order if you placed it manually."
              : "⌛ <b>EXPIRED — DO NOT ENTER (XAUUSD)</b>\nThe entry was not confirmed within eight hours. Do not place this expired pending order.";
        const delivery = await sendTelegramMessage(message);
        pausedSignal = {
          ...pausedSignal,
          lifecycleNotification: delivery.sent
            ? { sent: true, sentAt: new Date().toISOString(), messageId: delivery.messageId ?? null }
            : { sent: false, lastAttemptAt: new Date().toISOString(), message: delivery.message || "Telegram delivery failed." }
        };
        await saveActiveSignal(sql, pausedSignal);
      }
      const blocked = {
        status: "NO_TRADE", signal: null, marketDataVerified: false, monitorSkipped: true, skipReason: "ENGINE_PAUSED",
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
      const disabled = { status: "NO_TRADE", signal: null, marketDataVerified: false, monitorSkipped: true, skipReason: "GOLD_DISABLED", reason: "XAUUSD is disabled in saved settings. Enable Gold before analysis." };
      await recordHistory(sql, disabled);
      return res.status(200).json(disabled);
    }
    const settings = {
      strategyMode: saved.strategyMode === "EMA_RIBBON_RSI" ? "EMA_RIBBON_RSI" : "MSNR_SMC",
      timeframe: saved.timeframe === "M5" ? "M5" : "M15",
      atrTargetMultiple: Number(saved.atrTargetMultiple) === 3 ? 3 : 4,
      symbol: "XAUUSD",
      balance: Number(body.balance ?? saved.balance ?? 1000),
      currency: ["USD", "NGN", "EUR", "GBP"].includes(body.currency ?? saved.currency) ? (body.currency ?? saved.currency) : "USD",
      riskPercent: Number(body.riskPercent ?? saved.riskPercent ?? 0.5),
      minRR: Number(body.minRR ?? saved.minRR ?? 2),
      minQuality: Number(body.minQuality ?? saved.minQuality ?? 70),
      maxSignals: Number(body.maxSignals ?? saved.maxSignals ?? 3),
      scanMode: saved.scanMode || "session",
      sessionStart: saved.sessionStart || "08:00",
      sessionEnd: saved.sessionEnd || "20:00"
    };
    if (!(settings.balance > 0) || !(settings.riskPercent >= 0.1 && settings.riskPercent <= 1) ||
        ![1.5, 2, 2.5, 3].includes(settings.minRR) || ![65, 70, 75, 80].includes(settings.minQuality) || ![1, 2, 3].includes(settings.maxSignals)) {
      return res.status(400).json({ status: "NO_TRADE", signal: null, error: "Invalid risk settings." });
    }

    const goldMarketStatus = getGoldMarketStatus();
    if (!goldMarketStatus.open) {
      const closed = { status: "NO_TRADE", signal: null, marketDataVerified: false, marketOpen: false,
        reason: goldMarketStatus.reason, checkedAt: new Date().toISOString() };
      await recordHistory(sql, closed);
      return res.status(200).json(closed);
    }

    let signalCount = await countSignalsToday(sql);
    let existingActiveSignal = await getActiveSignal(sql);
    // Resolve stale confirmed signals before session/daily-cap short-circuits, without inventing outcomes.
    if (existingActiveSignal?.state === "CONFIRMED_AND_NOTIFIED") {
      const signalRef = existingActiveSignal.result?.signal?.signalRef;
      const recordedOutcome = signalRef ? await getRecordedOutcome(sql, signalRef) : null;
      const notifiedMs = Date.parse(existingActiveSignal.notifiedAt || existingActiveSignal.confirmedAt || "");
      if (recordedOutcome) {
        existingActiveSignal = { ...existingActiveSignal, state: "CLOSED_WITH_OUTCOME", closedAt: recordedOutcome.recordedAt || new Date().toISOString(), recordedOutcome: recordedOutcome.outcome };
        await saveActiveSignal(sql, existingActiveSignal);
      } else if (Number.isFinite(notifiedMs) && Date.now() - notifiedMs > 24 * 60 * 60 * 1000) {
        existingActiveSignal = { ...existingActiveSignal, state: "CLOSED_WITHOUT_OUTCOME", closedAt: new Date().toISOString() };
        await saveActiveSignal(sql, existingActiveSignal);
      }
    }
    const activeNeedsMonitoring = Boolean(existingActiveSignal && (["WAITING_FOR_ENTRY", "CONFIRMATION_PENDING_DELIVERY", "CONFIRMED_AND_NOTIFIED"].includes(existingActiveSignal.state) || (existingActiveSignal.state === "CONFIRMATION_EXPIRED" && existingActiveSignal.lifecycleNotification?.sent !== true)));
    if (!isWithinSession(saved) && !activeNeedsMonitoring) {
      const outside = { status: "NO_TRADE", signal: null, marketDataVerified: false, monitorSkipped: true, skipReason: "OUTSIDE_SESSION",
        reason: "Outside configured XAUUSD monitoring hours (" + (saved.sessionStart || "08:00") + "–" + (saved.sessionEnd || "20:00") + " Africa/Lagos). No market-data request was made.",
        checkedAt: new Date().toISOString(), scanMode: saved.scanMode || "session" };
      await recordHistory(sql, outside);
      return res.status(200).json(outside);
    }
    if (signalCount >= settings.maxSignals && !activeNeedsMonitoring) {
      const limited = { status: "NO_TRADE", signal: null, marketDataVerified: false, monitorSkipped: true, skipReason: "DAILY_LIMIT_REACHED", reason: `Daily signal limit reached (${signalCount}/${settings.maxSignals} Africa/Lagos time). No additional signal will be generated today.` };
      await recordHistory(sql, limited);
      return res.status(200).json(limited);
    }

    let monitorLockToken = null;
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
      const legacyPending = existingActiveSignal?.state === "WAITING_FOR_ENTRY" &&
        existingActiveSignal?.result?.signal?.strategyMode !== "EMA_RIBBON_RSI";
      const [hourly, fifteen, five] = await Promise.all([
        settings.strategyMode !== "EMA_RIBBON_RSI" || legacyPending ? candles("1h", 120) : Promise.resolve([]),
        settings.strategyMode !== "EMA_RIBBON_RSI" || settings.timeframe === "M15" || legacyPending ? candles("15min", 250) : Promise.resolve([]),
        legacyPending || (settings.strategyMode === "EMA_RIBBON_RSI" && settings.timeframe === "M5") ? candles("5min", 250) : Promise.resolve([])
      ]);
      const strategyCandles = settings.strategyMode === "EMA_RIBBON_RSI" && settings.timeframe === "M5" ? five : fifteen;
      let result = {
        ...analyzeGold(hourly, strategyCandles, settings),
        strategyVersion: settings.strategyMode === "EMA_RIBBON_RSI" ? "EMA_RIBBON_RSI_V1" : "MSNR_SMC_CORE3_V1",

        source: "Twelve Data",
        checkedAt: new Date().toISOString(),
        marketDataVerified: true,
        latestCompletedCandle: { ...(hourly[0]?.time ? { h1: hourly[0].time } : {}), ...(fifteen[0]?.time ? { m15: fifteen[0].time } : {}), ...(five[0]?.time ? { m5: five[0].time } : {}) },
        dataFreshness: "verified"
      };
      if (result.status === "SIGNAL_CANDIDATE" && result.signal) {
        const newsStatus = await getNewsStatus({ now: new Date() });
        result.newsStatus = newsStatus;
        // News-calendar status is informational only. Provider outages must not suppress otherwise-valid signals.
        if (!newsStatus.ok || newsStatus.blocked) {
          result.newsWarning = newsStatus.reason || "Economic calendar status is unavailable; review current news manually.";
        }
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
          const intradayImmediate = settings.strategyMode === "EMA_RIBBON_RSI";
          const priceInsideRisk = result.signal.side === "BUY"
            ? livePrice > Number(result.signal.stopLoss) && livePrice < Number(result.signal.takeProfit)
            : livePrice < Number(result.signal.stopLoss) && livePrice > Number(result.signal.takeProfit);
          const triggerStillAhead = result.signal.side === "BUY"
            ? result.signal.entry > livePrice
            : result.signal.entry < livePrice;
          if (intradayImmediate ? !priceInsideRisk : !triggerStillAhead) {
            result = {
              ...result, status: "NO_TRADE", signal: null, livePriceVerified: true,
              currentPrice: livePrice,
              reason: intradayImmediate
                ? "The live quote has already reached or passed the planned stop-loss/target boundary; the candle-close signal was not approved."
                : "The proposed pending entry has already been crossed or is no longer ahead of the current quote. No signal was queued."
            };
          } else {
            result.livePriceVerified = true;
            result.currentPrice = livePrice;
          }
        }
      }

      // Send a pending-entry alert as soon as a fresh candidate is validated and its entry is still ahead.
      // Subsequent completed M5 candles monitor entry confirmation, invalidation, and expiry.
      // Serialize the state-changing portion of monitoring across serverless instances.
      monitorLockToken = randomUUID();
      const lockAcquired = await claimMonitorLock(sql, monitorLockToken);
      if (!lockAcquired) {
        monitorLockToken = null;
        const skipped = { status: "NO_TRADE", signal: null, marketDataVerified: true,
          monitorSkipped: true, skipReason: "MONITOR_ALREADY_RUNNING",
          reason: "Another monitor pass currently owns the state lock; this overlapping pass was safely skipped.",
          checkedAt: new Date().toISOString() };
        await recordHistory(sql, skipped);
        res.setHeader("Cache-Control", "no-store");
        return res.status(200).json(skipped);
      }
      result.rsiRejectionAlert = await processRsiRejectionAlert(sql, "XAUUSD", result);
      signalCount = await countSignalsToday(sql);
      let active = await getActiveSignal(sql);
      // A confirmed trade remains the active trade until the owner records its
      // manual outcome. This prevents stacking another signal over an open one.
      if (active?.state === "CONFIRMED_AND_NOTIFIED" && active.result?.signal?.signalRef) {
        const recordedOutcome = await getRecordedOutcome(sql, active.result.signal.signalRef);
        if (recordedOutcome) {
          active = {
            ...active,
            state: "CLOSED_WITH_OUTCOME",
            closedAt: recordedOutcome.recordedAt || new Date().toISOString(),
            recordedOutcome: recordedOutcome.outcome
          };
          await saveActiveSignal(sql, active);
        }
      }
      // Safety valve: a confirmed signal with no recorded outcome must not block new signals forever.
      if (active?.state === "CONFIRMED_AND_NOTIFIED") {
        const notifiedMs = Date.parse(active.notifiedAt || active.confirmedAt || "");
        if (Number.isFinite(notifiedMs) && Date.now() - notifiedMs > 24 * 60 * 60 * 1000) {
          active = { ...active, state: "CLOSED_WITHOUT_OUTCOME", closedAt: new Date().toISOString() };
          await saveActiveSignal(sql, active);
        }
      }
      if (active && active.state === "WAITING_FOR_ENTRY") {
        const lifecycle = evaluateSignalLifecycle(active, five, Date.now(), 5 * 60 * 1000);
        if (lifecycle.changed) {
          active = lifecycle.active;
          await saveActiveSignal(sql, active);
          if (lifecycle.event?.type === "INVALIDATED") {
            result.entryMonitoring = {
              state: "INVALIDATED",
              note: "The stop-loss or target was touched before entry confirmation; the pending setup is invalid."
            };
          } else if (lifecycle.event?.type === "EXPIRED") {
            result.entryMonitoring = {
              state: "EXPIRED",
              note: "The setup expired after eight hours without entry confirmation."
            };
          }
        }
      }

      // Never deliver a stale entry-confirmation alert. It is useful only while the
      // confirmation is recent enough to act on safely.
      if (active && active.state === "CONFIRMATION_PENDING_DELIVERY") {
        const confirmedAtMs = Date.parse(active.confirmedAt || "");
        const confirmationAge = Date.now() - confirmedAtMs;
        if (!Number.isFinite(confirmedAtMs) || confirmationAge > 15 * 60 * 1000) {
          active = {
            ...active,
            state: "CONFIRMATION_EXPIRED",
            confirmationExpiredAt: new Date().toISOString(),
            confirmationExpiryReason: "Confirmation notification was not delivered within 15 minutes."
          };
          await saveActiveSignal(sql, active);
        } else if (active.result?.signal) {
          // Verify live quote immediately before sending an entry-confirmed message.
          const liveUrl = new URL("https://api.twelvedata.com/price");
          liveUrl.searchParams.set("symbol", "XAU/USD");
          liveUrl.searchParams.set("apikey", key);
          const liveResponse = await fetch(liveUrl.toString(), {
            headers: { Accept: "application/json" }, signal: controller.signal
          });
          const livePayload = await liveResponse.json().catch(() => null);
          const livePrice = Number(livePayload?.price);
          if (!liveResponse.ok || !livePayload || livePayload.status === "error" ||
              !Number.isFinite(livePrice) || livePrice <= 0) {
            result.entryMonitoring = {
              state: "CONFIRMED_AWAITING_LIVE_PRICE",
              note: "Live XAU/USD quote could not be verified; confirmation notification is deferred and will expire after 15 minutes."
            };
            active = {
              ...active,
              lastLivePriceCheckAt: new Date().toISOString(),
              lastLivePriceCheckFailed: true
            };
            await saveActiveSignal(sql, active);
          } else {
            const signal = active.result.signal;
            const outsideRiskRange = signal.side === "BUY"
              ? livePrice <= Number(signal.stopLoss) || livePrice >= Number(signal.takeProfit)
              : livePrice >= Number(signal.stopLoss) || livePrice <= Number(signal.takeProfit);
            if (outsideRiskRange) {
              active = {
                ...active,
                state: "CONFIRMATION_EXPIRED",
                confirmationExpiredAt: new Date().toISOString(),
                confirmationExpiryReason: "Live price is already at or beyond the stop-loss/target boundary.",
                confirmationPriceAtExpiry: livePrice
              };
              await saveActiveSignal(sql, active);
            } else {
              active = { ...active, lastLivePriceCheckAt: new Date().toISOString(), lastLivePrice: livePrice, lastLivePriceCheckFailed: false };
              await saveActiveSignal(sql, active);
            }
          }
        }
      }

      // Persist and retry invalidation/expiry updates so a transient Telegram failure cannot silently strand a pending order.
      if (active && ["INVALIDATED", "EXPIRED", "CONFIRMATION_EXPIRED", "CANCELLED_BY_PAUSE"].includes(active.state) &&
          active.candidateNotification?.sent === true && active.lifecycleNotification?.sent !== true) {
        const invalidated = active.state === "INVALIDATED";
        const confirmationExpired = active.state === "CONFIRMATION_EXPIRED";
        const update = await sendTelegramMessage(confirmationExpired
          ? "⚠️ <b>EXPIRED — DO NOT ENTER (XAUUSD)</b>\nThe confirmation alert was delayed or the live price had already reached the stop-loss/target boundary. Do not act on the delayed entry confirmation; check the current market manually."
          : invalidated
            ? "⚠️ <b>INVALIDATED — DO NOT ENTER (XAUUSD)</b>\nPrice touched the stop-loss or target before entry confirmation. Do not place this pending order; cancel it if you placed it manually."
            : "⌛ <b>EXPIRED — DO NOT ENTER (XAUUSD)</b>\nThe entry was not confirmed within eight hours. Do not place this expired pending order.");
        const attemptedAt = new Date().toISOString();
        active = {
          ...active,
          lifecycleNotification: update.sent
            ? { sent: true, sentAt: attemptedAt, messageId: update.messageId ?? null }
            : { sent: false, lastAttemptAt: attemptedAt, message: update.message || "Telegram delivery failed." }
        };
        await saveActiveSignal(sql, active);
        result.entryMonitoring = {
          state: active.state,
          updateNotified: update.sent,
          note: update.sent
            ? "The pending setup update was delivered to Telegram."
            : "Telegram delivery failed; the setup update will be retried on a later monitor pass.",
          ...(update.message ? { deliveryMessage: update.message } : {})
        };
      }

      if (active && active.state === "CONFIRMATION_PENDING_DELIVERY" && active.result?.signal && active.lastLivePriceCheckFailed !== true) {
        const confirmedResult = {
          ...active.result,
          signal: { ...active.result.signal, status: "CONFIRMED" },
          confirmation: { status: "ENTRY_CONFIRMED", confirmedAt: active.confirmedAt, candleTime: active.confirmationCandleTime }
        };
        const newsStatus = await getNewsStatus({ now: new Date() });
        // Calendar status is advisory; it must not suppress a confirmed signal notification.
        const delivery = await sendTelegramSignal({
          ...confirmedResult,
          newsStatus,
          ...(newsStatus.ok && newsStatus.blocked ? { newsWarning: newsStatus.reason } :
            !newsStatus.ok ? { newsWarning: newsStatus.reason || "Calendar unavailable; review news manually." } : {})
        });
        result.entryMonitoring = {
          state: delivery.sent ? "CONFIRMED_AND_NOTIFIED" : "CONFIRMED_AWAITING_TELEGRAM",
          confirmationCandleTime: active.confirmationCandleTime,
          ...(delivery.message ? { deliveryMessage: delivery.message } : {})
        };
        if (delivery.sent) {
          active = { ...active, state: "CONFIRMED_AND_NOTIFIED", telegramMessageId: delivery.messageId ?? null, notifiedAt: new Date().toISOString() };
        } else {
          active = { ...active, lastNotificationAttemptAt: new Date().toISOString(), lastNotificationError: delivery.message || "Telegram delivery failed." };
        }
        await saveActiveSignal(sql, active);
      }

      const activeCanBeReplaced = !active ||
        active.state === "CLOSED_WITH_OUTCOME" ||
        active.state === "CLOSED_WITHOUT_OUTCOME" ||
        (active.state === "CANCELLED_BY_PAUSE" && (active.candidateNotification?.sent !== true || active.lifecycleNotification?.sent === true)) ||
        (["INVALIDATED", "EXPIRED", "CONFIRMATION_EXPIRED"].includes(active.state) &&
          (active.candidateNotification?.sent !== true || active.lifecycleNotification?.sent === true));

      if (result.status === "SIGNAL_CANDIDATE" && result.signal) {
        if (!isWithinSession(settings)) {
          result.status = "NO_TRADE";
          result.signal = null;
          result.reason = "Outside the configured Africa/Lagos monitoring session. Existing XAUUSD setups will still be monitored, but no new setup was queued.";
          result.entryMonitoring = { state: "OUTSIDE_SESSION" };
        } else if (signalCount >= settings.maxSignals && activeCanBeReplaced) {
          result.status = "NO_TRADE";
          result.signal = null;
          result.reason = `Daily signal limit reached (${signalCount}/${settings.maxSignals} Africa/Lagos time). No additional candidate was queued.`;
          result.entryMonitoring = { state: "DAILY_LIMIT_REACHED" };
        } else if (activeCanBeReplaced && settings.strategyMode === "EMA_RIBBON_RSI") {
          const delivery = await sendTelegramSignal({ ...result, currentPrice: result.currentPrice, signal: { ...result.signal, status: "CONFIRMED" } });
          const deliveredAt = new Date().toISOString();
          result.telegramDelivery = delivery.sent
            ? { sent: true, sentAt: deliveredAt, messageId: delivery.messageId ?? null }
            : { sent: false, message: delivery.message || "Telegram delivery failed." };
          active = {
            state: delivery.sent ? "CONFIRMED_AND_NOTIFIED" : "CONFIRMATION_PENDING_DELIVERY",
            createdAt: deliveredAt, confirmedAt: deliveredAt, confirmationCandleTime: result.signal.candleTime,
            notifiedAt: delivery.sent ? deliveredAt : null, result,
            candidateNotification: { sent: delivery.sent },
            ...(delivery.sent ? { telegramMessageId: delivery.messageId ?? null } : { lastNotificationAttemptAt: deliveredAt, lastNotificationError: delivery.message || "Telegram delivery failed." })
          };
          await saveActiveSignal(sql, active);
          result.entryMonitoring = {
            state: active.state, created: true, telegramSent: delivery.sent,
            note: delivery.sent ? "Candle-close signal was sent after live quote and risk-boundary validation." : "Signal passed; Telegram delivery failed and will be retried by the monitor.",
            ...(delivery.message ? { deliveryMessage: delivery.message } : {})
          };
        } else if (activeCanBeReplaced) {
          active = {
            state: "WAITING_FOR_ENTRY",
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
            result,
            candidateNotification: { sent: false, suppressed: true }
          };
          await saveActiveSignal(sql, active);
          result.entryMonitoring = {
            state: "WAITING_FOR_ENTRY",
            created: true,
            telegramSent: false,
            note: "Pending-entry alert will be sent immediately while the current quote remains before entry."
          };
        } else if (active && ["INVALIDATED", "EXPIRED"].includes(active.state)) {
          result.entryMonitoring = {
            state: active.state,
            updateNotified: false,
            note: "Waiting for Telegram to deliver the previous setup update; this new candidate was not queued."
          };
        } else {
          result.entryMonitoring = {
            state: active.state,
            note: "An existing signal is being monitored; this new candidate was not queued."
          };
        }
      }

      // Pending candidates are dashboard-only. Telegram is reserved for a confirmed entry.
      if (active && active.state === "WAITING_FOR_ENTRY" && active.result?.signal) {
        result.entryMonitoring = { state: "WAITING_FOR_ENTRY", telegramSent: false,
          note: "No Telegram alert is sent for a candidate. Waiting for completed-M5 entry confirmation." };
      }

      await recordHistory(sql, result);
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json(result);
    } catch (error) {
      const timedOut = error?.name === "AbortError";
      const message = String(error?.message || "provider error");

      // Telegram's final risk/reward validation happens after candles are verified.
      // Treat a rejected signal as a signal-validation failure, never as a market-data outage.
      if (/Signal fails minimum 1\.5R Telegram delivery validation/i.test(message)) {
        const checkedAt = new Date().toISOString();
        if (existingActiveSignal?.state === "CONFIRMATION_PENDING_DELIVERY") {
          const notice = await sendTelegramMessage(
            "⚠️ <b>SETUP REJECTED — DO NOT ENTER (XAUUSD)</b>\nThe setup failed final risk/reward validation after price confirmation. No trade alert was delivered. Do not enter this setup."
          );
          const invalidated = {
            ...existingActiveSignal,
            state: "INVALIDATED",
            invalidatedAt: checkedAt,
            invalidationReason: "Final rounded-price risk/reward validation failed the minimum 1.5R Telegram delivery check.",
            lifecycleNotification: notice.sent
              ? { sent: true, sentAt: checkedAt, messageId: notice.messageId ?? null }
              : { sent: false, lastAttemptAt: checkedAt, message: notice.message || "Rejection notice delivery failed." }
          };
          await saveActiveSignal(sql, invalidated);
        }
        const rejected = {
          status: "NO_TRADE",
          signal: null,
          marketDataVerified: true,
          dataFreshness: "verified",
          reason: "Signal rejected by final risk/reward validation. No Telegram trade alert was delivered; no new entry is approved.",
          detail: message.slice(0, 200),
          checkedAt
        };
        await recordHistory(sql, rejected);
        res.setHeader("Cache-Control", "no-store");
        return res.status(200).json(rejected);
      }
      const utc = new Date();
      const day = utc.getUTCDay();
      const hour = utc.getUTCHours();
      const likelyGoldClosure = day === 6 || (day === 0 && hour < 22) || (day === 5 && hour >= 21) || (day >= 1 && day <= 5 && hour === 21);
      if (/Stale (1h|15min) candles/i.test(message) && likelyGoldClosure) {
        const skipped = { status: "NO_TRADE", signal: null, marketDataVerified: false,
          monitorSkipped: true, skipReason: "MARKET_CLOSED", dataFreshness: "market-closed",
          reason: "XAU/USD is likely in its weekly or daily market-closure window; stale candles were treated as a skip, not a signal or system failure.",
          checkedAt: new Date().toISOString() };
        await recordHistory(sql, skipped);
        res.setHeader("Cache-Control", "no-store");
        return res.status(200).json(skipped);
      }
      console.warn("XAU/USD candle verification failed:", {
        strategyMode: settings.strategyMode,
        timeframe: settings.timeframe,
        timedOut,
        detail: message.slice(0, 200)
      });
      const unavailable = {
        status: "NO_TRADE", signal: null, marketDataVerified: false, dataFreshness: "unverified",
        error: "Unable to verify fresh, completed XAU/USD candles. No signal generated.",
        detail: message.slice(0, 200),
        checkedAt: new Date().toISOString()
      };
      await recordHistory(sql, unavailable);
      return res.status(timedOut ? 504 : 502).json(unavailable);
    } finally {
      if (monitorLockToken) {
        try { await releaseMonitorLock(sql, monitorLockToken); }
        catch (lockError) { console.error("Monitor lock release failed:", lockError?.message || "unknown error"); }
      }
      clearTimeout(timer);
    }
  } catch (error) {
    console.error("Analysis/storage failure:", error?.message || "unknown error");
    return res.status(503).json({ status: "NO_TRADE", signal: null, marketDataVerified: false, error: "Persistent storage is unavailable. No signal generated." });
  }
}
