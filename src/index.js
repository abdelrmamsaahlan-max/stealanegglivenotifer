import "dotenv/config";
import express from "express";
import crypto from "node:crypto";
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags
} from "discord.js";
import { extractMessageData, parseSpawn } from "./parser.js";

const app = express();

app.use(express.json({
  limit: "32kb",
  verify: (req, _res, buffer) => {
    req.rawBody = buffer.toString("utf8");
  }
}));

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const DEV_GUILD_ID = process.env.DISCORD_DEV_GUILD_ID || "";
const COMMANDS = [
  new SlashCommandBuilder().setName("ping").setDescription("Check if the notifier is online."),
  new SlashCommandBuilder().setName("status").setDescription("Show live monitor and configuration status."),
  new SlashCommandBuilder().setName("testegg").setDescription("Send a test egg alert to the configured alert channel."),
  new SlashCommandBuilder().setName("lastseen").setDescription("Show recently detected rare eggs."),
  new SlashCommandBuilder()
    .setName("testrole")
    .setDescription("Test a rarity role mention.")
    .addStringOption(option =>
      option
        .setName("rarity")
        .setDescription("Which rarity role to test.")
        .setRequired(true)
        .addChoices(
          { name: "Secret", value: "secret" },
          { name: "Eternal", value: "eternal" },
          { name: "Divine", value: "divine" }
        )
    ),
  new SlashCommandBuilder().setName("stats").setDescription("Show notifier performance statistics."),
  new SlashCommandBuilder().setName("reload").setDescription("Refresh notifier caches and Discord command registration.")
].map(command => command.toJSON());

const PORT = Number(process.env.PORT || 3000);
const SECRET = process.env.INGEST_SHARED_SECRET || "";
const CHANNEL_ID = process.env.DISCORD_DEFAULT_CHANNEL_ID || "";
const MONITOR_ENABLED = (process.env.SOURCE_MONITOR_ENABLED || "true").toLowerCase() === "true";

const RARITIES = new Set(
  (process.env.ALERT_RARITIES || "Secret,Eternal,Divine")
    .split(",")
    .map(value => value.trim().toLowerCase())
    .filter(Boolean)
);

const SOURCE_CHANNEL_IDS = new Set(
  (process.env.DISCORD_SOURCE_CHANNEL_IDS || "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean)
);

const SOURCE_BOT_IDS = new Set(
  (process.env.DISCORD_SOURCE_BOT_IDS || "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean)
);

const SEMANTIC_DEDUP_WINDOW_MS =
  Math.max(1, Number(process.env.SEMANTIC_DEDUP_SECONDS || 8)) * 1000;

const SEEN_TTL_MS =
  Math.max(60, Number(process.env.SEEN_TTL_SECONDS || 900)) * 1000;

const SOURCE_STALE_AFTER_MS =
  Math.max(30, Number(process.env.SOURCE_STALE_AFTER_SECONDS || 180)) * 1000;


const LIVE_FEED_ENABLED =
  (process.env.LIVE_FEED_ENABLED || "true").toLowerCase() === "true";

const LIVE_FEED_URLS = [
  ...(process.env.LIVE_FEED_URLS || "").split(","),
  process.env.LIVE_FEED_URL || "",
  "https://eggwatcher.com/api/mobile-sync",
  "https://eggwatcher.com/mobile-sync"
]
  .map(value => value.trim())
  .filter(Boolean)
  .filter((value, index, array) => array.indexOf(value) === index);

const LIVE_FEED_POLL_MS =
  Math.max(1000, Number(process.env.LIVE_FEED_POLL_MS || 2000));

const LIVE_FEED_TIMEOUT_MS =
  Math.max(1000, Number(process.env.LIVE_FEED_TIMEOUT_MS || 5000));

const LIVE_FEED_MAX_AGE_MS =
  Math.max(60, Number(process.env.LIVE_FEED_MAX_AGE_SECONDS || 600)) * 1000;

const API_RATE_LIMIT_PER_MINUTE =
  Math.max(1, Number(process.env.INGEST_RATE_LIMIT_PER_MINUTE || 120));

const MAX_INGEST_SKEW_SECONDS =
  Math.max(0, Number(process.env.INGEST_MAX_SKEW_SECONDS || 60));

const requestedMentionMode =
  (process.env.ALERT_MENTION_MODE || "role").toLowerCase();
const ALERT_MENTION_MODE = ["none", "role", "here"].includes(requestedMentionMode)
  ? requestedMentionMode
  : "role";

const ALERT_EMOJIS = {
  secret: process.env.ALERT_EMOJI_SECRET || "🥚",
  eternal: process.env.ALERT_EMOJI_ETERNAL || "🥚",
  divine: process.env.ALERT_EMOJI_DIVINE || "🥚"
};

const ALERT_ROLE_IDS = {
  secret: process.env.ALERT_SECRET_ROLE_ID || "",
  eternal: process.env.ALERT_ETERNAL_ROLE_ID || "",
  divine: process.env.ALERT_DIVINE_ROLE_ID || ""
};

const RARITY_PRIORITY = {
  divine: 3,
  eternal: 2,
  secret: 1
};

const seen = new Map();
const alertedMessageIds = new Map();
const recentSpawns = [];
const apiRate = new Map();
const inFlightKeys = new Set();

let alertChannel = null;
let detectedCount = 0;
let alertCount = 0;
let lastSpawnAt = null;
let lastAlertLatencyMs = null;
let totalLatencyMs = 0;
let latencySamples = 0;
let monitorErrors = 0;
let lastSourceMessageAt = null;
let lastSourceMessageId = null;

let liveFeedLastFingerprint = null;
let liveFeedLastEventAt = null;
let liveFeedLastUrl = null;
let liveFeedLastPollAt = null;
let liveFeedEventsReceived = 0;
let liveFeedEventsAccepted = 0;
let liveFeedErrors = 0;
let liveFeedPrimed = false;

function parseTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value;
    const date = new Date(ms);
    return Number.isFinite(date.getTime()) ? date : null;
  }

  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && /^\d{10,13}$/.test(value.trim())) {
      const ms = numeric < 1e12 ? numeric * 1000 : numeric;
      const date = new Date(ms);
      return Number.isFinite(date.getTime()) ? date : null;
    }

    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }

  return null;
}

