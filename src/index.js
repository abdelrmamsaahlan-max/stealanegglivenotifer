import "dotenv/config";
import express from "express";
import crypto from "node:crypto";
import { Client, GatewayIntentBits, EmbedBuilder, REST, Routes, SlashCommandBuilder } from "discord.js";

const app = express();
app.use(express.json({ limit: "32kb" }));
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
const DEV_GUILD_ID = process.env.DISCORD_DEV_GUILD_ID || "";
const COMMANDS = [
  new SlashCommandBuilder().setName("ping").setDescription("Check if the notifier is online."),
  new SlashCommandBuilder().setName("status").setDescription("Show live monitor and configuration status."),
  new SlashCommandBuilder().setName("testegg").setDescription("Send a test egg alert to the configured alert channel.")
].map(c => c.toJSON());

const PORT = Number(process.env.PORT || 3000);
const SECRET = process.env.INGEST_SHARED_SECRET || "";
const CHANNEL_ID = process.env.DISCORD_DEFAULT_CHANNEL_ID || "";
const MONITOR_ENABLED = (process.env.SOURCE_MONITOR_ENABLED || "true").toLowerCase() === "true";
const RARITIES = new Set((process.env.ALERT_RARITIES || "Secret,Eternal,Divine").split(",").map(v => v.trim().toLowerCase()).filter(Boolean));
const SOURCE_CHANNEL_IDS = new Set((process.env.DISCORD_SOURCE_CHANNEL_IDS || "").split(",").map(v => v.trim()).filter(Boolean));
const SOURCE_BOT_IDS = new Set((process.env.DISCORD_SOURCE_BOT_IDS || "").split(",").map(v => v.trim()).filter(Boolean));
const DEDUP_WINDOW_MS = Number(process.env.DEDUP_WINDOW_SECONDS || 60) * 1000;
const seen = new Map();
let alertChannel = null;
let detectedCount = 0;
let alertCount = 0;
let lastSpawnAt = null;

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

  const normalized = String(text)
    .replace(/<a?:\w+:\d+>/g, "")
    .replace(/\*\*/g, "")
    .replace(/[_~]/g, "")
    .replaceAll(String.fromCharCode(96), "")
    .replace(/\\n/g, "\n")
    .replace(/\r/g, "")
    .trim();

  const rarityMatch = normalized.match(/\b(secret|eternal|divine)\b/i);
  if (!rarityMatch || !RARITIES.has(rarityMatch[1].toLowerCase())) return null;

  const rarity = rarityMatch[1][0].toUpperCase() + rarityMatch[1].slice(1).toLowerCase();

  const patterns = [
    /(?:egg|item|spawn)\s*(?:name)?\s*[:\-]\s*([^\n|]+)/i,
    /(?:secret|eternal|divine)\s+(?:egg\s+)?(?:spawned|appeared)\s*[:\-]?\s*([^\n|]+?)(?=\s+(?:in|at|on)\s+|$)/i,
    /(?:spawned|appeared)\s*[:\-]?\s*([^\n|]+?)(?=\s+(?:in|at|on)\s+|$)/i,
    /\b(?:egg)\s+([A-Za-z0-9'’._ -]{2,80})\b/i
  ];

  let eggName = null;
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match?.[1]) {
      eggName = match[1]
        .replace(/\s+(?:spawned|appeared|is\s+now|has\s+spawned)\b.*$/i, "")
        .trim();
      if (eggName) break;
    }
  }

  const areaPatterns = [
    /\b(?:location|area|biome|zone|place)\s*[:\-]\s*([^\n|]+)/i,
    /\b(?:in|at|on)\s+(?:the\s+)?([^\n|]+?)\s*(?:[.!]|$)/i
  ];

  let area = null;
  for (const pattern of areaPatterns) {
    const match = normalized.match(pattern);
    if (match?.[1]) {
      area = match[1].trim();
      break;
    }
  }

  // Avoid turning an ordinary sentence fragment into an item name.
  if (eggName) {
    eggName = eggName
      .replace(/^[:\-\s]+|[:\-\s]+$/g, "")
      .replace(/\s{2,}/g, " ")
      .trim();
    if (/^(spawned|appeared|now|here)$/i.test(eggName)) eggName = null;
  }

  return {
    live: true,
    eggName: eggName || "Unknown Egg",
    displayName: eggName || "Unknown Egg",
    rarity,
    biome: area || "Unknown",
    spawnedAt: new Date().toISOString(),
    source: "Live Spawn"
  };
}

