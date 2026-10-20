import { randomUUID } from "node:crypto";
import { analyzeGold } from "../lib/strategy.js";
import { hasOwnerSession } from "../lib/auth.js";
import { ensureStorage, getControlState, getStoredSettings, recordHistory, countSignalsToday, getActiveSignal, saveActiveSignal, claimMonitorLock, releaseMonitorLock, getRecordedOutcome } from "../lib/storage.js";
import { sendTelegramMessage, sendTelegramSignal } from "../lib/telegram.js";
import { evaluateSignalLifecycle } from "../lib/signal-lifecycle.js";
import { processRsiRejectionAlert } from "../lib/rsi-rejection-alerts.js";
import { getNewsStatus } from "../lib/news-filter.js";

const INTERVAL_MS = { "1h": 60 * 60 * 1000, "15min": 15 * 60 * 1000, "5min": 5 * 60 * 1000 };

function recordBTCHistory(sql, result) {
  const normalized = { ...result, symbol: "BTCUSD" };
  if (normalized.signal) normalized.signal = { ...normalized.signal, symbol: "BTCUSD" };
  return recordHistory(sql, normalized);
}

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
      let pausedSignal = await getActiveSignal(sql, "BTCUSD");
      if (pausedSignal && ["WAITING_FOR_ENTRY", "CONFIRMATION_PENDING_DELIVERY"].includes(pausedSignal.state)) {
        pausedSignal = {
          ...pausedSignal,
          state: pausedSignal.state === "CONFIRMATION_PENDING_DELIVERY" ? "CONFIRMATION_EXPIRED" : "CANCELLED_BY_PAUSE",
          pausedAt: new Date().toISOString(),
          confirmationExpiryReason: "The engine was paused before a safe confirmation alert could be delivered."
        };
        await saveActiveSignal(sql, pausedSignal, "BTCUSD");
      }
      if (pausedSignal && ["CANCELLED_BY_PAUSE", "CONFIRMATION_EXPIRED"].includes(pausedSignal.state) &&
          pausedSignal.candidateNotification?.sent === true && pausedSignal.lifecycleNotification?.sent !== true) {
        const confirmationExpired = pausedSignal.state === "CONFIRMATION_EXPIRED";
        const delivery = await sendTelegramMessage(confirmationExpired
          ? "⚠️ <b>EXPIRED — DO NOT ENTER (BTCUSD)</b>\nThe engine was paused before a safe confirmation alert could be delivered. Do not act on a delayed confirmation."
          : "⏸️ <b>BTCUSD PENDING SETUP CANCELLED</b>\nThe signal engine was paused. Do not place this pending order; cancel it if you already placed it manually.");
        pausedSignal = {
          ...pausedSignal,
          lifecycleNotification: delivery.sent
            ? { sent: true, sentAt: new Date().toISOString(), messageId: delivery.messageId ?? null }
            : { sent: false, lastAttemptAt: new Date().toISOString(), message: delivery.message || "Telegram delivery failed." }
        };
        await saveActiveSignal(sql, pausedSignal, "BTCUSD");
      }
      const blocked = {
        status: "NO_TRADE", signal: null, symbol: "BTCUSD", marketDataVerified: false,
        monitorSkipped: true, skipReason: control.emergencyStop ? "EMERGENCY_STOP" : "ENGINE_PAUSED",
        reason: control.emergencyStop ? "Emergency stop is active. Reset it explicitly before starting the engine." : "Signal engine is paused. Press START BOT before analysis.",
        checkedAt: new Date().toISOString()
      };
      await recordBTCHistory(sql, blocked);
      return res.status(200).json(blocked);
    }

    const key = process.env.TWELVEDATA_API_KEY;
    if (!key) {
      const unavailable = { status: "NO_TRADE", signal: null, marketDataVerified: false, error: "Market data is not configured. No signal generated." };
      await recordBTCHistory(sql, unavailable);
      return res.status(503).json(unavailable);
    }

    const body = req.body || {};
    const saved = await getStoredSettings(sql);
    let existingActiveSignal = await getActiveSignal(sql, "BTCUSD");
    // Resolve stale confirmed signals before session/disabled short-circuits, without inventing outcomes.
    if (existingActiveSignal?.state === "CONFIRMED_AND_NOTIFIED") {
      const signalRef = existingActiveSignal.result?.signal?.signalRef;
      const recordedOutcome = signalRef ? await getRecordedOutcome(sql, signalRef) : null;
      const notifiedMs = Date.parse(existingActiveSignal.notifiedAt || existingActiveSignal.confirmedAt || "");
      if (recordedOutcome) {
        existingActiveSignal = { ...existingActiveSignal, state: "CLOSED_WITH_OUTCOME", closedAt: recordedOutcome.recordedAt || new Date().toISOString(), recordedOutcome: recordedOutcome.outcome };
        await saveActiveSignal(sql, existingActiveSignal, "BTCUSD");
      } else if (Number.isFinite(notifiedMs) && Date.now() - notifiedMs > 24 * 60 * 60 * 1000) {
        existingActiveSignal = { ...existingActiveSignal, state: "CLOSED_WITHOUT_OUTCOME", closedAt: new Date().toISOString() };
        await saveActiveSignal(sql, existingActiveSignal, "BTCUSD");
      }
    }
    const activeNeedsMonitoring = Boolean(existingActiveSignal && (["WAITING_FOR_ENTRY", "CONFIRMATION_PENDING_DELIVERY", "CONFIRMED_AND_NOTIFIED"].includes(existingActiveSignal.state) || (["CONFIRMATION_EXPIRED", "CANCELLED_BY_PAUSE", "INVALIDATED", "EXPIRED"].includes(existingActiveSignal.state) && existingActiveSignal.candidateNotification?.sent === true && existingActiveSignal.lifecycleNotification?.sent !== true)));
    if ((saved.btcEnabled === false || body.btcEnabled === false) && !activeNeedsMonitoring) {
      const disabled = { status: "NO_TRADE", signal: null, marketDataVerified: false, symbol: "BTCUSD", monitorSkipped: true, skipReason: "BTC_DISABLED", reason: "BTCUSD is disabled in saved settings. Enable Bitcoin before analysis." };
      await recordBTCHistory(sql, disabled);
      return res.status(200).json(disabled);
    }
    const settings = {
      strategyMode: "MSNR_SMC",
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

    let signalCount = await countSignalsToday(sql);
    if (signalCount >= settings.maxSignals && !activeNeedsMonitoring) {
      const limited = { status: "NO_TRADE", signal: null, marketDataVerified: false, reason: `Daily signal limit reached (${signalCount}/${settings.maxSignals} Africa/Lagos time). No additional signal will be generated today.` };
      await recordBTCHistory(sql, limited);
      return res.status(200).json(limited);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    let monitorLockToken = null;
    try {
      async function candles(interval, size) {
        const u = new URL("https://api.twelvedata.com/time_series");
        u.searchParams.set("symbol", "BTC/USD");
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
      const [hourly, fifteen, five] = await Promise.all([
        candles("1h", 120),
        candles("15min", 250),
        existingActiveSignal?.state === "WAITING_FOR_ENTRY" ? candles("5min", 250) : Promise.resolve([])
      ]);
      let result = {
        ...analyzeGold(hourly, fifteen, settings),
        symbol: "BTCUSD",
        source: "Twelve Data",
        checkedAt: new Date().toISOString(),
        marketDataVerified: true,
        latestCompletedCandle: { h1: hourly[0].time, m15: fifteen[0].time, ...(five.length ? { m5: five[0].time } : {}) },
        dataFreshness: "verified"
      };
      if (result.signal) result.signal.symbol = "BTCUSD";
      if (result.status === "SIGNAL_CANDIDATE" && result.signal) {
        const newsStatus = await getNewsStatus({ now: new Date() });
        result.newsStatus = newsStatus;
        if (!newsStatus.ok || newsStatus.blocked) {
          result = { ...result, status: "NO_TRADE", signal: null,
            reason: newsStatus.reason || "Economic calendar could not be verified; new signals are blocked." };
        }
      }

      // A candle-based trigger can be crossed before the next scheduled scan.
      // Verify the provider's current quote before persisting any new pending entry.
      if (result.status === "SIGNAL_CANDIDATE" && result.signal) {
        const priceUrl = new URL("https://api.twelvedata.com/price");
        priceUrl.searchParams.set("symbol", "BTC/USD");
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
            reason: "Unable to verify the current BTC/USD quote. The pending entry was not queued."
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

      // Serialize state changes across BTCUSD and XAUUSD serverless monitor passes.
      monitorLockToken = randomUUID();
      const lockAcquired = await claimMonitorLock(sql, monitorLockToken);
      if (!lockAcquired) {
        monitorLockToken = null;
        const skipped = {
          status: "NO_TRADE", signal: null, symbol: "BTCUSD", marketDataVerified: true,
          monitorSkipped: true, skipReason: "MONITOR_ALREADY_RUNNING",
          reason: "Another market monitor owns the state lock; this BTCUSD pass was safely skipped.",
          checkedAt: new Date().toISOString()
        };
        await recordBTCHistory(sql, skipped);
        res.setHeader("Cache-Control", "no-store");
        return res.status(200).json(skipped);
      }

      result.rsiRejectionAlert = await processRsiRejectionAlert(sql, "BTCUSD", result);
      // Recount after acquiring the shared lock so concurrent Gold/BTC passes cannot exceed the shared daily cap.
      signalCount = await countSignalsToday(sql);
      // Send a pending-entry alert as soon as a fresh candidate is validated and its entry is still ahead.
      // Subsequent completed M5 candles monitor entry confirmation, invalidation, and expiry.
      let active = await getActiveSignal(sql, "BTCUSD");
      if (active?.state === "CONFIRMED_AND_NOTIFIED" && active.result?.signal?.signalRef) {
        const recordedOutcome = await getRecordedOutcome(sql, active.result.signal.signalRef);
        if (recordedOutcome) {
          active = { ...active, state: "CLOSED_WITH_OUTCOME", closedAt: recordedOutcome.recordedAt || new Date().toISOString(), recordedOutcome: recordedOutcome.outcome };
          await saveActiveSignal(sql, active, "BTCUSD");
        }
      }
      // Safety valve: a confirmed signal with no recorded outcome must not block new signals forever.
      if (active?.state === "CONFIRMED_AND_NOTIFIED") {
        const notifiedMs = Date.parse(active.notifiedAt || active.confirmedAt || "");
        if (Number.isFinite(notifiedMs) && Date.now() - notifiedMs > 24 * 60 * 60 * 1000) {
          active = { ...active, state: "CLOSED_WITHOUT_OUTCOME", closedAt: new Date().toISOString() };
          await saveActiveSignal(sql, active, "BTCUSD");
        }
      }
      if (active && active.state === "WAITING_FOR_ENTRY") {
        const lifecycle = evaluateSignalLifecycle(active, five);
        if (lifecycle.changed) {
          active = lifecycle.active;
          await saveActiveSignal(sql, active, "BTCUSD");
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

      // Persist and retry invalidation/expiry updates so a transient Telegram failure cannot silently strand a pending order.
      if (active && ["INVALIDATED", "EXPIRED", "CONFIRMATION_EXPIRED", "CANCELLED_BY_PAUSE"].includes(active.state) &&
          active.candidateNotification?.sent === true && active.lifecycleNotification?.sent !== true) {
        const invalidated = active.state === "INVALIDATED";
        const confirmationExpired = active.state === "CONFIRMATION_EXPIRED";
        const cancelled = active.state === "CANCELLED_BY_PAUSE";
        const update = await sendTelegramMessage(confirmationExpired
          ? "⚠️ <b>EXPIRED — DO NOT ENTER (BTCUSD)</b>\nThe confirmation alert is too old to act on safely."
          : cancelled
            ? "BTCUSD pending setup cancelled because the engine was paused."
            : invalidated
          ? "⚠️ <b>INVALIDATED — DO NOT ENTER (BTCUSD)</b>\nPrice touched the stop-loss or target before entry confirmation. Do not place this pending order; cancel it if you placed it manually."
          : "⌛ <b>EXPIRED — DO NOT ENTER (BTCUSD)</b>\nThe entry was not confirmed within eight hours. Do not place this expired pending order.");
        const attemptedAt = new Date().toISOString();
        active = {
          ...active,
          lifecycleNotification: update.sent
            ? { sent: true, sentAt: attemptedAt, messageId: update.messageId ?? null }
            : { sent: false, lastAttemptAt: attemptedAt, message: update.message || "Telegram delivery failed." }
        };
        await saveActiveSignal(sql, active, "BTCUSD");
        result.entryMonitoring = {
          state: active.state,
          updateNotified: update.sent,
          note: update.sent
            ? "The pending setup update was delivered to Telegram."
            : "Telegram delivery failed; the setup update will be retried on a later monitor pass.",
          ...(update.message ? { deliveryMessage: update.message } : {})
        };
      }

      if (active && active.state === "CONFIRMATION_PENDING_DELIVERY" && active.result?.signal) {
        const confirmedAtMs = Date.parse(active.confirmedAt || "");
        const confirmationAge = Date.now() - confirmedAtMs;
        if (!Number.isFinite(confirmedAtMs) || confirmationAge > 15 * 60 * 1000) {
          active = {
            ...active,
            state: "CONFIRMATION_EXPIRED",
            confirmationExpiredAt: new Date().toISOString(),
            confirmationExpiryReason: "Confirmation notification was not delivered within 15 minutes."
          };
          await saveActiveSignal(sql, active, "BTCUSD");
          result.entryMonitoring = {
            state: "CONFIRMATION_EXPIRED",
            note: "The confirmation alert is too old to deliver safely; no delayed entry confirmation was sent."
          };
        } else {
          // A confirmation is sent only after checking a current BTC/USD quote and its risk boundaries.
          const liveUrl = new URL("https://api.twelvedata.com/price");
          liveUrl.searchParams.set("symbol", "BTC/USD");
          liveUrl.searchParams.set("apikey", key);
          const liveResponse = await fetch(liveUrl.toString(), {
            headers: { Accept: "application/json" }, signal: controller.signal
          });
          const livePayload = await liveResponse.json().catch(() => null);
          const livePrice = Number(livePayload?.price);
          if (!liveResponse.ok || !livePayload || livePayload.status === "error" ||
              !Number.isFinite(livePrice) || livePrice <= 0) {
            active = {
              ...active,
              lastLivePriceCheckAt: new Date().toISOString(),
              lastLivePriceCheckFailed: true
            };
            await saveActiveSignal(sql, active, "BTCUSD");
            result.entryMonitoring = {
              state: "CONFIRMED_AWAITING_LIVE_PRICE",
              note: "Live BTC/USD quote could not be verified; confirmation delivery is deferred."
            };
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
              await saveActiveSignal(sql, active, "BTCUSD");
              result.entryMonitoring = {
                state: "CONFIRMATION_EXPIRED",
                note: "Price has reached the stop-loss/target boundary; no stale confirmation was sent."
              };
            } else {
              const confirmedResult = {
                ...active.result,
                signal: { ...active.result.signal, status: "CONFIRMED" },
                currentPrice: livePrice,
                confirmation: { status: "ENTRY_CONFIRMED", confirmedAt: active.confirmedAt, candleTime: active.confirmationCandleTime }
              };
              const newsStatus = await getNewsStatus({ now: new Date() });
              const delivery = (!newsStatus.ok || newsStatus.blocked)
                ? { sent: false, message: newsStatus.reason || "News filter blocked confirmation delivery." }
                : await sendTelegramSignal({ ...confirmedResult, newsStatus });
              result.entryMonitoring = {
                state: delivery.sent ? "CONFIRMED_AND_NOTIFIED" : "CONFIRMED_AWAITING_TELEGRAM",
                confirmationCandleTime: active.confirmationCandleTime,
                ...(delivery.message ? { deliveryMessage: delivery.message } : {})
              };
              if (delivery.sent) {
                active = { ...active, state: "CONFIRMED_AND_NOTIFIED", telegramMessageId: delivery.messageId ?? null, notifiedAt: new Date().toISOString(), lastLivePrice: livePrice, lastLivePriceCheckFailed: false };
              } else {
                active = { ...active, lastNotificationAttemptAt: new Date().toISOString(), lastNotificationError: delivery.message || "Telegram delivery failed.", lastLivePrice: livePrice, lastLivePriceCheckFailed: false };
              }
              await saveActiveSignal(sql, active, "BTCUSD");
            }
          }
        }
      }

      const activeCanBeReplaced = !active ||
        active.state === "CLOSED_WITH_OUTCOME" ||
        active.state === "CLOSED_WITHOUT_OUTCOME" ||
        (["INVALIDATED", "EXPIRED", "CONFIRMATION_EXPIRED", "CANCELLED_BY_PAUSE"].includes(active.state) &&
          (active.candidateNotification?.sent !== true || active.lifecycleNotification?.sent === true));

      if (result.status === "SIGNAL_CANDIDATE" && result.signal) {
        if (!isWithinSession(settings)) {
          result.status = "NO_TRADE";
          result.signal = null;
          result.reason = "Outside the configured Africa/Lagos monitoring session. Existing BTCUSD setups will still be monitored, but no new setup was queued.";
          result.entryMonitoring = { state: "OUTSIDE_SESSION" };
        } else if (signalCount >= settings.maxSignals && activeCanBeReplaced) {
          result.status = "NO_TRADE";
          result.signal = null;
          result.reason = `Daily signal limit reached (${signalCount}/${settings.maxSignals} Africa/Lagos time). No additional candidate was queued.`;
          result.entryMonitoring = { state: "DAILY_LIMIT_REACHED" };
        } else if (activeCanBeReplaced) {
          active = {
            state: "WAITING_FOR_ENTRY",
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
            result,
            candidateNotification: { sent: false, suppressed: true }
          };
          await saveActiveSignal(sql, active, "BTCUSD");
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

      await recordBTCHistory(sql, result);
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json(result);
    } catch (error) {
      const timedOut = error?.name === "AbortError";
      const unavailable = {
        status: "NO_TRADE", signal: null, symbol: "BTCUSD", marketDataVerified: false, dataFreshness: "unverified",
        error: "Unable to verify fresh, completed BTC/USD candles. No signal generated.",
        detail: String(error?.message || "provider error").slice(0, 200),
        checkedAt: new Date().toISOString()
      };
      await recordBTCHistory(sql, unavailable);
      return res.status(timedOut ? 504 : 502).json(unavailable);
    } finally {
      if (monitorLockToken) {
        try { await releaseMonitorLock(sql, monitorLockToken); }
        catch (lockError) { console.error("BTC monitor lock release failed:", lockError?.message || "unknown error"); }
      }
      clearTimeout(timer);
    }
  } catch (error) {
    console.error("Analysis/storage failure:", error?.message || "unknown error");
    return res.status(503).json({ status: "NO_TRADE", signal: null, symbol: "BTCUSD", marketDataVerified: false, error: "Persistent storage is unavailable. No signal generated." });
  }
}