function normalizeFeedKey(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function collectEggCandidates(value, path = [], out = []) {
  if (!value || typeof value !== "object") return out;

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      collectEggCandidates(value[i], [...path, String(i)], out);
    }
    return out;
  }

  const keys = Object.keys(value);
  const lower = new Map(keys.map(key => [key.toLowerCase(), key]));

  const get = (...names) => {
    for (const name of names) {
      const real = lower.get(name.toLowerCase());
      if (real != null && value[real] != null) return value[real];
    }
    return null;
  };

  const eggName = get(
    "displayName", "eggName", "egg", "itemName", "item", "name", "title"
  );

  const rarity = get("rarity", "tier", "rarityName");
  const area = get("spawnArea", "area", "location", "biome", "zone", "world", "place");
  const spawnedAt = get(
    "spawnedAt", "spawned_at", "detectedAt", "detected_at",
    "timestamp", "time", "createdAt", "created_at", "date"
  );

  if (typeof eggName === "string" && typeof rarity === "string") {
    const rarityKey = rarity.trim().toLowerCase();
    if (["secret", "eternal", "divine"].includes(rarityKey)) {
      const parsedTime = parseTimestamp(spawnedAt);
      const pathText = path.join(".").toLowerCase();
      let score = 0;

      for (const marker of [
        "latest", "current", "confirmed", "latestconfirmed",
        "latestegg", "currentegg", "lastspawn", "recent", "feed"
      ]) {
        if (pathText.includes(marker)) score += 5;
      }

      if (parsedTime) score += 10;
      if (typeof area === "string" && area.trim()) score += 2;

      out.push({
        eggName: eggName.trim(),
        rarity: rarityKey[0].toUpperCase() + rarityKey.slice(1),
        biome: typeof area === "string" && area.trim() ? area.trim() : "Unknown",
        spawnedAt: parsedTime ? parsedTime.toISOString() : null,
        score,
        path: path.join(".")
      });
    }
  }

  for (const key of keys) {
    collectEggCandidates(value[key], [...path, key], out);
  }

  return out;
}

function pickLatestEggFromFeed(payload) {
  const candidates = collectEggCandidates(payload);
  if (!candidates.length) return null;

  candidates.sort((a, b) => {
    const aTime = a.spawnedAt ? Date.parse(a.spawnedAt) : 0;
    const bTime = b.spawnedAt ? Date.parse(b.spawnedAt) : 0;
    if (b.score !== a.score) return b.score - a.score;
    return bTime - aTime;
  });

  return candidates[0];
}

function feedStateLooksOffline(payload) {
  try {
    const json = JSON.stringify(payload).toLowerCase();

    const explicitOffline =
      /"watcher(?:status|_status|state)"\s*:\s*"(?:offline|disconnected|stopped)"/i.test(json) ||
      /"watcheronline"\s*:\s*false/i.test(json) ||
      /"connected"\s*:\s*false/i.test(json);

    return explicitOffline;
  } catch {
    return false;
  }
}