function extractMessageData(message) {
  const parts = [message.content || ""];
  let imageUrl = null;

  for (const embed of message.embeds) {
    if (embed.title) parts.push(embed.title);
    if (embed.description) parts.push(embed.description);
    for (const field of embed.fields || []) parts.push(field.name || "", field.value || "");
    if (!imageUrl && embed.image?.url) imageUrl = embed.image.url;
    if (!imageUrl && embed.thumbnail?.url) imageUrl = embed.thumbnail.url;
  }

  if (!imageUrl && message.attachments?.size) {
    const attachment = message.attachments.find(a => a.contentType?.startsWith("image/"));
    if (attachment) imageUrl = attachment.url;
  }

  return {
    text: parts.filter(Boolean).join("\n"),
    imageUrl,
    createdTimestamp: message.createdTimestamp
  };
}

async function getAlertChannel() {
  if (alertChannel && alertChannel.isTextBased()) return alertChannel;
  if (!CHANNEL_ID) throw new Error("DISCORD_DEFAULT_CHANNEL_ID is not configured");

  const channel = await client.channels.fetch(CHANNEL_ID);
  if (!channel || !channel.isTextBased()) throw new Error("channel_unavailable");
  alertChannel = channel;
  return channel;
}

async function sendAlert(event) {
  const channel = await getAlertChannel();

  const unix = Math.floor(new Date(event.spawnedAt).getTime() / 1000);
  const eggName = String(event.displayName || event.eggName || "Unknown Egg").trim();
  const rarity = String(event.rarity || "Unknown").trim();
  const area = String(event.biome || "Unknown").trim();

  const rarityColors = {
    secret: 0x8b5cf6,
    eternal: 0xf59e0b,
    divine: 0xef4444
  };
  const rarityColor = rarityColors[rarity.toLowerCase()] || 0x5865f2;

  const embed = new EmbedBuilder()
    .setColor(rarityColor)
    .setTitle("🥚 " + rarity.toUpperCase() + " EGG SPAWNED!")
    .setDescription("A " + rarity.toLowerCase() + " egg has just spawned.")
    .addFields(
      { name: "🥚 Egg", value: eggName.slice(0, 1024), inline: true },
      { name: "✨ Rarity", value: rarity.slice(0, 1024), inline: true },
      { name: "📍 Area", value: area.slice(0, 1024), inline: true },
      { name: "⏱️ Spawned", value: "<t:" + unix + ":R>", inline: true }
    )
    .setFooter({ text: "Steal an Egg • Live Spawn Alert" })
    .setTimestamp(new Date(event.spawnedAt));

  if (event.imageUrl) embed.setImage(event.imageUrl);

  const payload = {
    content: "🚨 **" + rarity.toUpperCase() + " EGG!**",
    embeds: [embed],
    allowedMentions: { parse: [] }
  };

  try {
    await channel.send(payload);
  } catch (firstError) {
    // Retry once without the image in case the source image URL expired or is inaccessible.
    if (event.imageUrl) {
      const fallbackEmbed = EmbedBuilder.from(embed);
      fallbackEmbed.setImage(null);
      payload.embeds = [fallbackEmbed];
      try {
        await channel.send(payload);
        console.warn("Alert image failed; sent alert without image.");
      } catch (secondError) {
        alertChannel = null;
        const freshChannel = await getAlertChannel();
        await freshChannel.send(payload);
      }
    } else {
      alertChannel = null;
      const freshChannel = await getAlertChannel();
      await freshChannel.send(payload);
    }
  }

  alertCount++;
  lastSpawnAt = event.spawnedAt;
}

