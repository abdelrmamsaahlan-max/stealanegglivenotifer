import "dotenv/config";
import express from "express";
import crypto from "node:crypto";
import { Client, GatewayIntentBits, EmbedBuilder } from "discord.js";

const app=express();
app.use(express.json({limit:"32kb"}));
const client=new Client({intents:[GatewayIntentBits.Guilds]});
const PORT=Number(process.env.PORT||3000);
const SECRET=process.env.INGEST_SHARED_SECRET||"";
const CHANNEL_ID=process.env.DISCORD_DEFAULT_CHANNEL_ID||"";

function verify(req){
  const supplied=req.header("x-live-signature")||"";
  const body=JSON.stringify(req.body||{});
  const expected=crypto.createHmac("sha256",SECRET).update(body).digest("hex");
  return supplied.length===expected.length && crypto.timingSafeEqual(Buffer.from(supplied),Buffer.from(expected));
}
function isLiveEvent(x){
  return x && x.live===true && typeof x.eggName==="string" &&
    typeof x.rarity==="string" && typeof x.spawnedAt==="string";
}
app.get("/health",(req,res)=>res.json({ok:true,botReady:client.isReady(),liveSourceConfigured:Boolean(SECRET),channelConfigured:Boolean(CHANNEL_ID)}));
app.post("/api/notify-egg",async(req,res)=>{
  if(!SECRET || !verify(req)) return res.status(401).json({error:"invalid_signature"});
  if(!isLiveEvent(req.body)) return res.status(400).json({error:"invalid_live_event"});
  try{
    const channel=await client.channels.fetch(CHANNEL_ID);
    if(!channel || !channel.isTextBased()) return res.status(500).json({error:"channel_unavailable"});
    const e=req.body, unix=Math.floor(new Date(e.spawnedAt).getTime()/1000);
    const embed=new EmbedBuilder().setTitle("🚨 "+String(e.rarity).toUpperCase()+" EGG SPAWNED")
      .addFields(
        {name:"🥚 Egg",value:String(e.displayName||e.eggName),inline:true},
        {name:"✨ Rarity",value:String(e.rarity),inline:true},
        {name:"🌍 Area",value:String(e.biome||"Unknown"),inline:true},
        {name:"🕒 Spawned",value:"<t:"+unix+":R>",inline:true},
        {name:"⚡ Detection",value:"LIVE",inline:true},
        {name:"📡 Source",value:String(e.source||"Verified live feed"),inline:true}
      ).setTimestamp(new Date(e.spawnedAt));
    await channel.send({embeds:[embed]});
    return res.json({accepted:true});
  }catch(err){console.error(err);return res.status(500).json({error:"discord_send_failed"});}
});
client.once("ready",()=>console.log("Steal An Egg notifier online as "+client.user.tag));
client.login(process.env.DISCORD_BOT_TOKEN).catch(console.error);
app.listen(PORT,()=>console.log("HTTP server listening on "+PORT));