function parseEggWatchHtml(html) {
  const text = String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  const rarityMatch = text.match(/\b(Secret|Eternal|Divine)\b/i);
  if (!rarityMatch) return null;

  const rarity = rarityMatch[1];
  const eggMatch =
    text.match(new RegExp("\\b" + rarity + "\\s+(?:Egg\\s+)?([^•|]+?)(?=Spawn area|Spawned|Detected|AUTO-CONFIRMED|$)", "i")) ||
    text.match(/LATEST CONFIRMED EGG\s+([^•|]+?)(?=Spawn area|Spawned|Detected|AUTO-CONFIRMED|$)/i);

  const areaMatch = text.match(/Spawn area\s*[:]?\s*([^•|]+?)(?=Spawned|Detected|AUTO-CONFIRMED|$)/i);
  const timeMatch = text.match(/(?:Detected|Spawned)\s+([0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?\s*[AP]M)/i);

  if (!eggMatch?.[1]) return null;

  const now = new Date();
  let spawnedAt = null;
  if (timeMatch?.[1]) {
    const parsed = new Date(now.toDateString() + " " + timeMatch[1]);
    if (Number.isFinite(parsed.getTime())) spawnedAt = parsed.toISOString();
  }

  return {
    eggName: eggMatch[1].replace(/\s+/g, " ").trim(),
    rarity: rarity[0].toUpperCase() + rarity.slice(1).toLowerCase(),
    biome: areaMatch?.[1]?.replace(/\s+/g, " ").trim() || "Unknown",
    spawnedAt,
    score: 1,
    path: "html"
  };
}

async function fetchLiveFeed(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LIVE_FEED_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "accept": "application/json,text/plain,text/html;q=0.9,*/*;q=0.8",
        "user-agent": "FSMM-SAB-Live-Notifier/2.1"
      },
      signal: controller.signal
    });

    const body = await response.text();
    return { response, body };
  } finally {
    clearTimeout(timeout);
  }
}

async function pollEggWatch() {
  if (!LIVE_FEED_ENABLED || !LIVE_FEED_URLS.length) return;

  liveFeedLastPollAt = new Date().toISOString();

  for (const url of LIVE_FEED_URLS) {
    try {
      const { response, body } = await fetchLiveFeed(url);

      if (!response.ok) {
        continue;
      }

      let payload = body;
      const contentType = response.headers.get("content-type") || "";

      if (contentType.includes("application/json")) {
        try {
          payload = JSON.parse(body);
        } catch {
          payload = body;
        }
      } else {
        try {
          payload = JSON.parse(body);
        } catch {
          // Keep HTML/text for the fallback parser below.
        }
      }

      const candidate =
        typeof payload === "string"
          ? parseEggWatchHtml(payload)
          : pickLatestEggFromFeed(payload);

      if (!candidate || !candidate.eggName || !candidate.spawnedAt) {
        liveFeedLastUrl = url;
        continue;
      }

      liveFeedEventsReceived++;
      liveFeedLastUrl = url;
      liveFeedLastEventAt = candidate.spawnedAt;

      const eventTime = Date.parse(candidate.spawnedAt);
      if (!Number.isFinite(eventTime)) continue;

      const fingerprint = [
        normalizeFeedKey(candidate.eggName),
        normalizeFeedKey(candidate.rarity),
        normalizeFeedKey(candidate.biome),
        candidate.spawnedAt
      ].join("|");

      if (!liveFeedPrimed) {
        liveFeedPrimed = true;
        liveFeedLastFingerprint = fingerprint;
        console.log(
          "EggWatch feed primed:",
          candidate.rarity,
          candidate.eggName,
          "area=" + candidate.biome,
          "spawnedAt=" + candidate.spawnedAt,
          "url=" + url
        );
        return;
      }

      if (fingerprint === liveFeedLastFingerprint) return;

      liveFeedLastFingerprint = fingerprint;

      const ageMs = Date.now() - eventTime;
      if (ageMs < -60_000 || ageMs > LIVE_FEED_MAX_AGE_MS) {
        console.log(
          "EggWatch feed changed but event is stale:",
          candidate.rarity,
          candidate.eggName,
          "ageMs=" + ageMs
        );
        return;
      }

      if (feedStateLooksOffline(payload)) {
        console.log("EggWatch feed changed while watcher is explicitly offline; skipping alert.");
        return;
      }

      const event = {
        live: true,
        eggName: candidate.eggName,
        displayName: candidate.eggName,
        rarity: candidate.rarity,
        biome: candidate.biome || "Unknown",
        spawnedAt: candidate.spawnedAt,
        source: "EggWatch Global Feed"
      };

      try {
        const existingKey = [
          event.rarity.toLowerCase(),
          normalizeFeedKey(event.eggName),
          normalizeFeedKey(event.biome)
        ].join("|");

        const previousSeen = seen.get(existingKey) || 0;
        const now = Date.now();

        if (now - previousSeen < SEMANTIC_DEDUP_WINDOW_MS) {
          return;
        }

        seen.set(existingKey, now);
        inFlightKeys.add(existingKey);

        await sendAlert(event, ageMs >= 0 ? ageMs : null);
        liveFeedEventsAccepted++;

        console.log(
          "Forwarded EggWatch feed event:",
          existingKey,
          "latencyMs=" + (ageMs >= 0 ? ageMs : "unknown")
        );
      } catch (error) {
        liveFeedErrors++;
        console.error("EggWatch alert forwarding failed:", error);
      } finally {
        inFlightKeys.delete([
          event.rarity.toLowerCase(),
          normalizeFeedKey(event.eggName),
          normalizeFeedKey(event.biome)
        ].join("|"));
      }

      return;
    } catch (error) {
      liveFeedErrors++;
      console.error("EggWatch feed poll failed:", url, error?.message || error);
    }
  }
}

