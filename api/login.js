import { timingSafeEqual } from "node:crypto";
import { createSession, setSessionCookie } from "../lib/auth.js";
export default async function handler(req,res){
 if(req.method!=="POST"){res.setHeader("Allow","POST");return res.status(405).json({error:"Method not allowed"});}
 const password=process.env.DASHBOARD_PASSWORD, secret=process.env.SESSION_SECRET;
 if(!password||password.length<16||!secret||secret.length<32)return res.status(503).json({error:"Owner login is not configured. Set DASHBOARD_PASSWORD (16+ characters) and SESSION_SECRET (32+ random characters) in server-side environment variables."});
 const supplied=typeof req.body?.password==="string"?req.body.password:"";
 const a=Buffer.from(password),b=Buffer.from(supplied);
 if(a.length!==b.length||!timingSafeEqual(a,b))return res.status(401).json({error:"Invalid password."});
 setSessionCookie(res,createSession(secret));return res.status(200).json({ok:true,message:"Owner session created."});
}
