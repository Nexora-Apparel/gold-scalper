import test from "node:test";
import assert from "node:assert/strict";
import { MicrostructureWindow } from "../lib/microstructure-window.js";

const q=(t,mid,spread=0.2)=>({
  timestamp:new Date(t).toISOString(),mid,spread
});

test("computes short-window price movement, tick rate and spread statistics",()=>{
  const w=new MicrostructureWindow({windowMs:5000});
  const t=Date.parse("2026-11-01T08:00:00Z");
  w.push(q(t,2650,0.2));
  w.push(q(t+1000,2651,0.4));
  const s=w.snapshot(t+1000);
  assert.equal(s.ready,true);
  assert.equal(s.priceChange,1);
  assert.equal(s.ticksPerSecond,1);
  assert.equal(s.averageSpread,0.3);
  assert.equal(s.maxSpread,0.4);
  assert.equal(s.quoteAgeMs,0);
});

test("prunes old observations and rejects out-of-order samples",()=>{
  const w=new MicrostructureWindow({windowMs:1000});
  const t=Date.parse("2026-11-01T08:00:00Z");
  w.push(q(t,2650));
  w.push(q(t+900,2651));
  assert.equal(w.push(q(t+800,2652)),false);
  const s=w.snapshot(t+2100);
  assert.equal(s.sampleCount,1);
  assert.equal(s.latestMid,2651);
});

test("rejects malformed market observations",()=>{
  const w=new MicrostructureWindow();
  assert.throws(()=>w.push({timestamp:"bad",mid:0,spread:-1}));
});
