import test from "node:test";
import assert from "node:assert/strict";
import { HigherTimeframeAggregator } from "../lib/higher-timeframe-aggregator.js";

const bar=(minute,close=100)=>({
  symbol:"XAUUSD",timeframe:"M1",time:new Date(minute).toISOString(),
  open:close-0.2,high:close+0.5,low:close-0.5,close,
  tickCount:12,complete:true
});

test("emits M5 and M15 only after complete contiguous constituent minutes",()=>{
  const emitted=[];
  const h=new HigherTimeframeAggregator({onCandle:c=>emitted.push(c)});
  const start=Date.parse("2026-11-01T08:00:00Z");
  for(let i=0;i<15;i++) h.ingest(bar(start+i*60000,100+i));
  const result=h.ingest(bar(start+15*60000,115));
  assert.equal(result.completed.length,2);
  assert.equal(result.completed.find(c=>c.timeframe==="M5").constituentMinutes,5);
  assert.equal(result.completed.find(c=>c.timeframe==="M15").constituentMinutes,15);
  // Three completed M5 buckets (08:00, 08:05, 08:10) and one M15 bucket.
  assert.equal(emitted.length,4);
  assert.equal(emitted.filter(c=>c.timeframe==="M5").length,3);
  assert.equal(emitted.filter(c=>c.timeframe==="M15").length,1);
});

test("does not fabricate context candles when constituent M1 data has gaps",()=>{
  const h=new HigherTimeframeAggregator();
  const start=Date.parse("2026-11-01T08:00:00Z");
  [0,1,2,4,5].forEach(i=>h.ingest(bar(start+i*60000,100+i)));
  const result=h.ingest(bar(start+6*60000,106));
  assert.equal(result.completed.some(c=>c.timeframe==="M5"),false);
  assert.equal(h.getLatestCompleted("XAUUSD","M5"),null);
});

test("rejects partial or duplicate M1 bars",()=>{
  const h=new HigherTimeframeAggregator();
  const start=Date.parse("2026-11-01T08:00:00Z");
  assert.throws(()=>h.ingest({...bar(start),complete:false}));
  h.ingest(bar(start));
  assert.equal(h.ingest(bar(start)).accepted,false);
});
