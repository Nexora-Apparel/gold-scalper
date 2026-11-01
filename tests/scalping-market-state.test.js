import test from "node:test";
import assert from "node:assert/strict";
import { evaluateScalpingMarketState } from "../lib/scalping-market-state.js";

const now = Date.parse("2026-11-01T10:00:00.000Z");
const quote = {
  symbol:"XAUUSD", timestamp:new Date(now).toISOString(),
  bid:2650, ask:2650.2, mid:2650.1, spread:0.2,
  marketState:"open", stale:false
};
const windows = {
  shortWindow:{ready:true,sampleCount:8,ticksPerSecond:1.4,priceChangePercent:0.012,averageSpread:0.18},
  contextWindow:{ready:true,sampleCount:20,ticksPerSecond:0.8,priceChangePercent:0.008,averageSpread:0.2}
};

test("allows downstream analysis only when quote and both microstructure windows are healthy",()=>{
  const state=evaluateScalpingMarketState({quote,...windows,now,exnessQuoteVerified:true});
  assert.equal(state.ready,true);
  assert.equal(state.momentumDirection,"UP");
  assert.equal(state.volatilityRegime,"NORMAL");
  assert.equal(state.signalGenerationEnabled,false);
});

test("fails closed on stale quotes and closed market snapshots",()=>{
  const stale=evaluateScalpingMarketState({quote:{...quote,timestamp:new Date(now-2000).toISOString()},...windows,now,exnessQuoteVerified:true});
  assert.equal(stale.ready,false);
  assert.ok(stale.reasons.includes("quote_not_fresh"));
  const closed=evaluateScalpingMarketState({quote:{...quote,marketState:"closed"},...windows,now,exnessQuoteVerified:true});
  assert.ok(closed.reasons.includes("market_not_live"));
});

test("blocks spread expansion and detects volatility spikes",()=>{
  const state=evaluateScalpingMarketState({
    quote:{...quote,spread:0.8},...windows,
    shortWindow:{...windows.shortWindow,priceChangePercent:0.08},
    now, exnessQuoteVerified:true
  });
  assert.ok(state.reasons.includes("spread_anomaly"));
  assert.equal(state.volatilityRegime,"SPIKE");
});

test("does not treat conflicting momentum as directional confirmation",()=>{
  const state=evaluateScalpingMarketState({
    quote,
    shortWindow:{...windows.shortWindow,priceChangePercent:0.01},
    contextWindow:{...windows.contextWindow,priceChangePercent:-0.01},
    now, exnessQuoteVerified:true
  });
  assert.equal(state.momentumDirection,"UNALIGNED");
});


test("rejects non-finite bid ask and midpoint values",()=>{
  for (const field of ["bid","ask","mid"]) {
    const state=evaluateScalpingMarketState({quote:{...quote,[field]:Infinity},...windows,now,exnessQuoteVerified:true});
    assert.equal(state.ready,false);
    assert.ok(state.reasons.includes("invalid_quote"));
  }
});


test("rejects midpoint values outside the executable bid ask interval",()=>{
  const state=evaluateScalpingMarketState({quote:{...quote,mid:quote.ask+0.05},...windows,now,exnessQuoteVerified:true});
  assert.equal(state.ready,false);
  assert.ok(state.reasons.includes("mid_outside_bid_ask"));
});
