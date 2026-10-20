function ema(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const k = 2 / (period + 1);
  let value = values.slice(0, period).reduce((sum, n) => sum + n, 0) / period;
  for (let i = period; i < values.length; i++) value = values[i] * k + value * (1 - k);
  return value;
}

function rsi(values, period = 14) {
  if (values.length <= period) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];
    gains += Math.max(0, change);
    losses += Math.max(0, -change);
  }
  let avgGain = gains / period, avgLoss = losses / period;
  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(0, change)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -change)) / period;
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
    const c = candles[i], p = candles[i - 1];
    ranges.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  return ranges.slice(-period).reduce((sum, n) => sum + n, 0) / period;
}

function valid(c) {
  return c && [c.open, c.high, c.low, c.close].every(Number.isFinite) &&
    c.high >= Math.max(c.open, c.close, c.low) && c.low <= Math.min(c.open, c.close, c.high);
}

function noTrade(reason, diagnostics = {}) {
  return { status: "NO_TRADE", signal: null, reason, strategyMode: "EMA_RIBBON_RSI", strategyDiagnostics: diagnostics };
}

export function analyzeEmaRibbonRsi(candlesNewestFirst, settings = {}, symbol = "XAUUSD") {
  if (!Array.isArray(candlesNewestFirst) || !candlesNewestFirst.every(valid)) {
    return noTrade("EMA Ribbon + RSI rejected malformed or missing OHLC candles.");
  }
  const timestamps = candlesNewestFirst.map(c => c.time ?? c.datetime);
  if (timestamps.some(t => typeof t !== "string" || !Number.isFinite(Date.parse(t))) ||
      timestamps.some((t, i) => i > 0 && Date.parse(timestamps[i - 1]) <= Date.parse(t))) {
    return noTrade("EMA Ribbon + RSI requires valid, strictly newest-first candle timestamps.");
  }
  const candles = candlesNewestFirst.slice().reverse();
  if (candles.length < 60) return noTrade("EMA Ribbon + RSI needs at least 60 completed candles to validate the EMA50 trend.");
  const closes = candles.map(c => c.close);
  const last = candles.at(-1), previous = candles.at(-2);
  const ema9 = ema(closes, 9), ema21 = ema(closes, 21), ema50 = ema(closes, 50);
  const previousEma9 = ema(closes.slice(0, -1), 9);
  const momentum = rsi(closes, 14), volatility = atr(candles, 14);
  if (![ema9, ema21, ema50, previousEma9, momentum, volatility].every(Number.isFinite) || volatility <= 0) {
    return noTrade("EMA Ribbon + RSI indicator calculation failed validation.");
  }
  const bullishStack = ema9 > ema21 && ema21 > ema50;
  const bearishStack = ema9 < ema21 && ema21 < ema50;
  const crossedUp = previous.close <= previousEma9 && last.close > ema9;
  const crossedDown = previous.close >= previousEma9 && last.close < ema9;
  const buy = bullishStack && crossedUp && momentum > 50;
  const sell = bearishStack && crossedDown && momentum < 50;
  const diagnostics = {
    timeframe: settings.timeframe === "M5" ? "M5" : "M15",
    ema9: Number(ema9.toFixed(5)), ema21: Number(ema21.toFixed(5)), ema50: Number(ema50.toFixed(5)),
    rsi14: Number(momentum.toFixed(2)), atr14: Number(volatility.toFixed(5)),
    bullishStack, bearishStack, crossedUp, crossedDown, rsiAbove50: momentum > 50, rsiBelow50: momentum < 50,
    candleTime: last.time ?? last.datetime
  };
  if (!buy && !sell) {
    const reason = !bullishStack && !bearishStack
      ? "No trade: EMA 9/21/50 ribbon is not perfectly aligned."
      : bullishStack && !buy
        ? (momentum <= 50 ? "No trade: bullish ribbon, but RSI(14) is not above 50." : "No trade: price did not cross and close above EMA9 on the latest completed candle.")
        : bearishStack && !sell
          ? (momentum >= 50 ? "No trade: bearish ribbon, but RSI(14) is not below 50." : "No trade: price did not cross and close below EMA9 on the latest completed candle.")
          : "No trade: the latest completed candle did not meet every entry condition.";
    return noTrade(reason, diagnostics);
  }
  const side = buy ? "BUY" : "SELL";
  const entry = last.close;
  const stopMultiple = 2;
  const targetMultiple = Number(settings.atrTargetMultiple) === 3 ? 3 : 4;
  const stopLoss = side === "BUY" ? entry - volatility * stopMultiple : entry + volatility * stopMultiple;
  const takeProfit = side === "BUY" ? entry + volatility * targetMultiple : entry - volatility * targetMultiple;
  const roundedEntry = Number(entry.toFixed(3));
  const roundedStop = Number(stopLoss.toFixed(3));
  const roundedTarget = Number(takeProfit.toFixed(3));
  const riskDistance = Math.abs(roundedEntry - roundedStop);
  const rewardDistance = Math.abs(roundedTarget - roundedEntry);
  const rr = rewardDistance / riskDistance;
  if (![roundedEntry, roundedStop, roundedTarget, rr].every(Number.isFinite) ||
      riskDistance <= 0 || (side === "BUY" ? roundedStop >= roundedEntry || roundedTarget <= roundedEntry : roundedStop <= roundedEntry || roundedTarget >= roundedEntry)) {
    return noTrade("Calculated EMA Ribbon + RSI risk levels failed validation.", diagnostics);
  }
  const balance = Number(settings.balance ?? 1000);
  const riskPercent = Number(settings.riskPercent ?? 0.5);
  if (!(balance > 0) || !(riskPercent >= 0.1 && riskPercent <= 1)) return noTrade("Risk settings are invalid.", diagnostics);
  const riskAmount = balance * riskPercent / 100;
  const timeframe = settings.timeframe === "M5" ? "M5" : "M15";
  return {
    status: "SIGNAL_CANDIDATE", strategyMode: "EMA_RIBBON_RSI", strategyVersion: "EMA_RIBBON_RSI_V1",
    quality: 100, reason: "EMA Ribbon + RSI conditions passed on the latest completed candle. Rule score is not a win probability.",
    strategyDiagnostics: diagnostics,
    indicators: { ema9: diagnostics.ema9, ema21: diagnostics.ema21, ema50: diagnostics.ema50, rsi14: diagnostics.rsi14, atr14: diagnostics.atr14 },
    signal: {
      symbol, side, entry: roundedEntry, stopLoss: roundedStop, takeProfit: roundedTarget,
      riskReward: Number(rr.toFixed(2)), riskPercent, riskAmount: Number(riskAmount.toFixed(2)),
      accountCurrency: settings.currency || "USD", timeframe, setup: side === "BUY" ? "EMA Ribbon bullish breakout + RSI trend filter" : "EMA Ribbon bearish breakout + RSI trend filter",
      strategyMode: "EMA_RIBBON_RSI", strategyVersion: "EMA_RIBBON_RSI_V1", candleTime: last.time ?? last.datetime,
      signalRef: `${symbol}|${timeframe}|${last.time ?? last.datetime}|${side}|${roundedEntry.toFixed(3)}`,
      explanation: [
        side === "BUY" ? "EMA9 > EMA21 > EMA50 bullish ribbon" : "EMA9 < EMA21 < EMA50 bearish ribbon",
        side === "BUY" ? "Completed candle crossed and closed above EMA9" : "Completed candle crossed and closed below EMA9",
        `RSI(14) = ${momentum.toFixed(2)}; required side of 50 confirmed`,
        `ATR(14) = ${volatility.toFixed(5)}; stop = 2×ATR and target = ${targetMultiple}×ATR`
      ],
      lotSize: null, lotSizeNote: "Not calculated: broker contract size, tick value and account-currency conversion are not verified."
    }
  };
}
