function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let value = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) value = values[i] * k + value * (1 - k);
  return value;
}

function rsi(values, period = 14) {
  if (values.length <= period) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
  }
  if (avgGain === 0 && avgLoss === 0) return 50;
  if (avgLoss === 0) return 100;
  if (avgGain === 0) return 0;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const ranges = [];
  for (let i = 1; i < candles.length; i++) {
    const candle = candles[i], previous = candles[i - 1];
    ranges.push(Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previous.close),
      Math.abs(candle.low - previous.close)
    ));
  }
  return ranges.slice(-period).reduce((sum, value) => sum + value, 0) / period;
}

function valid(candle) {
  return candle &&
    [candle.open, candle.high, candle.low, candle.close].every(Number.isFinite) &&
    candle.high >= Math.max(candle.open, candle.close, candle.low) &&
    candle.low <= Math.min(candle.open, candle.close, candle.high);
}

function newestFirst(candles) {
  const timestamps = candles.map((candle) => candle.time ?? candle.datetime);
  if (timestamps.every((value) => value == null)) return true;
  if (timestamps.some((value) => typeof value !== "string" || !Number.isFinite(Date.parse(value)))) return false;
  const times = timestamps.map((value) => Date.parse(value));
  return times.every((value, index) => index === 0 || times[index - 1] > value);
}

function pivotLevels(candles, source, left = 2, right = 2) {
  const levels = [];
  // A pivot is only used after its right-side confirmation candles have closed.
  for (let i = left; i < candles.length - right; i++) {
    const current = candles[i];
    let isHigh = true, isLow = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (candles[j].high >= current.high) isHigh = false;
      if (candles[j].low <= current.low) isLow = false;
    }
    if (isHigh) levels.push({ price: current.high, type: "resistance", source, weight: source === "H1" ? 2 : 1 });
    if (isLow) levels.push({ price: current.low, type: "support", source, weight: source === "H1" ? 2 : 1 });
  }
  return levels;
}

function clusterLevels(levels, tolerance) {
  const zones = [];
  for (const level of levels.sort((a, b) => a.price - b.price)) {
    let zone = zones.find((candidate) => candidate.type === level.type && Math.abs(candidate.price - level.price) <= tolerance);
    if (!zone) {
      zone = { type: level.type, price: level.price, touches: 0, weight: 0, sources: new Set() };
      zones.push(zone);
    }
    zone.price = (zone.price * zone.touches + level.price) / (zone.touches + 1);
    zone.touches += 1;
    zone.weight += level.weight;
    zone.sources.add(level.source);
  }
  return zones.map((zone) => ({
    ...zone,
    sources: [...zone.sources],
    strength: Math.min(20, 8 + (zone.touches - 1) * 3 + (zone.sources.length > 1 ? 3 : 0) + (zone.weight >= 4 ? 2 : 0))
  }));
}

function noTrade(reason, indicators = null, zones = null) {
  return {
    status: "NO_TRADE",
    reason,
    ...(indicators ? { indicators } : {}),
    ...(zones ? { supportResistance: zones } : {}),
    signal: null
  };
}