function startEggWatchPoller() {
  if (!LIVE_FEED_ENABLED) {
    console.log("EggWatch direct feed: disabled.");
    return;
  }

  console.log(
    "EggWatch direct feed enabled. Candidate URLs:",
    LIVE_FEED_URLS.join(", ")
  );

  pollEggWatch().catch(error => {
    liveFeedErrors++;
    console.error("Initial EggWatch poll failed:", error);
  });

  setInterval(() => {
    pollEggWatch().catch(error => {
      liveFeedErrors++;
      console.error("EggWatch poll cycle failed:", error);
    });
  }, LIVE_FEED_POLL_MS);
}

function getRarityEmoji(rarity) {
  return ALERT_EMOJIS[String(rarity || "").toLowerCase()] || "🥚";
}

function rarityPriority(rarity) {
  return RARITY_PRIORITY[String(rarity || "").toLowerCase()] || 0;
}

function sourceHealth() {
  if (!SOURCE_CHANNEL_IDS.size) return "UNFILTERED";
  if (!lastSourceMessageAt) return "WAITING";
  return Date.now() - new Date(lastSourceMessageAt).getTime() > SOURCE_STALE_AFTER_MS
    ? "STALE"
    : "ACTIVE";
}

function cleanupCaches(now = Date.now()) {
  for (const [key, timestamp] of seen) {
    if (now - timestamp > SEEN_TTL_MS) seen.delete(key);
  }

  for (const [key, timestamp] of alertedMessageIds) {
    if (now - timestamp > SEEN_TTL_MS) alertedMessageIds.delete(key);
  }

  for (const [key, timestamps] of apiRate) {
    const fresh = timestamps.filter(timestamp => now - timestamp < 60_000);
    if (fresh.length) apiRate.set(key, fresh);
    else apiRate.delete(key);
  }
}

function rateLimitKey(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length) {
    return forwarded.split(",")[0].trim();
  }
  return req.ip || "unknown";
}

function consumeApiRateLimit(key) {
  const now = Date.now();
  const timestamps = (apiRate.get(key) || []).filter(timestamp => now - timestamp < 60_000);

  if (timestamps.length >= API_RATE_LIMIT_PER_MINUTE) {
    apiRate.set(key, timestamps);
    return false;
  }

  timestamps.push(now);
  apiRate.set(key, timestamps);
  return true;
}

function verifyRequest(req) {
  const supplied = req.header("x-live-signature") || "";
  if (!SECRET || supplied.length !== 64) return false;

  const body = req.rawBody || JSON.stringify(req.body || {});
  const expected = crypto.createHmac("sha256", SECRET).update(body).digest("hex");

  return crypto.timingSafeEqual(
    Buffer.from(supplied, "utf8"),
    Buffer.from(expected, "utf8")
  );
}

function isLiveEvent(value) {
  if (!value || value.live !== true) return false;
  if (typeof value.eggName !== "string") return false;
  if (typeof value.rarity !== "string") return false;
  if (typeof value.spawnedAt !== "string") return false;

  const rarity = value.rarity.toLowerCase();
  if (!RARITIES.has(rarity)) return false;

  const timestamp = Date.parse(value.spawnedAt);
  if (!Number.isFinite(timestamp)) return false;

  if (MAX_INGEST_SKEW_SECONDS > 0) {
    const ageSeconds = Math.abs(Date.now() - timestamp) / 1000;
    if (ageSeconds > MAX_INGEST_SKEW_SECONDS) return false;
  }

  return true;
}

async function getAlertChannel() {
  if (alertChannel?.isTextBased()) return alertChannel;
  if (!CHANNEL_ID) throw new Error("DISCORD_DEFAULT_CHANNEL_ID is not configured");

  const channel = await client.channels.fetch(CHANNEL_ID);
  if (!channel || !channel.isTextBased()) throw new Error("channel_unavailable");

  alertChannel = channel;
  return channel;
}

