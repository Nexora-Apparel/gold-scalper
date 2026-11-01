import test from "node:test";
import assert from "node:assert/strict";
import { ShortTermStructureDetector } from "../lib/short-term-structure.js";

const bar=(time,open,high,low,close)=>({symbol:"XAUUSD",timeframe:"M1",time:new Date(time).toISOString(),open,high,low,close,complete:true});

test("requires completed M1 bars and confirms close beyond prior swing high",()=>{
  const d=new ShortTermStructureDetector({lookback:3,minBreakoutRangeRatio:0.1});
  const t=Date.parse("2026-11-01T08:00:00Z");
  d.ingest({...bar(t,100,102,99,101),complete:false});
  assert.equal(d.snapshot("XAUUSD").ready,false);
  d.ingest(bar(t,100,102,99,101));
  d.ingest(bar(t+60000,101,103,100,102));
  d.ingest(bar(t+120000,102,103,100,101));
  const result=d.ingest(bar(t+180000,101,104,101,103.5));
  assert.equal(result.direction,"UP");
  assert.equal(result.ready,true);
  assert.equal(result.reason,"m1_close_broke_prior_swing_high");
});

test("confirms downside break and rejects incomplete or malformed bars",()=>{
  const d=new ShortTermStructureDetector({lookback:2,minBreakoutRangeRatio:0.2});
  const t=Date.parse("2026-11-01T09:00:00Z");
  d.ingest(bar(t,110,112,108,109));
  d.ingest(bar(t+60000,109,111,107,108));
  const result=d.ingest(bar(t+120000,108,109,104,105));
  assert.equal(result.direction,"DOWN");
  assert.equal(d.ingest({...bar(t+180000,105,106,103,104),complete:false}).direction,"DOWN");
});
