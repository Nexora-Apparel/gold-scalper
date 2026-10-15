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
    const d = values[i] - values[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}
function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const ranges = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], prev = candles[i - 1];
    ranges.push(Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close)));
  }
  return ranges.slice(-period).reduce((a, b) => a + b, 0) / period;
}
function valid(c) {
  return c && Number.isFinite(c.open) && Number.isFinite(c.high) && Number.isFinite(c.low) && Number.isFinite(c.close) && c.high >= Math.max(c.open,c.close,c.low) && c.low <= Math.min(c.open,c.close,c.high);
}
export function analyzeGold(hourly, fifteen, settings = {}) {
  const h = hourly.filter(valid).slice().reverse();
  const m = fifteen.filter(valid).slice().reverse();
  if (h.length < 60 || m.length < 80) return {status:"NO_TRADE",reason:"Insufficient validated candle history.",signal:null};
  const hc = h.map(c=>c.close), mc=m.map(c=>c.close);
  const hEma20=ema(hc,20), hEma50=ema(hc,50), mEma20=ema(mc,20), mEma50=ema(mc,50);
  const momentum=rsi(mc,14), volatility=atr(m,14);
  const last=m[m.length-1], previous=m[m.length-2];
  const recent=m.slice(-21,-1);
  const swingHigh=Math.max(...recent.map(c=>c.high)), swingLow=Math.min(...recent.map(c=>c.low));
  if (![hEma20,hEma50,mEma20,mEma50,momentum,volatility].every(Number.isFinite) || volatility <= 0) return {status:"NO_TRADE",reason:"Indicator calculation failed validation.",signal:null};
  const trendUp=hEma20>hEma50 && mEma20>mEma50;
  const trendDown=hEma20<hEma50 && mEma20<mEma50;
  const bullishBreak=last.close>swingHigh && previous.close<=swingHigh;
  const bearishBreak=last.close<swingLow && previous.close>=swingLow;
  let side=null, score=0, reasons=[];
  if (trendUp) {score+=35;reasons.push("H1 and M15 EMA trend alignment is bullish");}
  if (trendDown) {score+=35;reasons.push("H1 and M15 EMA trend alignment is bearish");}
  if (trendUp && momentum>=52 && momentum<=68) {score+=20;reasons.push("RSI supports bullish momentum without an extreme reading");}
  if (trendDown && momentum>=32 && momentum<=48) {score+=20;reasons.push("RSI supports bearish momentum without an extreme reading");}
  if (bullishBreak) {score+=30;reasons.push("M15 candle closed above the recent 20-candle swing high");side="BUY";}
  if (bearishBreak) {score+=30;reasons.push("M15 candle closed below the recent 20-candle swing low");side="SELL";}
  if (side==="BUY" && !trendUp) side=null;
  if (side==="SELL" && !trendDown) side=null;
  const minQuality=Number(settings.minQuality ?? 70);
  if (!side) return {status:"NO_TRADE",reason:"No aligned trend-and-breakout setup. Waiting is safer than forcing a trade.",indicators:{rsi:Number(momentum.toFixed(2)),atr:Number(volatility.toFixed(3)),h1Ema20:Number(hEma20.toFixed(3)),h1Ema50:Number(hEma50.toFixed(3)),m15Ema20:Number(mEma20.toFixed(3)),m15Ema50:Number(mEma50.toFixed(3))},signal:null};
  const entry=last.close;
  const buffer=Math.max(volatility*0.15, entry*0.00015);
  let sl=side==="BUY" ? Math.min(last.low, swingHigh-volatility*0.25)-buffer : Math.max(last.high, swingLow+volatility*0.25)+buffer;
  const distance=Math.abs(entry-sl);
  if (!Number.isFinite(distance) || distance < volatility*0.35 || distance > volatility*2.5) return {status:"NO_TRADE",reason:"Stop-loss distance is outside the strategy's volatility limits.",signal:null};
  const rr=Number(settings.minRR ?? 2);
  const tp1=side==="BUY" ? entry+distance*rr : entry-distance*rr;
  const balance=Number(settings.balance ?? 1000), riskPct=Number(settings.riskPercent ?? 0.5);
  if (!(balance>0) || !(riskPct>0 && riskPct<=1) || !(rr>=1.5 && rr<=3)) return {status:"NO_TRADE",reason:"Risk settings are invalid.",signal:null};
  const riskAmount=balance*riskPct/100;
  // Lot sizing deliberately omitted until broker contract size, tick value and currency conversion are verified.
  const quality=Math.min(95,score);
  if (quality<minQuality) return {status:"NO_TRADE",reason:"Setup did not meet the configured quality threshold.",quality,signal:null};
  return {status:"SIGNAL_CANDIDATE",quality,reason:"A rules-based candidate passed the current filters; this is not a guarantee of profitability.",indicators:{rsi:Number(momentum.toFixed(2)),atr:Number(volatility.toFixed(3)),h1Ema20:Number(hEma20.toFixed(3)),h1Ema50:Number(hEma50.toFixed(3)),m15Ema20:Number(mEma20.toFixed(3)),m15Ema50:Number(mEma50.toFixed(3))},signal:{symbol:"XAUUSD",side,entry:Number(entry.toFixed(3)),stopLoss:Number(sl.toFixed(3)),takeProfit:Number(tp1.toFixed(3)),riskReward:rr,riskPercent:riskPct,riskAmount:Number(riskAmount.toFixed(2)),accountCurrency:settings.currency||"USD",timeframe:"H1 trend + M15 setup",candleTime:last.time,explanation:reasons,lotSize:null,lotSizeNote:"Not calculated: broker contract size, tick value and account-currency conversion are not verified."}};
}