async function validateAlertRoles() {
  if (!alertChannel?.guild) return;

  for (const [rarity, roleId] of Object.entries(ALERT_ROLE_IDS)) {
    if (!roleId) {
      console.warn("No alert role configured for", rarity);
      continue;
    }

    try {
      const role = await alertChannel.guild.roles.fetch(roleId);

      if (!role) {
        console.warn("Configured role not found:", rarity, roleId);
      } else if (!role.mentionable) {
        console.warn("Configured role is not mentionable:", rarity, role.name);
      } else {
        console.log("Alert role ready:", rarity, role.name);
      }
    } catch (error) {
      console.error("Alert role validation failed for " + rarity + ":", error);
    }
  }
}

function buildAlertEmbed(event, latencyMs = null, includeImage = true) {
  const rarity = String(event.rarity || "Unknown").trim();
  const rarityKey = rarity.toLowerCase();
  const emoji = getRarityEmoji(rarity);
  const eggName = String(event.displayName || event.eggName || "Unknown Egg").trim();
  const area = String(event.biome || "Unknown").trim();

  const timestamp = Date.parse(event.spawnedAt);
  const unix = Number.isFinite(timestamp)
    ? Math.floor(timestamp / 1000)
    : Math.floor(Date.now() / 1000);

  const fields = [
    { name: "🥚 Egg", value: eggName.slice(0, 1024), inline: true },
    { name: "✨ Rarity", value: rarity.slice(0, 1024), inline: true },
    { name: "📍 Area", value: area.slice(0, 1024), inline: true },
    { name: "🕒 Spawned", value: "<t:" + unix + ":R>", inline: true }
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
    if (value) {
      fields.push({
        name,
        value: String(value).slice(0, 1024),
        inline: true
      });
    }
  }

  if (Number.isFinite(latencyMs) && latencyMs >= 0) {
    fields.push({
      name: "⚡ Detection",
      value: latencyMs < 1000
        ? latencyMs + "ms"
        : (latencyMs / 1000).toFixed(1) + "s",
      inline: true
    });
  }

  const embed = new EmbedBuilder()
    .setColor(
      {
        secret: 0x7c3aed,
        eternal: 0xf59e0b,
        divine: 0xef4444
      }[rarityKey] || 0x5865f2
    )
    .setTitle(emoji + "  " + rarity.toUpperCase() + " EGG SPAWNED!")
    .setDescription("**" + eggName.slice(0, 200) + "** has just appeared.")
    .addFields(fields)
    .setFooter({ text: "Steal an Egg • Rare Spawn Alert" })
    .setTimestamp(Number.isFinite(timestamp) ? new Date(timestamp) : new Date());

  if (includeImage && event.imageUrl) embed.setImage(event.imageUrl);

  return embed;
}

function buildActionRow(event) {
  const buttons = [];

  if (event.joinUrl) {
    buttons.push(
      new ButtonBuilder()
        .setLabel("Join Game")
        .setStyle(ButtonStyle.Link)
        .setURL(event.joinUrl)
    );
  }

  if (event.messageUrl) {
    buttons.push(
      new ButtonBuilder()
        .setLabel("View Spawn")
        .setStyle(ButtonStyle.Link)
        .setURL(event.messageUrl)
    );
  }

  if (!buttons.length) return null;

  return new ActionRowBuilder().addComponents(...buttons.slice(0, 5));
}

async function sendAlert(event, latencyMs = null) {
  const channel = await getAlertChannel();
  const rarity = String(event.rarity || "Unknown").trim();
  const rarityKey = rarity.toLowerCase();
  const roleId = ALERT_ROLE_IDS[rarityKey];
  const emoji = getRarityEmoji(rarity);

  const mentionContent =
    ALERT_MENTION_MODE === "role" && roleId
      ? "<@&" + roleId + "> " + emoji + " **" + rarity.toUpperCase() + " EGG!**"
      : ALERT_MENTION_MODE === "here"
        ? "@here " + emoji + " **" + rarity.toUpperCase() + " EGG!**"
        : emoji + " **" + rarity.toUpperCase() + " EGG!**";

  const payload = {
    content: mentionContent,
    embeds: [buildAlertEmbed(event, latencyMs, true)],
    allowedMentions: {
      parse: ALERT_MENTION_MODE === "here" ? ["everyone"] : [],
      roles: ALERT_MENTION_MODE === "role" && roleId ? [roleId] : []
    }
  };

  const row = buildActionRow(event);
  if (row) payload.components = [row];

  try {
    await channel.send(payload);
  } catch (firstError) {
    console.error("Primary alert send failed:", firstError);
    alertChannel = null;

    const freshChannel = await getAlertChannel();

    if (event.imageUrl) {
      payload.embeds = [buildAlertEmbed(event, latencyMs, false)];
    }

    await freshChannel.send(payload);
  }

  alertCount++;
  lastSpawnAt = event.spawnedAt;
  lastAlertLatencyMs = Number.isFinite(latencyMs) ? latencyMs : null;

  if (Number.isFinite(latencyMs) && latencyMs >= 0) {
    totalLatencyMs += latencyMs;
    latencySamples++;
  }

  recentSpawns.unshift({
    eggName: event.displayName || event.eggName || "Unknown Egg",
    rarity,
    area: event.biome || "Unknown",
    at: event.spawnedAt,
    imageUrl: event.imageUrl || null,
    priority: rarityPriority(rarity),
    messageUrl: event.messageUrl || null
  });

  if (recentSpawns.length > 25) recentSpawns.length = 25;
}

