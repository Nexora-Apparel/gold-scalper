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

function smcContext(candles, side, tolerance) {
  // Deterministic SMC rules use completed M15 candles only.
  const recent = candles.slice(-30);
  if (recent.length < 10) return { aligned: false, evidence: [], structure: null };
  const prior = recent.slice(0, -1);
  const swingHighs = [], swingLows = [];
  for (let i = 2; i < prior.length - 2; i++) {
    const c = prior[i];
    if (prior.slice(i - 2, i + 3).every((x, j) => j === 2 || c.high > x.high)) swingHighs.push({ price: c.high, index: i });
    if (prior.slice(i - 2, i + 3).every((x, j) => j === 2 || c.low < x.low)) swingLows.push({ price: c.low, index: i });
  }
  const last = recent[recent.length - 1], previous = recent[recent.length - 2];
  const latestHigh = swingHighs.at(-1)?.price, priorHigh = swingHighs.at(-2)?.price;
  const latestLow = swingLows.at(-1)?.price, priorLow = swingLows.at(-2)?.price;
  const bullishBos = Number.isFinite(latestHigh) && previous.close <= latestHigh && last.close > latestHigh;
  const bearishBos = Number.isFinite(latestLow) && previous.close >= latestLow && last.close < latestLow;
  const priorBearishStructure = Number.isFinite(priorHigh) && Number.isFinite(latestHigh) &&
    Number.isFinite(priorLow) && Number.isFinite(latestLow) && latestHigh < priorHigh && latestLow < priorLow;
  const priorBullishStructure = Number.isFinite(priorHigh) && Number.isFinite(latestHigh) &&
    Number.isFinite(priorLow) && Number.isFinite(latestLow) && latestHigh > priorHigh && latestLow > priorLow;
  const bullishChoch = priorBearishStructure && bullishBos;
  const bearishChoch = priorBullishStructure && bearishBos;
  const bullishSweep = Number.isFinite(latestLow) && last.low < latestLow - tolerance && last.close > latestLow;
  const bearishSweep = Number.isFinite(latestHigh) && last.high > latestHigh + tolerance && last.close < latestHigh;

  // Three-candle FVGs are identified on earlier completed candles, then checked for a later revisit.
  const fvgCandidates = [];
  for (let i = Math.max(2, recent.length - 10); i < recent.length - 1; i++) {
    const left = recent[i - 2], right = recent[i];
    if (right.low > left.high + tolerance * 0.1) fvgCandidates.push({ side: "BUY", low: left.high, high: right.low, index: i });
    if (right.high < left.low - tolerance * 0.1) fvgCandidates.push({ side: "SELL", low: right.high, high: left.low, index: i });
  }
  const matchingFvg = fvgCandidates.filter(gap => gap.side === side && gap.index >= recent.length - 9)
    .find(gap => last.low <= gap.high && last.high >= gap.low);
  const bullishFvgRetest = side === "BUY" && Boolean(matchingFvg);
  const bearishFvgRetest = side === "SELL" && Boolean(matchingFvg);
  const bullishOrderBlock = (bullishBos || bullishChoch) &&
    recent.slice(Math.max(0, recent.length - 8), -1).some(c => c.close < c.open && last.close > c.high);
  const bearishOrderBlock = (bearishBos || bearishChoch) &&
    recent.slice(Math.max(0, recent.length - 8), -1).some(c => c.close > c.open && last.close < c.low);
  const structureBreak = side === "BUY" ? (bullishBos || bullishChoch) : (bearishBos || bearishChoch);
  const liquiditySweep = side === "BUY" ? bullishSweep : bearishSweep;
  const fvgRetest = side === "BUY" ? bullishFvgRetest : bearishFvgRetest;
  const evidence = [];
  if (side === "BUY") {
    if (bullishBos) evidence.push("SMC bullish break of structure (BOS)");
    if (bullishChoch) evidence.push("SMC bullish change of character (CHoCH)");
    if (bullishSweep) evidence.push("SMC sell-side liquidity sweep and reclaim");
    if (bullishFvgRetest) evidence.push("SMC bullish three-candle FVG zone retest");
    if (bullishOrderBlock) evidence.push("SMC bullish displacement through an opposing candle (order-block proxy)");
  } else {
    if (bearishBos) evidence.push("SMC bearish break of structure (BOS)");
    if (bearishChoch) evidence.push("SMC bearish change of character (CHoCH)");
    if (bearishSweep) evidence.push("SMC buy-side liquidity sweep and rejection");
    if (bearishFvgRetest) evidence.push("SMC bearish three-candle FVG zone retest");
    if (bearishOrderBlock) evidence.push("SMC bearish displacement through an opposing candle (order-block proxy)");
  }
  return {
    aligned: Boolean(structureBreak && liquiditySweep && fvgRetest),
    evidence,
    structure: {
      latestSwingHigh: Number.isFinite(latestHigh) ? Number(latestHigh.toFixed(3)) : null,
      latestSwingLow: Number.isFinite(latestLow) ? Number(latestLow.toFixed(3)) : null,
      bullishBos, bearishBos, bullishChoch, bearishChoch,
      bullishLiquiditySweep: bullishSweep, bearishLiquiditySweep: bearishSweep,
      bullishFvgRetest, bearishFvgRetest,
      fvg: matchingFvg ? { side: matchingFvg.side, low: Number(matchingFvg.low.toFixed(3)), high: Number(matchingFvg.high.toFixed(3)) } : null,
      bullishOrderBlockProxy: bullishOrderBlock, bearishOrderBlockProxy: bearishOrderBlock
    }
  };
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

  // Fixed strategy: MSNR + SMC is mandatory; dashboard/client input cannot switch it.
  const strategyMode = "MSNR_SMC";
  let side = null, setup = null, selectedZone = null, smc = null;
  if (trendUp && (bullishRetest || supportTouch)) {
    side = "BUY";
    selectedZone = bullishRetest || supportTouch;
    setup = bullishRetest ? "MSNR breakout-and-retest" : "MSNR support rejection";
  } else if (trendDown && (bearishRetest || resistanceTouch)) {
    side = "SELL";
    selectedZone = bearishRetest || resistanceTouch;
    setup = bearishRetest ? "MSNR breakdown-and-retest" : "MSNR resistance rejection";
  }

  const bullishSMC = smcContext(m, "BUY", tolerance);
  const bearishSMC = smcContext(m, "SELL", tolerance);
  if (strategyMode === "SMC") {
    if (trendUp && bullishSMC.aligned) {
      side = "BUY";
      selectedZone = supports.slice().sort((a, b) => Math.abs(last.close - a.price) - Math.abs(last.close - b.price))[0];
      setup = bullishSMC.evidence[0] || "SMC bullish structure setup";
      smc = bullishSMC;
    } else if (trendDown && bearishSMC.aligned) {
      side = "SELL";
      selectedZone = resistances.slice().sort((a, b) => Math.abs(last.close - a.price) - Math.abs(last.close - b.price))[0];
      setup = bearishSMC.evidence[0] || "SMC bearish structure setup";
      smc = bearishSMC;
    } else {
      side = null;
      selectedZone = null;
    }
  } else if (strategyMode === "MSNR_SMC") {
    smc = side === "BUY" ? bullishSMC : side === "SELL" ? bearishSMC : null;
    const zoneLiquiditySweep = side === "BUY"
      ? Boolean(selectedZone && last.low < selectedZone.price - tolerance && last.close > selectedZone.price)
      : side === "SELL"
        ? Boolean(selectedZone && last.high > selectedZone.price + tolerance && last.close < selectedZone.price)
        : false;
    if (!side || !smc?.aligned || !zoneLiquiditySweep) {
      return noTrade(
        side
          ? "MSNR setup found, but the mandatory combined model requires a sweep at the MSNR zone, aligned M15 CHoCH/BOS, and a retested FVG."
          : "No MSNR setup aligned with H1 trend. The mandatory model requires an MSNR zone, zone sweep, structure confirmation, and FVG retest.",
        { rsi: Number(momentum.toFixed(2)), atr: Number(volatility.toFixed(3)), h1Ema20: Number(hEma20.toFixed(3)), h1Ema50: Number(hEma50.toFixed(3)), m15Ema20: Number(mEma20.toFixed(3)) },
        zones.slice().sort((a, b) => b.strength - a.strength).slice(0, 12).map((zone) => ({ type: zone.type, price: Number(zone.price.toFixed(3)), touches: zone.touches, strength: zone.strength, sources: zone.sources }))
      );
    }
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
      strategyMode === "SMC"
        ? "No confirmed SMC BOS/liquidity-sweep setup aligned with the H1 trend."
        : strategyMode === "MSNR_SMC"
          ? "No confirmed setup satisfies both MSNR structure and aligned SMC confirmation."
          : "No confirmed MSNR rejection or breakout-retest aligned with the H1 trend. Waiting is safer than forcing a trade.",
      indicators,
      displayedZones
    );
  }

  const momentumAligned = side === "BUY"
    ? momentum >= 50 && momentum <= 70
    : momentum >= 30 && momentum <= 50;
  if (!momentumAligned) {
    return {
      ...noTrade(
        strategyMode === "SMC"
          ? "SMC setup found, but M15 RSI momentum does not confirm the H1 direction."
          : "Setup found, but M15 RSI momentum does not confirm the H1 direction.",
        indicators,
        displayedZones
      ),
      potentialSetup: {
        side,
        setup,
        h1Direction: side,
        h1Trend: side === "BUY" ? "Bullish" : "Bearish",
        zone: {
          type: selectedZone.type,
          price: Number(selectedZone.price.toFixed(3)),
          touches: selectedZone.touches,
          sources: selectedZone.sources
        },
        rsi: indicators.rsi,
        candleTime: last.time
      }
    };
  }

  const rejectAfterRsi = (code, reason, extra = {}) => ({
    ...noTrade(reason, indicators, displayedZones),
    rejectedSetup: {
      side,
      setup,
      rejectedBy: code,
      zone: {
        type: selectedZone.type,
        price: Number(selectedZone.price.toFixed(3)),
        touches: selectedZone.touches,
        sources: selectedZone.sources
      },
      rsi: indicators.rsi,
      candleTime: last.time,
      ...extra
    }
  });

  const m15Aligned = side === "BUY" ? last.close >= mEma20 : last.close <= mEma20;
  const trendReason = side === "BUY" ? "H1 EMA20 is above EMA50 (bullish trend)" : "H1 EMA20 is below EMA50 (bearish trend)";
  const momentumReason = side === "BUY" ? "M15 RSI confirms bullish momentum" : "M15 RSI confirms bearish momentum";
  const priceActionReason = side === "BUY"
    ? "Completed M15 candle confirms bullish rejection/retest at support-resistance"
    : "Completed M15 candle confirms bearish rejection/retest at support-resistance";

  smc = smc || (side === "BUY" ? bullishSMC : bearishSMC);
  let score = 30 + selectedZone.strength + 25 + 15;
  const reasons = [trendReason, `${setup} at ${selectedZone.type} zone ${selectedZone.price.toFixed(3)} (${selectedZone.touches} pivot touch(es))`, priceActionReason, momentumReason];
  if (strategyMode !== "MSNR" && smc.aligned) {
    score += 5;
    reasons.push(...smc.evidence);
  } else if (strategyMode === "MSNR") {
    reasons.push("Strategy mode: MSNR only; SMC confirmation is not required");
  } else {
    reasons.push("Mandatory SMC confirmation requires a zone sweep, aligned CHoCH/BOS, and a retested FVG");
  }
  if (m15Aligned) {
    score += 5;
    reasons.push("M15 close is aligned with EMA20");
  }
  const quality = Math.min(95, score);
  const minQuality = Number(settings.minQuality ?? 70);
  if (quality < minQuality) {
    return rejectAfterRsi("QUALITY", "MSNR setup did not meet the configured quality threshold.", { quality });
  }

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
    return rejectAfterRsi("ENTRY_NOT_AHEAD", "Pending entry is not safely ahead of the current price.", { entry: Number(entry.toFixed(3)) });
  }
  const sl = side === "BUY"
    ? Math.min(last.low, selectedZone.price - tolerance) - buffer
    : Math.max(last.high, selectedZone.price + tolerance) + buffer;
  const distance = Math.abs(entry - sl);
  if (!Number.isFinite(distance) || distance < volatility * 0.35 || distance > volatility * 2.5) {
    return rejectAfterRsi("STOP_DISTANCE", "MSNR stop-loss distance is outside the configured volatility limits.", {
      entry: Number(entry.toFixed(3)),
      stopLoss: Number(sl.toFixed(3)),
      stopDistanceInAtr: Number((distance / volatility).toFixed(2))
    });
  }

  // Use market structure to set the target without enforcing a minimum or maximum
  // reward-to-risk ratio. If no opposing zone is identifiable, use a 2R fallback
  // target; this is a fallback calculation, not a signal acceptance threshold.
  const opposingZones = side === "BUY"
    ? resistances.filter((zone) => zone.price > entry + tolerance).sort((a, b) => a.price - b.price)
    : supports.filter((zone) => zone.price < entry - tolerance).sort((a, b) => b.price - a.price);
  const nearestOpposingZone = opposingZones[0] || null;
  const nearestRR = nearestOpposingZone ? Math.abs(nearestOpposingZone.price - entry) / distance : null;
  // If the nearest opposing structure is very close (<1R), prefer the next
  // confirmed structure only when it is beyond 1R. This is target selection,
  // not a trade rejection or a hard RR threshold.
  const fartherStructure = nearestRR !== null && nearestRR < 1
    ? opposingZones.find((zone) => Math.abs(zone.price - entry) / distance >= 1)
    : null;
  const nextOpposingZone = fartherStructure || nearestOpposingZone;
  const fallbackTarget = side === "BUY" ? entry + distance * 2 : entry - distance * 2;
  const target = nextOpposingZone ? nextOpposingZone.price : fallbackTarget;
  reasons.push(nextOpposingZone
    ? (fartherStructure
      ? "Nearest opposing MSNR zone was too close for a useful target; selected the next confirmed opposing structure. RR is reported, not used as a signal gate"
      : "Take-profit uses the nearest opposing MSNR zone; RR is reported without a fixed acceptance threshold")
    : "No opposing MSNR zone was identified; take-profit uses a 2R fallback, with no RR acceptance filter");
  if (!Number.isFinite(sl) || !Number.isFinite(target) ||
      (side === "BUY" ? !(sl < entry && target > entry) : !(sl > entry && target < entry))) {
    return noTrade("Entry, stop-loss, and take-profit failed directional validation.", indicators, displayedZones);
  }

  // Enforce minimum reward-to-risk against the actual prices that will be stored.
  const roundedEntry = Number(entry.toFixed(3));
  const roundedStop = Number(sl.toFixed(3));
  const roundedTarget = Number(target.toFixed(3));
  const actualRR = Math.abs(roundedTarget - roundedEntry) / Math.abs(roundedEntry - roundedStop);
  const minimumRR = Number(settings.minRR ?? 2);
  if (!Number.isFinite(actualRR) || !Number.isFinite(minimumRR) || actualRR + 1e-9 < minimumRR) {
    return noTrade(`Actual rounded-price RR (${Number.isFinite(actualRR) ? actualRR.toFixed(2) : "invalid"}R) is below the configured minimum (${minimumRR}R).`, indicators, displayedZones);
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
    reason: `The ${strategyMode === "MSNR" ? "MSNR" : strategyMode === "SMC" ? "SMC" : "MSNR + SMC"} strategy passed its configured filters. This is a manual-review candidate, not a profitability guarantee.`,
    indicators,
    supportResistance: displayedZones,
    signal: {
      symbol: "XAUUSD",
      side,
      entry: Number(entry.toFixed(3)),
      stopLoss: Number(sl.toFixed(3)),
      takeProfit: Number(target.toFixed(3)),
      riskReward: Number((Math.abs(target - entry) / distance).toFixed(2)),
      riskPercent: riskPct,
      riskAmount: Number(riskAmount.toFixed(2)),
      accountCurrency: settings.currency || "USD",
      timeframe: strategyMode === "SMC" ? "H1 trend + M15 SMC" : strategyMode === "MSNR_SMC" ? "H1 trend + M15 MSNR + SMC" : "H1 trend + M15 MSNR",
      setup,
      strategyMode,
      strategyVersion: "msnr-smc-v2",
      smc: {
        aligned: smc.aligned,
        evidence: smc.evidence,
        structure: smc.structure
      },
      supportResistanceZone: {
        type: selectedZone.type,
        price: Number(selectedZone.price.toFixed(3)),
        touches: selectedZone.touches,
        sources: selectedZone.sources
      },
      candleTime: last.time,
      signalRef: `${last.time}|${side}|${entry.toFixed(3)}`,
      explanation: reasons,
      lotSize: null,
      lotSizeNote: "Not calculated: broker contract size, tick value and account-currency conversion are not verified."
    }
  };
}