app.get("/health", (req, res) => res.status(client.isReady() ? 200 : 503).json({
  ok: true,
  botReady: client.isReady(),
  sourceMonitorEnabled: MONITOR_ENABLED,
  liveSourceConfigured: Boolean(SECRET),
  channelConfigured: Boolean(CHANNEL_ID),
  alertChannelCached: Boolean(alertChannel),
  sourceChannelFilterConfigured: SOURCE_CHANNEL_IDS.size > 0,
  sourceBotFilterConfigured: SOURCE_BOT_IDS.size > 0,
  detectedCount,
  alertCount,
  lastSpawnAt
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

  const messageData = extractMessageData(message);
  const event = parseSpawn(messageData.text);
  if (event && messageData.imageUrl) event.imageUrl = messageData.imageUrl;
  if (!event) return;
  if (messageData.createdTimestamp) {
    event.spawnedAt = new Date(messageData.createdTimestamp).toISOString();
  }
  detectedCount++;

  const key = [message.channelId, event.rarity.toLowerCase(), event.eggName.toLowerCase(), event.biome.toLowerCase()].join("|");
  const now = Date.now();
  if (now - (seen.get(key) || 0) < DEDUP_WINDOW_MS) return;
  seen.set(key, now);

  for (const [seenKey, seenAt] of seen) {
    if (now - seenAt > DEDUP_WINDOW_MS * 2) seen.delete(seenKey);
  }

  try {
    await sendAlert(event);
    console.log("Forwarded live egg spawn:", key);
  } catch (err) {
    alertChannel = null;
    console.error("Live source forwarding failed:", err);
  }
});

client.once("clientReady", async () => {
  console.log("Steal An Egg notifier online as " + client.user.tag);
  console.log("Live source monitor:", MONITOR_ENABLED ? "enabled" : "disabled");

  if (CHANNEL_ID) {
    try {
      alertChannel = await client.channels.fetch(CHANNEL_ID);
      console.log("Alert channel cached.");
    } catch (err) {
      console.error("Alert channel preload failed:", err);
    }
  }

  try {
    const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_BOT_TOKEN);
    if (DEV_GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(client.user.id, DEV_GUILD_ID), { body: COMMANDS });
      console.log("Slash commands registered in development guild.");
    } else {
      await rest.put(Routes.applicationCommands(client.user.id), { body: COMMANDS });
      console.log("Slash commands registered globally.");
    }
  } catch (err) {
    console.error("Slash command registration failed:", err);
  }
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    if (interaction.commandName === "ping") {
      return await interaction.reply({ content: "🏓 Pong — notifier is online." });
    }

    if (interaction.commandName === "status") {
      const status = [
        "🤖 Bot: " + (client.isReady() ? "ONLINE" : "NOT READY"),
        "📡 Live monitor: " + (MONITOR_ENABLED ? "ENABLED" : "DISABLED"),
        "🎯 Rarities: " + [...RARITIES].join(", "),
        "📥 Source channel: " + (SOURCE_CHANNEL_IDS.size ? [...SOURCE_CHANNEL_IDS].join(", ") : "ALL CHANNELS"),
        "📤 Alert channel: " + (CHANNEL_ID ? "CONFIGURED" : "NOT CONFIGURED"),
        "⚡ Alerts sent: " + alertCount,
        "🟢 Last spawn: " + (lastSpawnAt ? "<t:" + Math.floor(new Date(lastSpawnAt).getTime() / 1000) + ":R>" : "NONE")
      ].join("\n");
      return await interaction.reply({ content: status, ephemeral: true });
    }

    if (interaction.commandName === "testegg") {
      if (!CHANNEL_ID) {
        return await interaction.reply({ content: "❌ DISCORD_DEFAULT_CHANNEL_ID is not configured in Railway.", ephemeral: true });
      }

      await interaction.deferReply({ ephemeral: true });

      const testEvent = {
        live: true,
        eggName: "Test Egg",
        displayName: "Test Egg",
        rarity: "Secret",
        biome: "Test Area",
        spawnedAt: new Date().toISOString(),
        source: "Test"
      };

      await sendAlert(testEvent);
      return await interaction.editReply({ content: "✅ Test egg alert sent successfully." });
    }
  } catch (err) {
    console.error("Interaction failed:", err);
    if (interaction.deferred) {
      await interaction.editReply({ content: "❌ Command failed: " + (err?.message || "unknown error") }).catch(() => {});
    } else if (interaction.replied) {
      await interaction.followUp({ content: "❌ Command failed: " + (err?.message || "unknown error"), ephemeral: true }).catch(() => {});
    } else {
      await interaction.reply({ content: "❌ Command failed: " + (err?.message || "unknown error"), ephemeral: true }).catch(() => {});
    }
  }
});

client.on("error", err => console.error("Discord client error:", err));
client.on("shardError", err => console.error("Discord shard error:", err));

process.on("unhandledRejection", err => console.error("Unhandled rejection:", err));
process.on("uncaughtException", err => console.error("Uncaught exception:", err));

async function shutdown(signal) {
  console.log("Received " + signal + ", shutting down gracefully...");
  client.destroy();
  process.exit(0);
}
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));

client.login(process.env.DISCORD_BOT_TOKEN).catch(console.error);
app.listen(PORT, () => console.log("HTTP server listening on " + PORT));