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
  new SlashCommandBuilder().setName("testegg").setDescription("Send a test egg alert to the configured alert channel."),
  new SlashCommandBuilder().setName("lastseen").setDescription("Show the last detected rare egg.")

].map(c => c.toJSON());

const PORT = Number(process.env.PORT || 3000);
const SECRET = process.env.INGEST_SHARED_SECRET || "";
const CHANNEL_ID = process.env.DISCORD_DEFAULT_CHANNEL_ID || "";
const MONITOR_ENABLED = (process.env.SOURCE_MONITOR_ENABLED || "true").toLowerCase() === "true";
const RARITIES = new Set((process.env.ALERT_RARITIES || "Secret,Eternal,Divine").split(",").map(v => v.trim().toLowerCase()).filter(Boolean));
const SOURCE_CHANNEL_IDS = new Set((process.env.DISCORD_SOURCE_CHANNEL_IDS || "").split(",").map(v => v.trim()).filter(Boolean));
const SOURCE_BOT_IDS = new Set((process.env.DISCORD_SOURCE_BOT_IDS || "").split(",").map(v => v.trim()).filter(Boolean));
const DEDUP_WINDOW_MS = Math.max(5, Number(process.env.DEDUP_WINDOW_SECONDS || 60)) * 1000;
const SEEN_TTL_MS = Math.max(60, Number(process.env.SEEN_TTL_SECONDS || 900)) * 1000;
const ALERT_MENTION_MODE = (process.env.ALERT_MENTION_MODE || "none").toLowerCase();
const ALERT_ROLE_IDS = {
  secret: process.env.ALERT_SECRET_ROLE_ID || "",
  eternal: process.env.ALERT_ETERNAL_ROLE_ID || "",
  divine: process.env.ALERT_DIVINE_ROLE_ID || ""
};
const seen = new Map();
const alertedMessageIds = new Map();
const lastSeen = new Map();
let alertChannel = null;
let detectedCount = 0;
let alertCount = 0;
let lastSpawnAt = null;
let lastAlertLatencyMs = null;
let monitorErrors = 0;

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

