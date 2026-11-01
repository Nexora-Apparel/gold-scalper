import test from "node:test";
import assert from "node:assert/strict";
import { ScalpingEventJournalClient } from "../lib/scalping-event-client.js";

test("queues and flushes events in bounded batches",async()=>{
  const calls=[];
  const client=new ScalpingEventJournalClient({
    batchSize:2,
    fetchImpl:async(_url,options)=>{const body=JSON.parse(options.body);calls.push(body);return {ok:true,json:async()=>({saved:true,received:body.length,inserted:body.length})};}
  });
  for(let i=0;i<3;i++)client.enqueue({eventId:String(i),type:"NO_TRADE",symbol:"XAUUSD"});
  const result=await client.flush();
  assert.equal(result.sent,3);
  assert.equal(calls.length,2);
  assert.equal(client.queue.length,0);
});

test("retains queued events when the API is unavailable and bounds memory",async()=>{
  const client=new ScalpingEventJournalClient({maxQueue:2,fetchImpl:async()=>({ok:false,status:503})});
  client.enqueue({eventId:"a"});client.enqueue({eventId:"b"});client.enqueue({eventId:"c"});
  assert.deepEqual(client.queue.map(x=>x.eventId),["b","c"]);
  assert.equal(client.dropped,1);
  const result=await client.flush();
  assert.equal(result.pending,2);
  assert.equal(client.queue.length,2);
});

test("deduplicates queued event IDs and prevents overlapping flushes",async()=>{
  let release;
  const client=new ScalpingEventJournalClient({fetchImpl:async()=>{await new Promise(r=>release=r);return {ok:true,json:async()=>({saved:true,received:1,inserted:1})};}});
  client.enqueue({eventId:"same"});
  assert.equal(client.enqueue({eventId:"same"}),true);
  const first=client.flush();
  const second=await client.flush();
  assert.equal(second.pending,1);
  release();
  await first;
  assert.equal(client.queue.length,0);
});
