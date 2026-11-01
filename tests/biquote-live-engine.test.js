import test from "node:test";
import assert from "node:assert/strict";
import { BiquoteLiveEngine } from "../lib/biquote-live-engine.js";

class FakeConnection {
  state="Disconnected"; handlers=new Map(); calls=[];
  on(n,f){this.handlers.set(n,f)} off(n){this.handlers.delete(n)}
  onreconnected(f){this.reconnected=f} onclose(f){this.closed=f}
  async start(){this.state="Connected"} async stop(){this.state="Disconnected"}
  async invoke(method,symbols){this.calls.push({method,symbols})}
  tick(payload){this.handlers.get("ReceiveTick")?.(payload)}
}
const tick=(symbol,time,mid)=>({
  symbol,bid:mid-0.05,ask:mid+0.05,mid,spread:0.1,
  timestamp:new Date(time).toISOString(),marketState:"open",stale:false
});

test("composes stream and M1 aggregation without enabling trade execution",async()=>{
  const now=Date.parse("2026-11-01T08:01:05Z");
  const connection=new FakeConnection(), quotes=[], candles=[];
  const engine=new BiquoteLiveEngine({
    connection,now:()=>now,onQuote:q=>quotes.push(q),onCandle:c=>candles.push(c)
  });
  await engine.start();
  connection.tick(tick("XAUUSD",now,2650));
  connection.tick(tick("XAUUSD",now+60000,2651));
  const status=engine.getStatus();
  assert.equal(quotes.length,2);
  assert.equal(candles.length,1);
  assert.equal(candles[0].time,"2026-11-01T08:01:00.000Z");
  assert.equal(status.executionEnabled,false);
  assert.equal(status.signalGenerationEnabled,false);
  await engine.stop();
});
