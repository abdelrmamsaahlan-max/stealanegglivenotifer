import "dotenv/config";
import express from "express";
import crypto from "node:crypto";
import { Client, GatewayIntentBits, EmbedBuilder } from "discord.js";

const app = express();
app.use(express.json({ limit: "32kb" }));
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

const PORT = Number(process.env.PORT || 3000);
const SECRET = process.env.INGEST_SHARED_SECRET || "";
const CHANNEL_ID = process.env.DISCORD_DEFAULT_CHANNEL_ID || "";
const MONITOR_ENABLED = (process.env.SOURCE_MONITOR_ENABLED || "true").toLowerCase() === "true";
const RARITIES = new Set((process.env.ALERT_RARITIES || "Secret,Eternal,Divine").split(",").map(v => v.trim().toLowerCase()).filter(Boolean));
const SOURCE_CHANNEL_IDS = new Set((process.env.DISCORD_SOURCE_CHANNEL_IDS || "").split(",").map(v => v.trim()).filter(Boolean));
const SOURCE_BOT_IDS = new Set((process.env.DISCORD_SOURCE_BOT_IDS || "").split(",").map(v => v.trim()).filter(Boolean));
const DEDUP_WINDOW_MS = Number(process.env.DEDUP_WINDOW_SECONDS || 60) * 1000;
const seen = new Map();

function verify(req) {
  const supplied = req.header("x-live-signature") || "";
  const body = JSON.stringify(req.body || {});
  if (!SECRET || supplied.length !== 64) return false;
  const expected = crypto.createHmac("sha256", SECRET).update(body).digest("hex");
  return supplied.length === expected.length && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

function isLiveEvent(x) {
  return x && x.live === true && typeof x.eggName === "string" && typeof x.rarity === "string" && typeof x.spawnedAt === "string";
}

function parseSpawn(text) {
  if (!text) return null;
  const normalized = text.replace(/\*\*/g, "").replaceAll(String.fromCharCode(96), "").trim();
  const rarityMatch = normalized.match(/\b(secret|eternal|divine)\b/i);
  if (!rarityMatch || !RARITIES.has(rarityMatch[1].toLowerCase())) return null;

  const eggMatch =
    normalized.match(/(?:egg\s*[:\-]?\s*|egg\s+)([A-Za-z0-9'’._ -]{2,60}?)(?=\s+(?:spawned|spawn|appeared|in|at|location|area)\b|$)/i) ||
    normalized.match(/\b(?:secret|eternal|divine)\s+egg\s+([A-Za-z0-9'’._ -]{2,60}?)(?=\s+(?:spawned|spawn|appeared|in|at)\b|$)/i);

  const areaMatch =
    normalized.match(/\b(?:location|area|biome|zone|place)\s*[:\-]\s*([^\n|]+)/i) ||
    normalized.match(/\b(?:in|at)\s+([A-Z][A-Za-z0-9'’ -]{2,40})\b/i);

  const eggName = eggMatch?.[1]?.trim() || "Unknown Egg";
  const area = areaMatch?.[1]?.trim() || "Unknown";
  const rarity = rarityMatch[1][0].toUpperCase() + rarityMatch[1].slice(1).toLowerCase();
  return { live: true, eggName, displayName: eggName, rarity, biome: area, spawnedAt: new Date().toISOString(), source: "Discord live source" };
}

function extractMessageText(message) {
  const parts = [message.content || ""];
  for (const embed of message.embeds) {
    if (embed.title) parts.push(embed.title);
    if (embed.description) parts.push(embed.description);
    for (const field of embed.fields || []) parts.push(field.name || "", field.value || "");
  }
  return parts.filter(Boolean).join("\n");
}

async function sendAlert(event) {
  if (!CHANNEL_ID) throw new Error("DISCORD_DEFAULT_CHANNEL_ID is not configured");
  const channel = await client.channels.fetch(CHANNEL_ID);
  if (!channel || !channel.isTextBased()) throw new Error("channel_unavailable");

  const unix = Math.floor(new Date(event.spawnedAt).getTime() / 1000);
  const embed = new EmbedBuilder()
    .setTitle("🚨 " + String(event.rarity).toUpperCase() + " EGG SPAWNED")
    .addFields(
      { name: "🥚 Egg", value: String(event.displayName || event.eggName), inline: true },
      { name: "✨ Rarity", value: String(event.rarity), inline: true },
      { name: "🌍 Area", value: String(event.biome || "Unknown"), inline: true },
      { name: "🕒 Spawned", value: "<t:" + unix + ":R>", inline: true },
      { name: "⚡ Detection", value: "LIVE", inline: true },
      { name: "📡 Source", value: String(event.source || "Verified live feed"), inline: true }
    ).setTimestamp(new Date(event.spawnedAt));
  await channel.send({ embeds: [embed] });
}

app.get("/health", (req, res) => res.json({
  ok: true, botReady: client.isReady(), sourceMonitorEnabled: MONITOR_ENABLED,
  liveSourceConfigured: Boolean(SECRET), channelConfigured: Boolean(CHANNEL_ID),
  sourceChannelFilterConfigured: SOURCE_CHANNEL_IDS.size > 0, sourceBotFilterConfigured: SOURCE_BOT_IDS.size > 0
}));

app.post("/api/notify-egg", async (req, res) => {
  if (!SECRET || !verify(req)) return res.status(401).json({ error: "invalid_signature" });
  if (!isLiveEvent(req.body)) return res.status(400).json({ error: "invalid_live_event" });
  try { await sendAlert(req.body); return res.json({ accepted: true }); }
  catch (err) { console.error(err); return res.status(500).json({ error: "discord_send_failed" }); }
});

client.on("messageCreate", async (message) => {
  if (!MONITOR_ENABLED || message.author?.id === client.user?.id) return;
  if (SOURCE_CHANNEL_IDS.size && !SOURCE_CHANNEL_IDS.has(message.channelId)) return;
  if (SOURCE_BOT_IDS.size && !SOURCE_BOT_IDS.has(message.author?.id)) return;

  const event = parseSpawn(extractMessageText(message));
  if (!event) return;

  const key = [message.channelId, event.rarity.toLowerCase(), event.eggName.toLowerCase(), event.biome.toLowerCase()].join("|");
  const now = Date.now();
  if (now - (seen.get(key) || 0) < DEDUP_WINDOW_MS) return;
  seen.set(key, now);

  try { await sendAlert(event); console.log("Forwarded live egg spawn:", key); }
  catch (err) { console.error("Live source forwarding failed:", err); }
});

client.once("ready", () => {
  console.log("Steal An Egg notifier online as " + client.user.tag);
  console.log("Live source monitor:", MONITOR_ENABLED ? "enabled" : "disabled");
});

client.login(process.env.DISCORD_BOT_TOKEN).catch(console.error);
app.listen(PORT, () => console.log("HTTP server listening on " + PORT));