async function processSpawnMessage(message) {
  if (!MONITOR_ENABLED || !message) return;
  if (message.author?.id === client.user?.id) return;
  if (SOURCE_CHANNEL_IDS.size && !SOURCE_CHANNEL_IDS.has(message.channelId)) return;
  if (SOURCE_BOT_IDS.size && !SOURCE_BOT_IDS.has(message.author?.id)) return;

  lastSourceMessageAt = new Date(message.createdTimestamp || Date.now()).toISOString();
  lastSourceMessageId = message.id || null;

  const messageData = extractMessageData(message);
  const event = parseSpawn(messageData, RARITIES);
  if (!event) return;

  event.spawnedAt = new Date(messageData.createdTimestamp || Date.now()).toISOString();
  if (messageData.imageUrl) event.imageUrl = messageData.imageUrl;
  if (messageData.messageUrl) event.messageUrl = messageData.messageUrl;

  detectedCount++;

  const now = Date.now();
  cleanupCaches(now);

  if (alertedMessageIds.has(message.id)) return;

  const semanticKey = [
    event.rarity.toLowerCase(),
    event.eggName.toLowerCase(),
    event.biome.toLowerCase()
  ].join("|");

  if (inFlightKeys.has(semanticKey)) return;

  const previousSeen = seen.get(semanticKey) || 0;
  if (now - previousSeen < SEMANTIC_DEDUP_WINDOW_MS) return;

  inFlightKeys.add(semanticKey);
  seen.set(semanticKey, now);
  alertedMessageIds.set(message.id, now);

  const latencyMs = messageData.createdTimestamp
    ? Math.max(0, now - messageData.createdTimestamp)
    : null;

  try {
    await sendAlert(event, latencyMs);

    console.log(
      "Forwarded live egg spawn:",
      semanticKey,
      "priority=" + rarityPriority(event.rarity),
      "latencyMs=" + (latencyMs ?? "unknown")
    );
  } catch (error) {
    monitorErrors++;
    alertedMessageIds.delete(message.id);
    seen.delete(semanticKey);
    console.error("Live source forwarding failed:", error);
  } finally {
    inFlightKeys.delete(semanticKey);
  }
}

function safeRun(promise, context) {
  Promise.resolve(promise).catch(error => {
    monitorErrors++;
    console.error(context + " failed:", error);
  });
}

client.on("messageCreate", message => {
  safeRun(processSpawnMessage(message), "messageCreate processing");
});

client.on("messageUpdate", async (_oldMessage, newMessage) => {
  if (alertedMessageIds.has(newMessage.id)) return;

  try {
    if (!newMessage.author || !newMessage.embeds?.length) {
      await newMessage.fetch().catch(() => newMessage);
    }

    await processSpawnMessage(newMessage);
  } catch (error) {
    monitorErrors++;
    console.error("messageUpdate processing failed:", error);
  }
});

app.get("/", (_req, res) => {
  res.json({
    service: "Steal An Egg Live Notifier",
    status: client.isReady() ? "online" : "starting"
  });
});

app.get("/health", (_req, res) => {
  const ready = client.isReady();

  res.status(ready ? 200 : 503).json({
    ok: ready,
    botReady: ready,
    sourceMonitorEnabled: MONITOR_ENABLED,
    apiIngestConfigured: Boolean(SECRET),
    alertChannelConfigured: Boolean(CHANNEL_ID),
    alertChannelCached: Boolean(alertChannel),
    sourceChannelFilterConfigured: SOURCE_CHANNEL_IDS.size > 0,
    sourceBotFilterConfigured: SOURCE_BOT_IDS.size > 0,
    sourceHealth: sourceHealth(),
    lastSourceMessageAt,
    lastSourceMessageId,
    detectedCount,
    alertCount,
    lastSpawnAt,
    lastAlertLatencyMs,
    averageAlertLatencyMs: latencySamples
      ? Math.round(totalLatencyMs / latencySamples)
      : null,
    monitorErrors,
    cacheSize: seen.size,
    recentSpawns: recentSpawns.length,
    liveFeedEnabled: LIVE_FEED_ENABLED,
    liveFeedLastUrl,
    liveFeedLastPollAt,
    liveFeedLastEventAt,
    liveFeedEventsReceived,
    liveFeedEventsAccepted,
    liveFeedErrors
  });
});

