import test from "node:test";
import assert from "node:assert/strict";
import { evaluateScalpingDecision, evaluateDynamicExit } from "../lib/scalping-decision-engine.js";

const marketState={ready:true,symbol:"XAUUSD",momentumDirection:"UP",volatilityRegime:"NORMAL",shortMovePercent:0.03,contextMovePercent:0.025,reasons:[]};
const quote={bid:2650,ask:2650.2,spread:0.2,timestamp:"2026-11-01T10:00:00.000Z"};
const microstructure={pressure:0.8,ticksPerSecond:3};
const structure={direction:"UP",strength:1};

test("issues BUY only when every independent gate agrees",()=>{
 const d=evaluateScalpingDecision({marketState,quote,microstructure,structure,now:Date.parse(quote.timestamp)});
 assert.equal(d.action,"BUY_NOW");assert.equal(d.executionEnabled,false);
});
test("fails closed on disagreement, stale-quality state and spikes",()=>{
 const conflict=evaluateScalpingDecision({marketState,quote,microstructure,structure:{...structure,direction:"DOWN"},now:Date.parse(quote.timestamp)});
 assert.equal(conflict.action,"NO_TRADE");assert.ok(conflict.reasons.includes("structure_momentum_conflict"));
 const spike=evaluateScalpingDecision({marketState:{...marketState,volatilityRegime:"SPIKE"},quote,microstructure,structure,now:Date.parse(quote.timestamp)});
 assert.equal(spike.action,"NO_TRADE");assert.ok(spike.reasons.includes("volatility_spike"));
});
test("issues SELL only when downward momentum, structure and pressure align",()=>{
 const d=evaluateScalpingDecision({marketState:{...marketState,momentumDirection:"DOWN",shortMovePercent:-0.03,contextMovePercent:-0.025},quote,microstructure:{...microstructure,pressure:-0.8},structure:{direction:"DOWN",strength:1},now:Date.parse(quote.timestamp)});
 assert.equal(d.action,"SELL_NOW");
});
test("dynamic exit closes only on verified adverse reversal or volatility spike",()=>{
 const now=Date.parse(quote.timestamp);
 const common={position:{side:"BUY",entryPrice:2650},quote,now,microstructure:{pressure:-0.6},marketState:{momentumDirection:"DOWN",volatilityRegime:"NORMAL"}};
 assert.equal(evaluateDynamicExit(common).action,"CLOSE_NOW");
 assert.equal(evaluateDynamicExit({...common,quote:{...quote,timestamp:new Date(now-3000).toISOString()}}).action,"HOLD_UNVERIFIED");
 assert.equal(evaluateDynamicExit({...common,marketState:{volatilityRegime:"NORMAL",momentumDirection:"UP"}}).action,"HOLD");
});
