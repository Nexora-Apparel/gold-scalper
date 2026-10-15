const defaults={balance:1000,currency:"USD",riskPercent:0.5,minRR:2,minQuality:70,maxSignals:3,timeframe:"M15",mode:"manual",goldEnabled:true,majorsEnabled:false,newsEnabled:true};
export default async function handler(req,res){
  if(req.method!=="GET"&&req.method!=="POST"){res.setHeader("Allow","GET, POST");return res.status(405).json({error:"Method not allowed"});}
  // Settings are intentionally not represented as persisted until a durable store and owner authentication are configured.
  if(req.method==="GET") return res.status(200).json({settings:defaults,persisted:false,message:"Defaults loaded; settings are not yet persisted. Save requests are rejected until secure storage is configured."});
  const b=req.body||{};
  const s={balance:Number(b.balance),currency:b.currency,riskPercent:Number(b.riskPercent),minRR:Number(b.minRR),minQuality:Number(b.minQuality),maxSignals:Number(b.maxSignals),timeframe:b.timeframe,mode:b.mode,goldEnabled:b.goldEnabled===true,majorsEnabled:b.majorsEnabled===true,newsEnabled:b.newsEnabled===true};
  if(!(s.balance>0)||!["USD","NGN","EUR","GBP"].includes(s.currency)||!(s.riskPercent>=0.1&&s.riskPercent<=1)||![1.5,2,2.5,3].includes(s.minRR)||![65,70,75,80].includes(s.minQuality)||![1,3,5,8].includes(s.maxSignals)||!["M15","M5 + M15"].includes(s.timeframe)||!["manual","auto"].includes(s.mode))return res.status(400).json({error:"Invalid settings."});
  return res.status(503).json({persisted:false,error:"Settings are not saved. Secure owner authentication and durable storage must be configured first."});
}
