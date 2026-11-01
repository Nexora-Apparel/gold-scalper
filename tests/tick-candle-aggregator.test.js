import test from "node:test";
import assert from "node:assert/strict";
import { TickCandleAggregator } from "../lib/tick-candle-aggregator.js";

const q=(symbol,at,mid,spread=0.1)=>({
  symbol, timestamp:new Date(at).toISOString(), mid, spread
});

test("builds M1 OHLC from ticks and finalizes on next minute",()=>{
  const emitted=[];
  const agg=new TickCandleAggregator({onCandle:c=>emitted.push(c)});
  const t=Date.parse("2026-11-01T08:01:02Z");
  agg.ingest(q("XAUUSD",t,2650));
  agg.ingest(q("XAUUSD",t+12000,2652,0.2));
  assert.equal(agg.snapshot("XAUUSD").complete,false);
  assert.equal(emitted.length,0);
  agg.ingest(q("XAUUSD",t+60000,2651));
  assert.equal(emitted.length,1);
  assert.equal(emitted[0].time,"2026-11-01T08:01:00.000Z");
  assert.equal(emitted[0].open,2650);
  assert.equal(emitted[0].high,2652);
  assert.equal(emitted[0].low,2650);
  assert.equal(emitted[0].close,2652);
  assert.equal(emitted[0].tickCount,2);
  assert.equal(emitted[0].complete,true);
});

test("keeps OHLC chronological when ticks arrive slightly out of order",()=>{
  const agg=new TickCandleAggregator();
  const t=Date.parse("2026-11-01T08:01:02Z");
  agg.ingest(q("XAUUSD",t+1000,2652));
  agg.ingest(q("XAUUSD",t,2650));
  agg.ingest(q("XAUUSD",t+2000,2651));
  const candle=agg.snapshot("XAUUSD");
  assert.equal(candle.open,2650);
  assert.equal(candle.close,2651);
  assert.equal(candle.high,2652);
});

test("isolates symbols and rejects old-minute ticks",()=>{
  const agg=new TickCandleAggregator();
  const t=Date.parse("2026-11-01T08:01:02Z");
  agg.ingest(q("XAUUSD",t,2650));
  agg.ingest(q("XAGUSD",t,31));
  agg.ingest(q("XAUUSD",t+60000,2651));
  assert.equal(agg.ingest(q("XAUUSD",t+1000,2649)).reason,"closed_minute");
  assert.equal(agg.snapshot("XAGUSD").tickCount,1);
});

test("flush emits only current partial candle and labels it complete for explicit close",()=>{
  const agg=new TickCandleAggregator();
  const t=Date.parse("2026-11-01T08:01:02Z");
  agg.ingest(q("XAGUSD",t,31));
  const [c]=agg.flush();
  assert.equal(c.complete,true);
  assert.equal(c.source,"biquote_ticks");
  assert.equal(agg.snapshot("XAGUSD"),null);
});