app.post("/api/notify-egg", async (req, res) => {
  const key = rateLimitKey(req);
  cleanupCaches();

  if (!consumeApiRateLimit(key)) {
    return res.status(429).json({ error: "rate_limited" });
  }

  if (!verifyRequest(req)) {
    return res.status(401).json({ error: "invalid_signature" });
  }

  if (!isLiveEvent(req.body)) {
    return res.status(400).json({ error: "invalid_live_event" });
  }

  try {
    await sendAlert(req.body);
    return res.json({ accepted: true });
  } catch (error) {
    monitorErrors++;
    console.error("API alert failed:", error);
    return res.status(500).json({ error: "discord_send_failed" });
  }
});

client.once("clientReady", async () => {
  console.log("Steal An Egg notifier online as " + client.user.tag);
  console.log("Live source monitor:", MONITOR_ENABLED ? "enabled" : "disabled");
  console.log("Configured rarities:", [...RARITIES].join(", "));
  console.log("Source channel filters:", SOURCE_CHANNEL_IDS.size || "none");
  console.log("Source bot filters:", SOURCE_BOT_IDS.size || "none");
  console.log("Alert mention mode:", ALERT_MENTION_MODE);
  console.log("Semantic dedup window:", SEMANTIC_DEDUP_WINDOW_MS / 1000 + "s");
  console.log("Source stale threshold:", SOURCE_STALE_AFTER_MS / 1000 + "s");

  if (CHANNEL_ID) {
    try {
      alertChannel = await client.channels.fetch(CHANNEL_ID);
      console.log("Alert channel cached.");
      await validateAlertRoles();
    } catch (error) {
      console.error("Alert channel preload failed:", error);
    }
  }

  try {
    const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_BOT_TOKEN);

    if (DEV_GUILD_ID) {
      await rest.put(
        Routes.applicationGuildCommands(client.user.id, DEV_GUILD_ID),
        { body: COMMANDS }
      );
      console.log("Slash commands registered in development guild.");
    } else {
      await rest.put(
        Routes.applicationCommands(client.user.id),
        { body: COMMANDS }
      );
      console.log("Slash commands registered globally.");
    }
  } catch (error) {
    console.error("Slash command registration failed:", error);
  }
});

setInterval(() => {
  cleanupCaches();
}, 60_000);

startEggWatchPoller();

