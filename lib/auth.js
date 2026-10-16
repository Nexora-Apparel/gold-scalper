import { createHmac, timingSafeEqual } from "node:crypto";
const COOKIE="gold_session";
function signature(value, secret){return createHmac("sha256",secret).update(value).digest("base64url");}
export function createSession(secret){const payload=Buffer.from(JSON.stringify({owner:true,exp:Date.now()+8*60*60*1000})).toString("base64url");return payload+"."+signature(payload,secret);}
export function hasOwnerSession(req){const secret=process.env.SESSION_SECRET;if(!secret||secret.length<32)return false;const raw=req.headers.cookie||"";const token=raw.split(";").map(x=>x.trim()).find(x=>x.startsWith(COOKIE+"="))?.slice(COOKIE.length+1);if(!token)return false;const parts=token.split(".");if(parts.length!==2)return false;const expected=Buffer.from(signature(parts[0],secret));const actual=Buffer.from(parts[1]);if(expected.length!==actual.length||!timingSafeEqual(expected,actual))return false;try{const p=JSON.parse(Buffer.from(parts[0],"base64url").toString("utf8"));return p.owner===true&&Number(p.exp)>Date.now();}catch{return false}}
export function setSessionCookie(res,token){res.setHeader("Set-Cookie",COOKIE+"="+token+"; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=28800");}
export function clearSessionCookie(res){res.setHeader("Set-Cookie",COOKIE+"=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0");}
