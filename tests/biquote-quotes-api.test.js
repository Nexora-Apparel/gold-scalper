import test from "node:test";
import assert from "node:assert/strict";
import handler from "../api/biquote-quotes.js";

function response(){
  return {headers:{},statusCode:200,body:null,
    setHeader(k,v){this.headers[k]=v},
    status(code){this.statusCode=code;return this},
    json(body){this.body=body;return this}
  };
}

test("biquote snapshot endpoint rejects non-GET and unsupported symbols",async()=>{
  const res=response();
  await handler({method:"POST",query:{}},res);
  assert.equal(res.statusCode,405);
  assert.equal(res.headers["Cache-Control"],"no-store, max-age=0");
  const invalid=response();
  await handler({method:"GET",query:{symbols:"BTCUSD"}},invalid);
  assert.equal(invalid.statusCode,400);
});

test("biquote endpoint reports provider outage as unavailable, never a fake quote",async()=>{
  const original=globalThis.fetch;
  globalThis.fetch=async()=>({ok:false,status:503,json:async()=>({error:"offline"})});
  try{
    const res=response();
    await handler({method:"GET",query:{symbols:"XAUUSD"}},res);
    assert.equal(res.statusCode,503);
    assert.equal(res.body.ok,false);
    assert.equal(res.body.quotes,undefined);
  }finally{globalThis.fetch=original}
});