setInterval(() => {
  console.log(
    "Heartbeat:",
    "ready=" + client.isReady(),
    "source=" + sourceHealth(),
    "detected=" + detectedCount,
    "alerts=" + alertCount,
    "errors=" + monitorErrors,
    "avgLatencyMs=" + (latencySamples
      ? Math.round(totalLatencyMs / latencySamples)
      : "N/A")
  );
}, 60_000);

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  try {
    if (interaction.commandName === "ping") {
      const ping = Math.max(0, Math.round(client.ws.ping));

      return await interaction.reply({
        content: "🏓 Pong — notifier is online.\n⚡ WebSocket: " + ping + "ms"
      });
    }

    if (interaction.commandName === "status") {
      const status = [
        "🤖 Bot: " + (client.isReady() ? "ONLINE" : "NOT READY"),
        "📡 Live monitor: " + (MONITOR_ENABLED ? "ENABLED" : "DISABLED"),
        "🎯 Rarities: " + [...RARITIES].join(", "),
        "📥 Source channel: " + (SOURCE_CHANNEL_IDS.size ? [...SOURCE_CHANNEL_IDS].join(", ") : "ALL"),
        "📤 Alert channel: " + (CHANNEL_ID ? "CONFIGURED" : "NOT CONFIGURED"),
        "🔔 Role ping: " + ALERT_MENTION_MODE.toUpperCase(),
        "📡 Source health: " + sourceHealth(),
        "🥚 Alerts sent: " + alertCount,
        "🔎 Detected: " + detectedCount,
        "⚡ Average latency: " + (latencySamples
          ? Math.round(totalLatencyMs / latencySamples) + "ms"
          : "N/A"),
        "🛠️ Errors: " + monitorErrors,
        "🟣 Secret role: " + (ALERT_ROLE_IDS.secret ? "SET" : "NOT SET"),
        "🟠 Eternal role: " + (ALERT_ROLE_IDS.eternal ? "SET" : "NOT SET"),
        "🔴 Divine role: " + (ALERT_ROLE_IDS.divine ? "SET" : "NOT SET")
      ].join("\n");

      return await interaction.reply({
        content: status,
        flags: MessageFlags.Ephemeral
      });
    }

    if (interaction.commandName === "lastseen") {
      if (!recentSpawns.length) {
        return await interaction.reply({
          content: "📭 No rare egg has been detected yet.",
          flags: MessageFlags.Ephemeral
        });
      }

      const text = recentSpawns.slice(0, 10).map(item =>
        getRarityEmoji(item.rarity) +
        " **" + item.eggName + "** • " +
        item.rarity +
        " • 📍 " + item.area +
        " • <t:" + Math.floor(new Date(item.at).getTime() / 1000) + ":R>"
      ).join("\n");

      return await interaction.reply({
        content: "🕒 **Last Seen**\n" + text,
        flags: MessageFlags.Ephemeral
      });
    }

    if (interaction.commandName === "stats") {
      const uptimeSeconds = Math.floor(process.uptime());
      const hours = Math.floor(uptimeSeconds / 3600);
      const minutes = Math.floor((uptimeSeconds % 3600) / 60);

      return await interaction.reply({
        content: [
          "📊 **Notifier Stats**",
          "🥚 Alerts sent: " + alertCount,
          "🔎 Spawns detected: " + detectedCount,
          "⚡ Avg latency: " + (latencySamples
            ? Math.round(totalLatencyMs / latencySamples) + "ms"
            : "N/A"),
          "🛠️ Errors: " + monitorErrors,
          "📡 Source: " + sourceHealth(),
          "⏱️ Uptime: " + hours + "h " + minutes + "m",
          "💾 Cache: " + seen.size
        ].join("\n"),
        flags: MessageFlags.Ephemeral
      });
    }

    if (interaction.commandName === "reload") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      seen.clear();
      alertedMessageIds.clear();
      inFlightKeys.clear();
      alertChannel = null;

      if (CHANNEL_ID) {
        await getAlertChannel();
        await validateAlertRoles();
      }

      const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_BOT_TOKEN);

      if (DEV_GUILD_ID) {
        await rest.put(
          Routes.applicationGuildCommands(client.user.id, DEV_GUILD_ID),
          { body: COMMANDS }
        );
      } else {
        await rest.put(
          Routes.applicationCommands(client.user.id),
          { body: COMMANDS }
        );
      }

      return await interaction.editReply({
        content: "✅ Notifier caches refreshed and commands reloaded."
      });
    }

    if (interaction.commandName === "testrole") {
      const rarity = interaction.options.getString("rarity", true);
      const roleId = ALERT_ROLE_IDS[rarity];

      if (!CHANNEL_ID) {
        return await interaction.reply({
          content: "❌ Alert channel is not configured.",
          flags: MessageFlags.Ephemeral
        });
      }

      if (!roleId) {
        return await interaction.reply({
          content: "⚠️ " + rarity[0].toUpperCase() + rarity.slice(1) + " role ID is not configured.",
          flags: MessageFlags.Ephemeral
        });
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const channel = await getAlertChannel();

      await channel.send({
        content: "<@&" + roleId + "> " +
          getRarityEmoji(rarity) +
          " **" + rarity.toUpperCase() + " ROLE TEST**",
        allowedMentions: { roles: [roleId] }
      });

      return await interaction.editReply({
        content: "✅ " + rarity[0].toUpperCase() + rarity.slice(1) + " role mention sent."
      });
    }

    if (interaction.commandName === "testegg") {
      if (!CHANNEL_ID) {
        return await interaction.reply({
          content: "❌ DISCORD_DEFAULT_CHANNEL_ID is not configured.",
          flags: MessageFlags.Ephemeral
        });
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const beforeAlerts = alertCount;
      const beforeLastSpawn = lastSpawnAt;

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

      alertCount = beforeAlerts;
      lastSpawnAt = beforeLastSpawn;
      recentSpawns.shift();

      return await interaction.editReply({
        content: "✅ Test egg alert sent successfully."
      });
    }
  } catch (error) {
    console.error("Interaction failed:", error);

    if (interaction.deferred) {
      await interaction.editReply({
        content: "❌ Command failed: " + (error?.message || "unknown error")
      }).catch(() => {});
    } else if (interaction.replied) {
      await interaction.followUp({
        content: "❌ Command failed: " + (error?.message || "unknown error"),
        flags: MessageFlags.Ephemeral
      }).catch(() => {});
    } else {
      await interaction.reply({
        content: "❌ Command failed: " + (error?.message || "unknown error"),
        flags: MessageFlags.Ephemeral
      }).catch(() => {});
    }
  }
});

client.on("error", error => console.error("Discord client error:", error));
client.on("shardError", error => console.error("Discord shard error:", error));

process.on("unhandledRejection", error => {
  monitorErrors++;
  console.error("Unhandled rejection:", error);
});

process.on("uncaughtException", error => {
  monitorErrors++;
  console.error("Uncaught exception:", error);
});

async function shutdown(signal) {
  console.log("Received " + signal + ", shutting down gracefully...");
  client.destroy();
  process.exit(0);
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));

if (!process.env.DISCORD_BOT_TOKEN) {
  console.error("DISCORD_BOT_TOKEN is missing.");
} else {
  client.login(process.env.DISCORD_BOT_TOKEN).catch(error => {
    console.error("Discord login failed:", error);
    process.exitCode = 1;
  });
}

app.listen(PORT, () => console.log("HTTP server listening on " + PORT));
