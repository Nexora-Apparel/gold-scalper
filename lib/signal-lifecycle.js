function timeMs(value) {
  if (typeof value !== "string") return NaN;
  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  return Date.parse(normalized.endsWith("Z") ? normalized : normalized + "Z");
}

export function evaluateSignalLifecycle(active, candles, now = Date.now()) {
  if (!active || active.state !== "WAITING_FOR_ENTRY" || !active.result?.signal) {
    return { active, changed: false, event: null };
  }

  const expiry = Date.parse(active.expiresAt || "");
  if (Number.isFinite(expiry) && now >= expiry) {
    return {
      active: { ...active, state: "EXPIRED", expiredAt: new Date(now).toISOString() },
      changed: true,
      event: { type: "EXPIRED" }
    };
  }

  const signal = active.result.signal;
  const setupTime = timeMs(signal.candleTime);
  const entry = Number(signal.entry);
  const stop = Number(signal.stopLoss);
  const target = Number(signal.takeProfit);
  const validDirection = signal.side === "BUY"
    ? stop < entry && target > entry
    : signal.side === "SELL" && stop > entry && target < entry;
  if (!Number.isFinite(setupTime) || ![entry, stop, target].every(Number.isFinite) ||
      !validDirection || !Array.isArray(candles)) {
    return { active, changed: false, event: null };
  }

  const laterCandles = candles
    .filter((candle) => timeMs(candle.time ?? candle.datetime) > setupTime)
    .slice()
    .sort((left, right) => timeMs(left.time ?? left.datetime) - timeMs(right.time ?? right.datetime));

  for (const candle of laterCandles) {
    const low = Number(candle.low), high = Number(candle.high);
    const open = Number(candle.open), close = Number(candle.close);
    if (![low, high, open, close].every(Number.isFinite) ||
        high < Math.max(open, close, low) || low > Math.min(open, close, high)) continue;

    const boundaryTouched = signal.side === "BUY"
      ? low <= stop || high >= target
      : high >= stop || low <= target;
    if (boundaryTouched) {
      return {
        active: { ...active, state: "INVALIDATED", invalidatedAt: new Date(now).toISOString(), invalidationCandleTime: candle.time ?? candle.datetime },
        changed: true,
        event: { type: "INVALIDATED", candleTime: candle.time ?? candle.datetime }
      };
    }

    const entryTouched = low <= entry && high >= entry;
    const directionalClose = signal.side === "BUY"
      ? entryTouched && close > entry && close > open
      : entryTouched && close < entry && close < open;
    if (directionalClose) {
      return {
        active: { ...active, state: "CONFIRMATION_PENDING_DELIVERY", confirmedAt: new Date(now).toISOString(), confirmationCandleTime: candle.time ?? candle.datetime },
        changed: true,
        event: { type: "CONFIRMED", candleTime: candle.time ?? candle.datetime }
      };
    }
  }

  return { active, changed: false, event: null };
}
