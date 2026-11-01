import test from "node:test";
import assert from "node:assert/strict";
import { parseExplicitSignalTime, parseHistoricalSignalLog } from "../lib/scalping-signal-dataset.js";

const meta={sourceReference:"signal-export-2026-10",strategy:"mobile_scalping_engine",provider:"biquote"};
const sample={metadata:meta,signals:[
 {id:"s2",timestamp:"2026-10-31T09:00:01.000Z",symbol:"XAUUSD",side:"SELL"},
 {id:"s1",timestamp:"2026-10-31T09:00:00.000Z",symbol:"XAUUSD",side:"BUY"}
]};

test("parses provenance-labelled JSON signals and normalizes chronology",()=>{
 const result=parseHistoricalSignalLog({name:"signals.json",text:JSON.stringify(sample),expectedSymbol:"XAUUSD"});
 assert.equal(result.signals.length,2);
 assert.equal(result.signals[0].id,"s1");
 assert.equal(result.metadata.provider,"biquote");
 assert.equal(result.signals[1].side,"SELL");
});

test("parses CSV with one consistent provider",()=>{
 const csv="timestamp,symbol,side,provider,id\n2026-10-31T09:00:00Z,XAUUSD,BUY,biquote,a\n2026-10-31T09:00:01Z,XAUUSD,SELL,biquote,b";
 const result=parseHistoricalSignalLog({name:"signals.csv",text:csv,expectedSymbol:"XAUUSD"});
 assert.equal(result.signals.length,2);
 assert.equal(result.metadata.provider,"biquote");
});

test("rejects missing provenance or provider and mixed CSV providers",()=>{
 assert.throws(()=>parseHistoricalSignalLog({name:"signals.json",text:JSON.stringify({metadata:{provider:"biquote"},signals:sample.signals}),expectedSymbol:"XAUUSD"}),/provenance/);
 assert.throws(()=>parseHistoricalSignalLog({name:"signals.json",text:JSON.stringify({metadata:{...meta,provider:""},signals:sample.signals}),expectedSymbol:"XAUUSD"}),/provider is required/);
 const csv="timestamp,symbol,side,provider\n2026-10-31T09:00:00Z,XAUUSD,BUY,biquote\n2026-10-31T09:00:01Z,XAUUSD,SELL,other";
 assert.throws(()=>parseHistoricalSignalLog({name:"signals.csv",text:csv,expectedSymbol:"XAUUSD"}),/one consistent provider/);
});

test("rejects timezone-ambiguous, impossible and out-of-range timestamps",()=>{
 assert.ok(Number.isNaN(parseExplicitSignalTime("2026-10-31T09:00:00")));
 assert.ok(Number.isNaN(parseExplicitSignalTime("2026-02-30T09:00:00Z")));
 assert.ok(Number.isNaN(parseExplicitSignalTime("2026-10-31T09:00:00+14:30")));
 assert.ok(Number.isFinite(parseExplicitSignalTime("2026-10-31T09:00:00.125+01:00")));
});

test("rejects symbol mismatch, invalid side, duplicate IDs and malformed CSV",()=>{
 const wrongSymbol=structuredClone(sample);wrongSymbol.signals[0].symbol="XAGUSD";
 assert.throws(()=>parseHistoricalSignalLog({name:"signals.json",text:JSON.stringify(wrongSymbol),expectedSymbol:"XAUUSD"}),/wrong symbol/);
 const wrongSide=structuredClone(sample);wrongSide.signals[0].side="HOLD";
 assert.throws(()=>parseHistoricalSignalLog({name:"signals.json",text:JSON.stringify(wrongSide),expectedSymbol:"XAUUSD"}),/must be BUY or SELL/);
 const duplicate=structuredClone(sample);duplicate.signals[1].id="s2";
 assert.throws(()=>parseHistoricalSignalLog({name:"signals.json",text:JSON.stringify(duplicate),expectedSymbol:"XAUUSD"}),/duplicate signal IDs/);
 assert.throws(()=>parseHistoricalSignalLog({name:"signals.csv",text:"timestamp,symbol,side\n2026-10-31T09:00:00Z,XAUUSD,BUY",expectedSymbol:"XAUUSD"}),/provider columns/);
});
