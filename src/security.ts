import crypto from "node:crypto";
import type { RequestHandler } from "express";
export function signBody(secret: string, timestamp: string, body: Buffer): string { return crypto.createHmac("sha256", secret).update(`${timestamp}.`).update(body).digest("hex"); }
export function timingSafeEqualHex(a: string, b: string): boolean { try { const aa=Buffer.from(a,"hex"), bb=Buffer.from(b,"hex"); return aa.length>0 && aa.length===bb.length && crypto.timingSafeEqual(aa,bb); } catch { return false; } }
export function rateLimiter(limit: number, windowMs=60_000): RequestHandler {
  const buckets=new Map<string,{start:number;count:number}>();
  return (req,res,next)=>{ const key=req.ip??"unknown", now=Date.now(), bucket=buckets.get(key);
    if(!bucket||now-bucket.start>=windowMs){buckets.set(key,{start:now,count:1});return next();}
    bucket.count++; if(bucket.count>limit){res.status(429).json({error:"rate_limited"});return;} next();
  };
}