export function analyzeGold(hourly, fifteen, settings = {}) {
  // Fail closed on malformed candles rather than silently discarding rows and
  // accidentally analyzing a discontinuous or misleading sample.
  if (!Array.isArray(hourly) || !Array.isArray(fifteen) ||
      !hourly.every(valid) || !fifteen.every(valid) ||
      !newestFirst(hourly) || !newestFirst(fifteen)) {
    return noTrade("Malformed or missing OHLC candle data; analysis rejected.");
  }

  // Twelve Data returns newest first; calculations use oldest-to-newest order.
  const h = hourly.slice().reverse();
  const m = fifteen.slice().reverse();
  if (h.length < 60 || m.length < 80) {
    return noTrade("Insufficient validated candle history.");
  }

  const hCloses = h.map((candle) => candle.close);
  const mCloses = m.map((candle) => candle.close);
  const hEma20 = ema(hCloses, 20);
  const hEma50 = ema(hCloses, 50);
  const mEma20 = ema(mCloses, 20);
  const momentum = rsi(mCloses, 14);
  const volatility = atr(m, 14);
  const last = m[m.length - 1];
  const previous = m[m.length - 2];

  if (![hEma20, hEma50, mEma20, momentum, volatility].every(Number.isFinite) || volatility <= 0) {
    return noTrade("Indicator calculation failed validation.");
  }

  const trendUp = hEma20 > hEma50;
  const trendDown = hEma20 < hEma50;
  const bullishCandle = last.close > last.open && last.close > previous.close;
  const bearishCandle = last.close < last.open && last.close < previous.close;
  const tolerance = Math.max(volatility * 0.3, last.close * 0.00015);

  // Use confirmed H1 and M15 swing points to form multiple support/resistance zones.
  // The last two candles are excluded from pivot confirmation to prevent look-ahead.
  const levels = [
    ...pivotLevels(h, "H1"),
    ...pivotLevels(m.slice(0, -1), "M15")
  ];
  const zones = clusterLevels(levels, tolerance);
  const supports = zones.filter((zone) => zone.type === "support");
  const resistances = zones.filter((zone) => zone.type === "resistance");

  const supportTouch = supports
    .filter((zone) => last.low <= zone.price + tolerance && last.close > zone.price && bullishCandle)
    .sort((a, b) => Math.abs(last.close - a.price) - Math.abs(last.close - b.price))[0];
  const resistanceTouch = resistances
    .filter((zone) => last.high >= zone.price - tolerance && last.close < zone.price && bearishCandle)
    .sort((a, b) => Math.abs(last.close - a.price) - Math.abs(last.close - b.price))[0];

  // A retest is accepted only when a previous completed candle broke the zone
  // and the latest completed candle retests it and closes back on the breakout side.
  const bullishRetest = resistances
    .filter((zone) => previous.close > zone.price && last.low <= zone.price + tolerance &&
      last.close > zone.price && bullishCandle)
    .sort((a, b) => Math.abs(last.close - a.price) - Math.abs(last.close - b.price))[0];
  const bearishRetest = supports
    .filter((zone) => previous.close < zone.price && last.high >= zone.price - tolerance &&
      last.close < zone.price && bearishCandle)
    .sort((a, b) => Math.abs(last.close - a.price) - Math.abs(last.close - b.price))[0];

  let side = null, setup = null, selectedZone = null;
  if (trendUp && (bullishRetest || supportTouch)) {
    side = "BUY";
    selectedZone = bullishRetest || supportTouch;
    setup = bullishRetest ? "MSNR breakout-and-retest" : "MSNR support rejection";
  } else if (trendDown && (bearishRetest || resistanceTouch)) {
    side = "SELL";
    selectedZone = bearishRetest || resistanceTouch;
    setup = bearishRetest ? "MSNR breakdown-and-retest" : "MSNR resistance rejection";
  }

  const indicators = {
    rsi: Number(momentum.toFixed(2)),
    atr: Number(volatility.toFixed(3)),
    h1Ema20: Number(hEma20.toFixed(3)),
    h1Ema50: Number(hEma50.toFixed(3)),
    m15Ema20: Number(mEma20.toFixed(3))
  };
  const displayedZones = zones
    .sort((a, b) => b.strength - a.strength)
    .slice(0, 12)
    .map((zone) => ({
      type: zone.type,
      price: Number(zone.price.toFixed(3)),
      touches: zone.touches,
      strength: zone.strength,
      sources: zone.sources
    }));

  if (!side || !selectedZone) {
    return noTrade(
      "No confirmed MSNR rejection or breakout-retest aligned with the H1 trend. Waiting is safer than forcing a trade.",
      indicators,
      displayedZones
    );
  }

  const momentumAligned = side === "BUY"
    ? momentum >= 50 && momentum <= 70
    : momentum >= 30 && momentum <= 50;
  if (!momentumAligned) {
    return noTrade("MSNR setup found, but M15 RSI momentum does not confirm the H1 direction.", indicators, displayedZones);
  }

  const m15Aligned = side === "BUY" ? last.close >= mEma20 : last.close <= mEma20;
  const trendReason = side === "BUY" ? "H1 EMA20 is above EMA50 (bullish trend)" : "H1 EMA20 is below EMA50 (bearish trend)";
  const momentumReason = side === "BUY" ? "M15 RSI confirms bullish momentum" : "M15 RSI confirms bearish momentum";
  const priceActionReason = side === "BUY"
    ? "Completed M15 candle confirms bullish rejection/retest at support-resistance"
    : "Completed M15 candle confirms bearish rejection/retest at support-resistance";

  const hVolatility = atr(h, 14);
  const trendSeparation = Number.isFinite(hVolatility) && hVolatility > 0
    ? Math.abs(hEma20 - hEma50) / hVolatility
    : 0;
  const trendStrengthScore = Math.max(0, Math.min(20, trendSeparation / 0.5 * 20));
  const zoneQualityScore = Math.max(0, Math.min(25, selectedZone.strength / 20 * 25));
  const candleRange = Math.max(last.high - last.low, Number.EPSILON);
  const candleBodyRatio = Math.abs(last.close - last.open) / candleRange;
  const closePosition = side === "BUY"
    ? (last.close - last.low) / candleRange
    : (last.high - last.close) / candleRange;
  const priceActionScore = Math.max(0, Math.min(20,
    (bullishRetest || bearishRetest ? 12 : 8) + candleBodyRatio * 4 + closePosition * 4));
  const momentumScore = momentumAligned ? 10 : 0;
  const m15AlignmentScore = m15Aligned ? 5 : 0;
  const reasons = [trendReason, `${setup} at ${selectedZone.type} zone ${selectedZone.price.toFixed(3)} (${selectedZone.touches} pivot touch(es))`, priceActionReason, momentumReason];
  if (m15Aligned) reasons.push("M15 close is aligned with EMA20");

  const sessionParts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Lagos", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date());
  const sessionHour = Number(sessionParts.find((part) => part.type === "hour")?.value);
  const sessionMinute = Number(sessionParts.find((part) => part.type === "minute")?.value);
  const sessionMinutes = sessionHour * 60 + sessionMinute;
  // Lagos-time approximation; daylight-saving shifts can move exact London/NY opens.
  const inLondonSession = sessionMinutes >= 8 * 60 && sessionMinutes < 17 * 60;
  const inNewYorkSession = sessionMinutes >= 14 * 60 && sessionMinutes < 23 * 60;
  const sessionScore = inLondonSession || inNewYorkSession ? 5 : 0;
  const sessionReason = inLondonSession && inNewYorkSession ? "London/New York overlap"
    : inLondonSession ? "London session"
    : inNewYorkSession ? "New York session"
    : "Outside preferred London/New York sessions";

  const scoreBreakdown = {
    h1TrendStrength: Math.round(trendStrengthScore),
    zoneQuality: Math.round(zoneQualityScore),
    msnrPriceAction: Math.round(priceActionScore),
    rsiMomentum: momentumScore,
    m15EmaAlignment: m15AlignmentScore,
    entryRiskQuality: 0,
    riskReward: 5,
    tradingSession: sessionScore
  };
  const minQuality = Number(settings.minQuality ?? 70);

  // Queue a pending breakout trigger beyond the setup candle, not at its
  // already-printed close. This keeps the planned entry ahead of current price.
  const referencePrice = last.close;
  if (!Number.isFinite(referencePrice) || referencePrice <= 0) {
    return noTrade("Reference price failed validation.", indicators, displayedZones);
  }
  const buffer = Math.max(volatility * 0.15, referencePrice * 0.00015);
  const entry = side === "BUY" ? last.high + buffer : last.low - buffer;
  if (!Number.isFinite(entry) || entry <= 0 ||
      (side === "BUY" ? entry <= last.close : entry >= last.close)) {
    return noTrade("Pending entry is not safely ahead of the current price.", indicators, displayedZones);
  }
  const sl = side === "BUY"
    ? Math.min(last.low, selectedZone.price - tolerance) - buffer
    : Math.max(last.high, selectedZone.price + tolerance) + buffer;
  const distance = Math.abs(entry - sl);
  if (!Number.isFinite(distance) || distance < volatility * 0.35 || distance > volatility * 2.5) {
    return noTrade("MSNR stop-loss distance is outside the configured volatility limits.", indicators, displayedZones);
  }
  const distanceInAtr = distance / volatility;
  scoreBreakdown.entryRiskQuality = Math.round(Math.max(0, 10 - Math.abs(distanceInAtr - 1) * 6));
  const rr = Number(settings.minRR ?? 2);
  if (!(rr >= 1.5 && rr <= 3)) return noTrade("Risk settings are invalid.", indicators, displayedZones);
  let target = side === "BUY" ? entry + distance * rr : entry - distance * rr;
  if (!Number.isFinite(sl) || !Number.isFinite(target) ||
      (side === "BUY" ? !(sl < entry && target > entry) : !(sl > entry && target < entry))) {
    return noTrade("Entry, stop-loss, and take-profit failed directional validation.", indicators, displayedZones);
  }
  const roundedEntry = Number(entry.toFixed(3));
  const roundedSl = Number(sl.toFixed(3));
  let roundedTarget = Number(target.toFixed(3));
  let actualRR = Math.abs(roundedTarget - roundedEntry) / Math.abs(roundedEntry - roundedSl);
  if (!Number.isFinite(actualRR) || actualRR + 1e-9 < rr) {
    roundedTarget = Number((roundedTarget + (side === "BUY" ? 0.001 : -0.001)).toFixed(3));
    actualRR = Math.abs(roundedTarget - roundedEntry) / Math.abs(roundedEntry - roundedSl);
  }
  if (!Number.isFinite(actualRR) || actualRR + 1e-9 < rr) {
    return noTrade("Rounded prices would fall below the configured minimum risk-to-reward ratio.", indicators, displayedZones);
  }
  target = roundedTarget;
  scoreBreakdown.riskReward = actualRR >= 2.5 ? 5 : actualRR >= 2 ? 4 : actualRR >= 1.5 ? 3 : 0;
  const quality = Object.values(scoreBreakdown).reduce((sum, value) => sum + value, 0);
  if (quality < minQuality) {
    const rejected = noTrade("MSNR setup did not meet the configured quality threshold after entry and risk validation.", indicators, displayedZones);
    rejected.quality = quality;
    rejected.scoreBreakdown = scoreBreakdown;
    rejected.scoreThreshold = minQuality;
    return rejected;
  }
  const nextOpposingZone = side === "BUY"
    ? resistances.filter((zone) => zone.price > entry + tolerance).sort((a, b) => a.price - b.price)[0]
    : supports.filter((zone) => zone.price < entry - tolerance).sort((a, b) => b.price - a.price)[0];

  if (nextOpposingZone) {
    const room = side === "BUY" ? nextOpposingZone.price - entry : entry - nextOpposingZone.price;
    if (room < distance * rr) {
      return noTrade("The next opposing MSNR zone leaves insufficient room for the configured risk-to-reward target.", indicators, displayedZones);
    }
  }

  const balance = Number(settings.balance ?? 1000);
  const riskPct = Number(settings.riskPercent ?? 0.5);
  if (!(balance > 0) || !(riskPct >= 0.1 && riskPct <= 1)) {
    return noTrade("Risk settings are invalid.", indicators, displayedZones);
  }
  const riskAmount = balance * riskPct / 100;

  return {
    status: "SIGNAL_CANDIDATE",
    quality,
    scoreBreakdown,
    scoreThreshold: minQuality,
    reason: "An MSNR setup aligned with the H1 trend passed the configured filters. This is a manual-review candidate, not a profitability guarantee.",
    indicators,
    supportResistance: displayedZones,
    signal: {
      symbol: "XAUUSD",
      side,
      entry: roundedEntry,
      stopLoss: roundedSl,
      takeProfit: Number(target.toFixed(3)),
      riskReward: Number(actualRR.toFixed(2)),
      riskPercent: riskPct,
      riskAmount: Number(riskAmount.toFixed(2)),
      accountCurrency: settings.currency || "USD",
      timeframe: "H1 trend + M15 MSNR setup",
      setup,
      tradingSession: sessionReason,
      supportResistanceZone: {
        type: selectedZone.type,
        price: Number(selectedZone.price.toFixed(3)),
        touches: selectedZone.touches,
        sources: selectedZone.sources
      },
      candleTime: last.time,
      explanation: reasons,
      lotSize: null,
      lotSizeNote: "Not calculated: broker contract size, tick value and account-currency conversion are not verified."
    }
  };
}