function cleanText(value) {
  return String(value || "")
    .replace(/<a?:\w+:\d+>/g, "")
    .replace(/\*\*/g, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replaceAll(String.fromCharCode(96), "")
    .replace(/\\n/g, "\n")
    .replace(/\r/g, "")
    .trim();
}

function normalizeLabel(value) {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function firstMeaningfulLine(value) {
  return cleanText(value).split("\n").map(v => v.trim()).find(Boolean) || "";
}

function parseSpawn(data) {
  const text = cleanText(data?.text);
  const fields = Array.isArray(data?.fields) ? data.fields : [];
  const fieldMap = new Map();

  for (const field of fields) {
    const key = normalizeLabel(field.name);
    const value = firstMeaningfulLine(field.value);
    if (key && value) fieldMap.set(key, value);
  }

  const combined = [text, ...fields.flatMap(f => [f.name || "", f.value || ""])].filter(Boolean).join("\n");

  const rarityMatch = combined.match(/\b(secret|eternal|divine)\b/i);
  if (!rarityMatch || !RARITIES.has(rarityMatch[1].toLowerCase())) return null;

  const rarity = rarityMatch[1][0].toUpperCase() + rarityMatch[1].slice(1).toLowerCase();

  const getField = (...names) => {
    for (const name of names) {
      const wanted = normalizeLabel(name);
      for (const [key, value] of fieldMap) {
        if (key === wanted || key.includes(wanted) || wanted.includes(key)) return value;
      }
    }
    return "";
  };

  let eggName = getField("egg", "egg name", "item", "item name", "spawn", "spawn name");
  let area = getField("area", "location", "biome", "zone", "place", "world");

  const eggPatterns = [
    /(?:egg|item)\s*(?:name)?\s*[:：\-]\s*([^\n|]+)/i,
    /(?:secret|eternal|divine)\s+(?:egg\s+)?(?:spawned|appeared|has\s+spawned)\s*[:：\-]?\s*([^\n|]+?)(?=\s+(?:in|at|on)\s+|$)/i,
    /(?:spawned|appeared|has\s+spawned)\s*[:：\-]?\s*([^\n|]+?)(?=\s+(?:in|at|on)\s+|$)/i
  ];

  if (!eggName) {
    for (const pattern of eggPatterns) {
      const match = combined.match(pattern);
      if (match?.[1]) {
        eggName = match[1].trim();
        break;
      }
    }
  }

  const areaPatterns = [
    /\b(?:location|area|biome|zone|place|world)\s*[:：\-]\s*([^\n|]+)/i,
    /\b(?:in|at|on)\s+(?:the\s+)?([^\n|.!?]+?)(?:[.!?]|$)/i
  ];

  if (!area) {
    for (const pattern of areaPatterns) {
      const match = combined.match(pattern);
      if (match?.[1]) {
        area = match[1].trim();
        break;
      }
    }
  }

  const optional = {
    chance: getField("chance", "spawn chance"),
    speed: getField("speed", "required speed", "steal speed"),
    value: getField("value", "worth", "money"),
    income: getField("income", "cash per second", "money per second"),
    mutation: getField("mutation", "mutations"),
    countdown: getField("countdown", "time left", "expires")
  };

  eggName = cleanText(eggName).replace(/^[\s:：\-]+|[\s:：\-]+$/g, "").trim();
  area = cleanText(area).replace(/^[\s:：\-]+|[\s:：\-]+$/g, "").trim();

  if (!eggName || /^(spawned|appeared|unknown|here|now)$/i.test(eggName)) eggName = "Unknown Egg";
  if (!area) area = "Unknown";

  // Ignore obvious non-spawn announcements that merely mention a rarity.
  const spawnSignal = /\b(spawned|spawn|appeared|detected|found|just\s+spawned|new\s+egg|egg\s+alert|egg\s+has\s+appeared)\b/i.test(combined);
  const structuredSignal = Boolean(getField("egg", "egg name", "item", "item name"));
  if (!spawnSignal && !structuredSignal) return null;

  return {
    live: true,
    eggName,
    displayName: eggName,
    rarity,
    biome: area,
    spawnedAt: new Date().toISOString(),
    source: "Live Spawn",
    ...Object.fromEntries(Object.entries(optional).filter(([, value]) => value))
  };
}

function extractMessageData(message) {
  const parts = [message.content || ""];
  const fields = [];
  let imageUrl = null;

  for (const embed of message.embeds || []) {
    if (embed.title) parts.push(embed.title);
    if (embed.description) parts.push(embed.description);
    for (const field of embed.fields || []) {
      fields.push({ name: field.name || "", value: field.value || "" });
      parts.push(field.name || "", field.value || "");
    }

    if (!imageUrl && embed.image?.url) imageUrl = embed.image.url;
    if (!imageUrl && embed.thumbnail?.url) imageUrl = embed.thumbnail.url;
  }

  if (!imageUrl && message.attachments?.size) {
    const attachment = message.attachments.find(a =>
      a.contentType?.startsWith("image/") || /\.(png|jpe?g|gif|webp)(?:\?|$)/i.test(a.url || "")
    );
    if (attachment) imageUrl = attachment.url;
  }

  return {
    text: parts.filter(Boolean).join("\n"),
    fields,
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

function buildAlertEmbed(event) {
  const rarity = String(event.rarity || "Unknown").trim();
  const rarityKey = rarity.toLowerCase();
  const rarityColors = {
    secret: 0x8b5cf6,
    eternal: 0xf59e0b,
    divine: 0xef4444
  };

  const unix = Math.floor(new Date(event.spawnedAt).getTime() / 1000);
  const fields = [
    { name: "🥚 Egg", value: String(event.displayName || event.eggName || "Unknown Egg").trim().slice(0, 1024), inline: true },
    { name: "✨ Rarity", value: rarity.slice(0, 1024), inline: true },
    { name: "📍 Area", value: String(event.biome || "Unknown").trim().slice(0, 1024), inline: true },
    { name: "⏱️ Spawned", value: "<t:" + unix + ":R>", inline: true }
  ];

  const optionalFields = [
    ["🎲 Chance", event.chance],
    ["⚡ Speed", event.speed],
    ["💰 Value", event.value],
    ["📈 Income", event.income],
    ["🧬 Mutation", event.mutation],
    ["⌛ Time Left", event.countdown]
  ];

  for (const [name, value] of optionalFields) {
    if (value) fields.push({ name, value: String(value).slice(0, 1024), inline: true });
  }

  const embed = new EmbedBuilder()
    .setColor(rarityColors[rarityKey] || 0x5865f2)
    .setTitle("🥚 " + rarity.toUpperCase() + " EGG SPAWNED!")
    .setDescription("A rare egg has just spawned.")
    .addFields(fields)
    .setFooter({ text: "Steal an Egg • Live Spawn Alert" })
    .setTimestamp(new Date(event.spawnedAt));

  if (event.imageUrl) embed.setImage(event.imageUrl);
  return embed;
}

async function sendAlert(event, latencyMs = null) {
  const channel = await getAlertChannel();
  const rarity = String(event.rarity || "Unknown").trim();
  const rarityKey = rarity.toLowerCase();
  const embed = buildAlertEmbed(event);

  if (Number.isFinite(latencyMs) && latencyMs >= 0) {
    embed.addFields({ name: "⚡ Detection", value: latencyMs < 1000 ? latencyMs + "ms" : (latencyMs / 1000).toFixed(1) + "s", inline: true });
  }

  const roleId = ALERT_ROLE_IDS[rarityKey];
  const mentionContent = ALERT_MENTION_MODE === "role" && roleId
    ? "<@&" + roleId + "> 🚨 **" + rarity.toUpperCase() + " EGG!**"
    : ALERT_MENTION_MODE === "here"
      ? "@here 🚨 **" + rarity.toUpperCase() + " EGG!**"
      : "🚨 **" + rarity.toUpperCase() + " EGG!**";

  const payload = {
    content: mentionContent,
    embeds: [embed],
    allowedMentions: {
      parse: ALERT_MENTION_MODE === "here" ? ["everyone"] : [],
      roles: ALERT_MENTION_MODE === "role" && roleId ? [roleId] : []
    }
  };

  try {
    await channel.send(payload);
  } catch (firstError) {
    alertChannel = null;
    const freshChannel = await getAlertChannel();

    if (event.imageUrl) {
      const fallbackEmbed = buildAlertEmbed({ ...event, imageUrl: null });
      if (Number.isFinite(latencyMs) && latencyMs >= 0) {
        fallbackEmbed.addFields({ name: "⚡ Detection", value: latencyMs < 1000 ? latencyMs + "ms" : (latencyMs / 1000).toFixed(1) + "s", inline: true });
      }
      payload.embeds = [fallbackEmbed];
    }

    await freshChannel.send(payload);
  }

  alertCount++;
  lastSpawnAt = event.spawnedAt;
  lastAlertLatencyMs = Number.isFinite(latencyMs) ? latencyMs : null;
  lastSeen.set((event.displayName || event.eggName || "Unknown Egg").toLowerCase(), {
    eggName: event.displayName || event.eggName || "Unknown Egg",
    rarity,
    area: event.biome || "Unknown",
    at: event.spawnedAt
  });
}

function cleanupCaches(now = Date.now()) {
  for (const [key, timestamp] of seen) if (now - timestamp > SEEN_TTL_MS) seen.delete(key);
  for (const [key, timestamp] of alertedMessageIds) if (now - timestamp > SEEN_TTL_MS) alertedMessageIds.delete(key);
}

async function processSpawnMessage(message) {
  if (!MONITOR_ENABLED || !message || message.author?.id === client.user?.id) return;
  if (SOURCE_CHANNEL_IDS.size && !SOURCE_CHANNEL_IDS.has(message.channelId)) return;
  if (SOURCE_BOT_IDS.size && !SOURCE_BOT_IDS.has(message.author?.id)) return;

  const messageData = extractMessageData(message);
  const event = parseSpawn(messageData);
  if (!event) return;

  if (messageData.createdTimestamp) {
    event.spawnedAt = new Date(messageData.createdTimestamp).toISOString();
  }
  if (messageData.imageUrl) event.imageUrl = messageData.imageUrl;

  detectedCount++;
  const now = Date.now();
  cleanupCaches(now);

  // A source message should normally generate at most one alert.
  if (alertedMessageIds.has(message.id)) return;

  // Semantic dedup only catches rapid duplicate reposts.
  const semanticKey = [
    event.rarity.toLowerCase(),
    event.eggName.toLowerCase(),
    event.biome.toLowerCase()
  ].join("|");

  if (now - (seen.get(semanticKey) || 0) < DEDUP_WINDOW_MS) return;
  seen.set(semanticKey, now);

  const latencyMs = messageData.createdTimestamp ? Math.max(0, now - messageData.createdTimestamp) : null;
  alertedMessageIds.set(message.id, now);

  try {
    await sendAlert(event, latencyMs);
    console.log("Forwarded live egg spawn:", semanticKey, "latencyMs=" + (latencyMs ?? "unknown"));
  } catch (err) {
    monitorErrors++;
    alertedMessageIds.delete(message.id);
    seen.delete(semanticKey);
    alertChannel = null;
    console.error("Live source forwarding failed:", err);
  }
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
  lastSpawnAt,
  lastAlertLatencyMs,
  monitorErrors,
  cacheSize: seen.size
}));

app.post("/api/notify-egg", async (req, res) => {
  if (!SECRET || !verify(req)) return res.status(401).json({ error: "invalid_signature" });
  if (!isLiveEvent(req.body)) return res.status(400).json({ error: "invalid_live_event" });
  try { await sendAlert(req.body); return res.json({ accepted: true }); }
  catch (err) { console.error(err); return res.status(500).json({ error: "discord_send_failed" }); }
});

client.on("messageCreate", message => {
  void processSpawnMessage(message);
});

client.on("messageUpdate", async (_oldMessage, newMessage) => {
  // Some source bots/webhooks populate embeds a moment after the original post.
  // Process edits only when the message has not already produced an alert.
  if (alertedMessageIds.has(newMessage.id)) return;
  try {
    if (!newMessage.author) await newMessage.fetch().catch(() => newMessage);
    await processSpawnMessage(newMessage);
  } catch (err) {
    monitorErrors++;
    console.error("Live source update processing failed:", err);
  }
});

client.once("clientReady", async () => {
  console.log("Steal An Egg notifier online as " + client.user.tag);
  console.log("Live source monitor:", MONITOR_ENABLED ? "enabled" : "disabled");
  console.log("Configured rarities:", [...RARITIES].join(", "));
  console.log("Source channel filters:", SOURCE_CHANNEL_IDS.size || "none");
  console.log("Alert mention mode:", ALERT_MENTION_MODE);

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
        "🟢 Last spawn: " + (lastSpawnAt ? "<t:" + Math.floor(new Date(lastSpawnAt).getTime() / 1000) + ":R>" : "NONE"),
        "⚡ Last latency: " + (lastAlertLatencyMs == null ? "N/A" : lastAlertLatencyMs + "ms"),
        "📊 Alerts / detected: " + alertCount + " / " + detectedCount
      ].join("\n");
      return await interaction.reply({ content: status, ephemeral: true });
    }

    if (interaction.commandName === "lastseen") {
      if (!lastSeen.size) {
        return await interaction.reply({ content: "📭 No rare egg has been detected yet.", ephemeral: true });
      }

      const recent = [...lastSeen.values()]
        .sort((a, b) => new Date(b.at) - new Date(a.at))
        .slice(0, 10);

      const text = recent.map(item =>
        "🥚 **" + item.eggName + "** • " + item.rarity +
        " • 📍 " + item.area +
        " • <t:" + Math.floor(new Date(item.at).getTime() / 1000) + ":R>"
      ).join("\n");

      return await interaction.reply({ content: "🕒 **Last Seen**\n" + text, ephemeral: true });
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