import { analyzeGold } from "../lib/strategy.js";
export default async function handler(req, res) {
  if (req.method !== "POST") { res.setHeader("Allow","POST"); return res.status(405).json({error:"Method not allowed"}); }
  const key=process.env.TWELVEDATA_API_KEY;
  if (!key) return res.status(503).json({status:"NO_TRADE",error:"Market data is not configured. No signal generated."});
  const body=req.body||{};
  const settings={
    balance:Number(body.balance??1000), currency:["USD","NGN","EUR","GBP"].includes(body.currency)?body.currency:"USD",
    riskPercent:Number(body.riskPercent??0.5), minRR:Number(body.minRR??2), minQuality:Number(body.minQuality??70)
  };
  if (!(settings.balance>0) || !(settings.riskPercent>=0.1&&settings.riskPercent<=1) || !(settings.minRR>=1.5&&settings.minRR<=3) || !(settings.minQuality>=65&&settings.minQuality<=80)) {
    return res.status(400).json({status:"NO_TRADE",error:"Invalid risk settings."});
  }
  const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),10000);
  try {
    async function candles(interval, size) {
      const u=new URL("https://api.twelvedata.com/time_series");
      u.searchParams.set("symbol","XAU/USD");u.searchParams.set("interval",interval);u.searchParams.set("outputsize",String(size));u.searchParams.set("format","JSON");u.searchParams.set("apikey",key);
      const r=await fetch(u.toString(),{headers:{Accept:"application/json"},signal:controller.signal});
      const j=await r.json().catch(()=>null);
      if(!r.ok||!j||j.status==="error"||!Array.isArray(j.values)) throw new Error(j?.message||"Provider returned no candle data");
      return j.values.map(v=>({time:v.datetime,open:Number(v.open),high:Number(v.high),low:Number(v.low),close:Number(v.close)}));
    }
    const [hourly,fifteen]=await Promise.all([candles("1h",120),candles("15min",250)]);
    const result=analyzeGold(hourly,fifteen,settings);
    res.setHeader("Cache-Control","no-store");
    return res.status(200).json({...result,source:"Twelve Data",checkedAt:new Date().toISOString(),marketDataVerified:true});
  } catch(e) {
    return res.status(e?.name==="AbortError"?504:502).json({status:"NO_TRADE",signal:null,marketDataVerified:false,error:"Unable to verify XAU/USD candles. No signal generated.",detail:String(e?.message||"provider error").slice(0,200)});
  } finally { clearTimeout(timer); }
}
