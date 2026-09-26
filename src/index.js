import "dotenv/config";
import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
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
import {
  buildRiftActionRow,
  buildRiftAlertEmbed,
  getRiftData,
  parseRiftChange,
  riftBannerChoices
} from "./rift-tracker.js";

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
  new SlashCommandBuilder()
    .setName("bot-status")
    .setDescription("View live feed, alerts, Rift, images, roles, memory, uptime, and source status."),
  new SlashCommandBuilder()
    .setName("egg-test")
    .setDescription("Send a sample rare-egg alert to test the embed, image, roles, and Join Game button.")
    .addStringOption(option =>
      option
        .setName("egg")
        .setDescription("Egg or pet name from the verified Secret/Eternal/Divine catalog.")
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName("egg-history")
    .setDescription("View recent rare-egg spawn history with rarity, location, and detection time."),
  new SlashCommandBuilder()
    .setName("game-events")
    .setDescription("View recent detected game events, updates, and automatic catalog discoveries."),
  new SlashCommandBuilder()
    .setName("rift")
    .setDescription("Show the current Rift banner, change times, rotation chance, and possible pets."),
  new SlashCommandBuilder()
    .setName("rift-test")
    .setDescription("Send a sample Rift alert to test the Rift embed and Join Game button.")
    .addStringOption(option =>
      option
        .setName("banner")
        .setDescription("Rift banner to test: Riftborn, Riftbeasts, or Shattered Rift.")
        .setRequired(false)
        .addChoices(...riftBannerChoices())
    ),
  new SlashCommandBuilder()
    .setName("health-check")
    .setDescription("Run a full health check for Discord, EggWatch, Rift, alerts, images, memory, and storage."),
  new SlashCommandBuilder()
    .setName("role-test")
    .setDescription("Admin: send a test mention for a Secret, Eternal, or Divine alert role.")
    .addStringOption(option =>
      option
        .setName("rarity")
        .setDescription("Alert role to test: Secret, Eternal, or Divine.")
        .setRequired(true)
        .addChoices(
          { name: "Secret", value: "secret" },
          { name: "Eternal", value: "eternal" },
          { name: "Divine", value: "divine" }
        )
    ),
  new SlashCommandBuilder()
    .setName("image-check")
    .setDescription("Verify the transparent character image and game data for a specific egg.")
    .addStringOption(option =>
      option
        .setName("egg")
        .setDescription("Egg or pet name to inspect from the verified catalog.")
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("bot-reload")
    .setDescription("Admin: clear runtime caches, refresh image data, reload roles, and sync Discord commands.")
].map(command => command.toJSON());

async function registerDiscordCommands(rest, applicationId) {
  if (DEV_GUILD_ID) {
    await rest.put(
      Routes.applicationGuildCommands(applicationId, DEV_GUILD_ID),
      { body: COMMANDS }
    );

    // Prevent the same commands from being shown twice in the development guild.
    // A guild can inherit global commands, so guild + global registration duplicates them.
    await rest.put(
      Routes.applicationCommands(applicationId),
      { body: [] }
    );

    console.log("Slash commands registered in development guild; global commands cleared.");
    return;
  }

  await rest.put(
    Routes.applicationCommands(applicationId),
    { body: COMMANDS }
  );

  console.log("Slash commands registered globally.");
}
const PORT = Number(process.env.PORT || 3000);
const SECRET = process.env.INGEST_SHARED_SECRET || "";
const CHANNEL_ID = process.env.DISCORD_DEFAULT_CHANNEL_ID || "";
const LAST_SEEN_CHANNEL_ID = process.env.LAST_SEEN_CHANNEL_ID || "";
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
  Math.max(1, Number(process.env.SEMANTIC_DEDUP_SECONDS || 20)) * 1000;

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
  Math.min(800, Math.max(500, Number(process.env.LIVE_FEED_POLL_MS || 800)));

const LIVE_FEED_TIMEOUT_MS =
  Math.max(1000, Number(process.env.LIVE_FEED_TIMEOUT_MS || 5000));

const LIVE_FEED_MAX_AGE_MS =
  Math.max(60, Number(process.env.LIVE_FEED_MAX_AGE_SECONDS || 600)) * 1000;

const LIVE_FEED_STALE_AFTER_MS =
  Math.max(15, Number(process.env.LIVE_FEED_STALE_AFTER_SECONDS || 30)) * 1000;

const AUTO_DISCOVERY_ENABLED =
  (process.env.AUTO_DISCOVERY_ENABLED || "true").toLowerCase() === "true";

const AUTO_DISCOVERY_POLL_MS =
  Math.max(30_000, Number(process.env.AUTO_DISCOVERY_POLL_SECONDS || 120) * 1000);

const EVENT_ALERTS_ENABLED =
  (process.env.EVENT_ALERTS_ENABLED || "true").toLowerCase() === "true";

const RIFT_ALERTS_ENABLED =
  (process.env.RIFT_ALERTS_ENABLED || "true").toLowerCase() === "true";

const RIFT_BOSS_ALERTS_ENABLED =
  (process.env.RIFT_BOSS_ALERTS_ENABLED || "true").toLowerCase() === "true";

const RIFT_SOURCE_CHANNEL_IDS = new Set(
  (process.env.RIFT_SOURCE_CHANNEL_IDS || "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean)
);

const RIFT_SOURCE_BOT_IDS = new Set(
  (process.env.RIFT_SOURCE_BOT_IDS || "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean)
);

const RIFT_ALERT_MENTION_MODE = ["none", "role", "here"].includes(
  String(process.env.RIFT_ALERT_MENTION_MODE || "none").toLowerCase()
)
  ? String(process.env.RIFT_ALERT_MENTION_MODE || "none").toLowerCase()
  : "none";

const RIFT_ALERT_ROLE_ID = process.env.RIFT_ALERT_ROLE_ID || "";
const RIFT_DEDUP_TTL_MS =
  Math.max(30, Number(process.env.RIFT_DEDUP_SECONDS || 10800)) * 1000;

const MEMORY_SOFT_LIMIT_MB =
  Math.max(128, Number(process.env.MEMORY_SOFT_LIMIT_MB || 350));

const MEMORY_HARD_LIMIT_MB =
  Math.max(MEMORY_SOFT_LIMIT_MB + 50, Number(process.env.MEMORY_HARD_LIMIT_MB || 450));

const STATE_FILE = path.resolve(
  process.cwd(),
  "data/runtime-state.json"
);

const AUTO_DISCOVERY_URLS = [
  "https://robloxstealanegg.wiki/",
  "https://eggwatcher.com/guides/how-the-live-feed-works"
];

let autoDiscoveryTimer = null;
let imageWarmupInFlight = false;
let autoDiscoveryLastFingerprint = "";
let autoDiscoveredCount = 0;
let lastUpdateFingerprint = "";
let lastUpdateCheckAt = null;
let lastUpdateTitle = null;
const spawnHistory = [];
const gameEventHistory = [];
const riftHistory = [];
const MAX_HISTORY = 100;
const MAX_EVENT_HISTORY = 30;
const MAX_RIFT_HISTORY = 30;

let riftState = {
  currentBannerKey: null,
  currentBannerName: null,
  changedLabel: null,
  nextChangeLabel: null,
  lastChangedAt: null,
  lastObservedAt: null,
  lastJoinUrl: null,
  lastSourceMessageUrl: null,
  lastBossAt: null,
  lastBossMessageUrl: null
};

const seenRiftAlerts = new Map();

const LAST_SEEN_RARITIES = ["secret", "eternal", "divine"];
const LAST_SEEN_UPDATE_DELAY_MS = 1000;
const LAST_SEEN_RETRY_DELAY_MS = 2000;
const lastSeenByRarity = {
  secret: new Map(),
  eternal: new Map(),
  divine: new Map()
};
const lastSeenMessageIds = {
  secret: null,
  eternal: null,
  divine: null
};
let lastSeenChannel = null;
const lastSeenUpdateTimers = new Map();
const lastSeenUpdateInFlight = new Map();

function loadRuntimeState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;

    const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));

    if (Array.isArray(state.spawnHistory)) {
      spawnHistory.push(...state.spawnHistory.slice(0, MAX_HISTORY));
    }

    if (Array.isArray(state.gameEventHistory)) {
      gameEventHistory.push(...state.gameEventHistory.slice(0, MAX_EVENT_HISTORY));
    }

    if (Array.isArray(state.riftHistory)) {
      riftHistory.push(...state.riftHistory.slice(0, MAX_RIFT_HISTORY));
    }

    if (state.riftState && typeof state.riftState === "object") {
      riftState = { ...riftState, ...state.riftState };
    }

    if (state.lastSeenMessageIds && typeof state.lastSeenMessageIds === "object") {
      for (const rarity of LAST_SEEN_RARITIES) {
        if (typeof state.lastSeenMessageIds[rarity] === "string") {
          lastSeenMessageIds[rarity] = state.lastSeenMessageIds[rarity];
        }
      }
    }

    if (state.lastSeenByRarity && typeof state.lastSeenByRarity === "object") {
      for (const rarity of LAST_SEEN_RARITIES) {
        const entries = state.lastSeenByRarity[rarity];
        if (!entries || typeof entries !== "object") continue;

        for (const [eggKey, record] of Object.entries(entries)) {
          if (
            record &&
            typeof record === "object" &&
            typeof record.eggName === "string" &&
            typeof record.petName === "string" &&
            typeof record.spawnedAt === "string"
          ) {
            lastSeenByRarity[rarity].set(eggKey, {
              eggName: record.eggName,
              petName: record.petName,
              area: record.area || "Unknown",
              spawnedAt: record.spawnedAt,
              detectedAt: record.detectedAt || record.spawnedAt
            });
          }
        }
      }
    }

    if (typeof state.lastUpdateFingerprint === "string") {
      lastUpdateFingerprint = state.lastUpdateFingerprint;
    }

    if (typeof state.lastUpdateTitle === "string") {
      lastUpdateTitle = state.lastUpdateTitle;
    }

    if (Array.isArray(state.dynamicEggs)) {
      for (const entry of state.dynamicEggs.slice(0, 50)) {
        if (
          entry &&
          entry.source === "EggWatch live auto-discovery" &&
          entry.eggName &&
          entry.petName &&
          ["Secret", "Eternal", "Divine"].includes(entry.rarity) &&
          !findCatalogEgg(entry.eggName)
        ) {
          eggImageCatalog.push(entry);
        }
      }
    }

    console.log(
      "Runtime state restored:",
      "spawns=" + spawnHistory.length,
      "events=" + gameEventHistory.length
    );
  } catch (error) {
    console.warn("Runtime state restore failed:", error?.message || error);
  }
}

let stateSaveTimer = null;

function saveRuntimeState() {
  try {
    const stateDir = path.dirname(STATE_FILE);
    fs.mkdirSync(stateDir, { recursive: true });

    const payload = {
      version: 1,
      savedAt: new Date().toISOString(),
      lastUpdateFingerprint,
      lastUpdateTitle,
      spawnHistory: spawnHistory.slice(0, MAX_HISTORY),
      gameEventHistory: gameEventHistory.slice(0, MAX_EVENT_HISTORY),
      riftState,
      riftHistory: riftHistory.slice(0, MAX_RIFT_HISTORY),
      lastSeenMessageIds,
      lastSeenByRarity: Object.fromEntries(
        LAST_SEEN_RARITIES.map(rarity => [
          rarity,
          Object.fromEntries(lastSeenByRarity[rarity])
        ])
      ),
      dynamicEggs: eggImageCatalog
        .filter(entry => entry?.source === "EggWatch live auto-discovery")
        .slice(0, 50)
    };

    const tempFile = STATE_FILE + ".tmp";
    fs.writeFileSync(tempFile, JSON.stringify(payload), "utf8");
    fs.renameSync(tempFile, STATE_FILE);
  } catch (error) {
    console.warn("Runtime state save failed:", error?.message || error);
  }
}

function scheduleStateSave() {
  if (stateSaveTimer) clearTimeout(stateSaveTimer);

  stateSaveTimer = setTimeout(() => {
    stateSaveTimer = null;
    saveRuntimeState();
  }, 1500);
}

function normalizePublicBaseUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  try {
    const withProtocol = /^https?:\/\//i.test(raw) ? raw : "https://" + raw;
    const url = new URL(withProtocol);
    return url.origin.replace(/\/$/, "");
  } catch {
    return "";
  }
}

const PUBLIC_BASE_URL = normalizePublicBaseUrl(
  process.env.PUBLIC_BASE_URL ||
  (process.env.RAILWAY_PUBLIC_DOMAIN ? "https://" + process.env.RAILWAY_PUBLIC_DOMAIN : "")
);

const STEAL_AN_EGG_GAME_URL =
  "https://www.roblox.com/games/107778070777162/Steal-An-Egg";

const SOURCE_IMAGE_ALPHA_ONLY =
  (process.env.SOURCE_IMAGE_ALPHA_ONLY || "true").toLowerCase() === "true";

let liveFeedPollInFlight = false;

let eggImageCatalog = [];
try {
  const catalogPath = path.resolve(process.cwd(), "data/eggs.json");
  const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  eggImageCatalog = Array.isArray(catalog.eggs) ? catalog.eggs : [];
} catch (error) {
  console.warn("Egg image catalog could not be loaded:", error?.message || error);
}

loadRuntimeState();
rebuildLastSeenFromHistory().catch(error => {
  console.warn("Last Seen history rebuild failed:", error?.message || error);
});

function findCatalogEgg(input) {
  const wanted = normalizeFeedKey(input);
  if (!wanted) return null;

  return eggImageCatalog.find(entry => {
    const names = [
      entry?.eggName,
      entry?.displayName,
      ...(Array.isArray(entry?.aliases) ? entry.aliases : [])
    ].filter(Boolean);

    return names.some(name => normalizeFeedKey(name) === wanted);
  }) || null;
}

function normalizeRarityName(value) {
  const key = String(value || "").trim().toLowerCase();
  return key ? key[0].toUpperCase() + key.slice(1) : "";
}

function buildDynamicCatalogEntry(eggName, rarity, area = "Unknown") {
  const cleanEgg = String(eggName || "").replace(/\s+/g, " ").trim();
  const cleanRarity = normalizeRarityName(rarity);
  if (!cleanEgg || !["Secret", "Eternal", "Divine"].includes(cleanRarity)) return null;

  const petName = cleanEgg.replace(/\s+Egg$/i, "").trim() || cleanEgg;
  const normalized = normalizeFeedKey(cleanEgg);

  return {
    eggName: cleanEgg,
    displayName: cleanEgg,
    petName,
    rarity: cleanRarity,
    biome: String(area || "Unknown").trim() || "Unknown",
    aliases: [cleanEgg, petName],
    sourcePage: "https://robloxstealanegg.wiki/eggs/" + slugify(cleanEgg.replace(/\s+Egg$/i, "")) + "-egg/",
    active: true,
    discoveredAt: new Date().toISOString(),
    source: "EggWatch live auto-discovery",
    _runtimeOnlyKey: normalized
  };
}

function ensureCatalogEgg(eggName, rarity, area = "Unknown") {
  const existing = findCatalogEgg(eggName);
  if (existing) return existing;

  if (!AUTO_DISCOVERY_ENABLED) return null;

  const dynamic = buildDynamicCatalogEntry(eggName, rarity, area);
  if (!dynamic) return null;

  eggImageCatalog.push(dynamic);
  scheduleStateSave();

  console.log(
    "Auto-discovered new egg:",
    dynamic.rarity,
    dynamic.eggName,
    "area=" + dynamic.biome
  );

  return dynamic;
}

function canonicalEggName(input) {
  return findCatalogEgg(input)?.eggName || String(input || "").trim();
}

function eggNameMatchesTarget(value, targetName) {
  const left = normalizeFeedKey(value);
  const right = normalizeFeedKey(targetName);
  if (!left || !right) return false;
  if (left === right) return true;

  return left.replace(/\begg\b/g, "").trim() === right.replace(/\begg\b/g, "").trim();
}


function extractTagAttributes(tag) {
  const attrs = {};
  const pattern = /([:\w-]+)\s*=\s*"([^"]*)"/g;
  for (const match of tag.matchAll(pattern)) {
    attrs[match[1].toLowerCase()] = match[2];
  }
  return attrs;
}

function absolutizeUrl(value, pageUrl) {
  const normalized = normalizeImageUrl(value);
  if (normalized) return normalized;

  try {
    if (!value) return null;
    const resolved = new URL(value, pageUrl).href;
    return normalizeImageUrl(resolved);
  } catch {
    return null;
  }
}
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

const resolvedRoleCache = new Map();
const ROLE_CACHE_TTL_MS = 5 * 60 * 1000;

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
let liveFeedLastSuccessAt = null;
let liveFeedHealthState = "WAITING";

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

function isValidHttpUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    return (url.protocol === "https:" || url.protocol === "http:");
  } catch {
    return false;
  }
}

function normalizeImageUrl(value) {
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  return isValidHttpUrl(cleaned) ? cleaned : null;
}

function firstImageUrl(value) {
  if (!value || typeof value !== "object") return null;

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstImageUrl(item);
      if (found) return found;
    }
    return null;
  }

  const preferredKeys = [
    "imageUrl", "image_url", "image",
    "thumbnailUrl", "thumbnail_url", "thumbnail",
    "iconUrl", "icon_url", "icon",
    "avatarUrl", "avatar_url"
  ];

  for (const key of preferredKeys) {
    const raw = value[key];
    if (typeof raw === "string") {
      const found = normalizeImageUrl(raw);
      if (found) return found;
    } else if (raw && typeof raw === "object") {
      const found = firstImageUrl(raw);
      if (found) return found;
    }
  }

  for (const [key, child] of Object.entries(value)) {
    if (/image|thumbnail|icon|avatar/i.test(key)) {
      const found = firstImageUrl(child);
      if (found) return found;
    }
  }

  return null;
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

const imageFallbackCache = new Map();
const petPageCache = new Map();
const petPngBufferCache = new Map();
const petStatsCache = new Map();
const IMAGE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const IMAGE_NEGATIVE_CACHE_TTL_MS = 5 * 60 * 1000;
const PET_PAGE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const PET_PNG_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_REMOTE_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_REMOTE_TEXT_BYTES = 2 * 1024 * 1024;



function findCatalogPet(input) {
  const wanted = normalizeFeedKey(input);
  if (!wanted) return null;

  return eggImageCatalog.find(entry => {
    const petName = entry?.petName;
    return petName && normalizeFeedKey(petName) === wanted;
  }) || null;
}

function petSlugForEntry(entry) {
  return slugify(entry?.petName || "").replace(/-egg$/i, "");
}

async function fetchPetPage(petName) {
  const entry = findCatalogPet(petName);
  if (!entry) return null;

  const key = normalizeFeedKey(entry.petName);
  const cached = petPageCache.get(key);
  if (cached && Date.now() - cached.at < PET_PAGE_CACHE_TTL_MS) {
    return cached;
  }

  const slug = petSlugForEntry(entry);
  const pages = [];

  if (slug) {
    pages.push(
      "https://robloxstealanegg.wiki/pets/" + slug + "/",
      "https://robloxstealanegg.wiki/eggs/" + slug + "-egg/",
      "https://steal-an-egg-roblox.wiki/eggs/" + slug + "-egg/",
      "https://steal-an-egg-roblox.wiki/pets/" + slug + "/"
    );
  }

  for (const page of [...new Set(pages)]) {
    try {
      const { response, body } = await fetchLiveFeed(page);
      if (!response.ok) continue;

      const result = { pageUrl: page, body, at: Date.now() };
      petPageCache.set(key, result);
      return result;
    } catch {
      // Try the next source.
    }
  }

  petPageCache.set(key, { pageUrl: null, body: null, at: Date.now() });
  return null;
}

function parseImgCandidates(html, pageUrl, targetPetName) {
  const tags = String(html || "").match(/<img\b[^>]*>/gi) || [];

  return tags.map(tag => {
    const attrs = extractTagAttributes(tag);
    const src =
      attrs.src ||
      attrs["data-src"] ||
      attrs["data-lazy-src"] ||
      attrs["data-original"] ||
      "";

    const srcSet =
      attrs.srcset ||
      attrs["data-srcset"] ||
      "";

    const alt = attrs.alt || "";
    const title = attrs.title || "";
    const className = attrs.class || "";
    const metadata = (alt + " " + title + " " + className + " " + src).toLowerCase();

    let score = 0;
    if (eggNameMatchesTarget(alt, targetPetName)) score += 150;
    if (normalizeFeedKey(alt).includes(normalizeFeedKey(targetPetName) + " in steal an egg")) score += 80;
    if (eggNameMatchesTarget(title, targetPetName)) score += 120;
    if (normalizeFeedKey(alt) === normalizeFeedKey(targetPetName)) score += 35;
    if (metadata.includes(normalizeFeedKey(targetPetName))) score += 35;
    if (/\b(avatar|pet)\b/i.test(alt + " " + title)) score += 20;
    if (/\/images\/pets\//i.test(src)) score += 50;
    if (/\.(?:webp|png)(?:\?|$)/i.test(src)) score += 10;

    if (/\b(og|hero|banner|logo|site-header|favicon|sprite)\b/i.test(metadata)) score -= 250;
    if (/\b(article|author|profile|icon|thumbnail)\b/i.test(metadata)) score -= 100;

    const srcParts = [];
    if (src) srcParts.push(src);
    if (srcSet) {
      for (const part of srcSet.split(",")) {
        const candidate = part.trim().split(/\s+/)[0];
        if (candidate) srcParts.push(candidate);
      }
    }

    return {
      urls: srcParts
        .map(value => absolutizeUrl(value, pageUrl))
        .filter(Boolean),
      score
    };
  })
    .filter(item => item.urls.length && item.score >= 100)
    .sort((a, b) => b.score - a.score);
}

function isTrustedPetImageUrl(value) {
  if (!isValidHttpUrl(value)) return false;

  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const pathName = url.pathname.toLowerCase();

    const trustedHost =
      host === "robloxstealanegg.wiki" ||
      host === "steal-an-egg-roblox.wiki";

    const petPath = /\/images\/pets\//.test(pathName);
    const imageExtension = /\.(?:png|webp|jpe?g)(?:$)/.test(pathName);
    const blockedPath = /(?:\/og\/|\/hero\/|\/banner\/|\/logo\/|\/favicon|sprite)/i.test(pathName);

    return trustedHost && petPath && imageExtension && !blockedPath;
  } catch {
    return false;
  }
}

async function resolvePetImageSource(petName) {
  const entry = findCatalogPet(petName);
  if (!entry) return null;

  const key = normalizeFeedKey(entry.petName);
  const cached = imageFallbackCache.get("pet:" + key);
  if (cached) {
    const ttl = cached.url ? IMAGE_CACHE_TTL_MS : IMAGE_NEGATIVE_CACHE_TTL_MS;
    if (Date.now() - cached.at < ttl) return cached.url;
    imageFallbackCache.delete("pet:" + key);
  }

  const page = await fetchPetPage(entry.petName);
  if (!page?.body || !page?.pageUrl) {
    imageFallbackCache.set("pet:" + key, { url: null, at: Date.now() });
    return null;
  }

  const candidates = parseImgCandidates(page.body, page.pageUrl, entry.petName);

  for (const candidate of candidates) {
    for (const url of candidate.urls) {
      if (!isTrustedPetImageUrl(url)) continue;

      imageFallbackCache.set("pet:" + key, { url, at: Date.now() });
      return url;
    }
  }

  imageFallbackCache.set("pet:" + key, { url: null, at: Date.now() });
  return null;
}

function parseGameStatsFromPetPage(body) {
  const html = String(body || "");
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();

  const incomeMatch = text.match(/Base income\s*\$?([0-9.,]+\s*[KMBT])\/s/i);
  const speedMatch = text.match(/(?:you need|requires?|minimum(?: gate)?[:\s]+)([0-9.,]+\s*[KMBT])\s*Speed/i);

  return {
    income: incomeMatch ? "$" + incomeMatch[1].replace(/\s+/g, "") + "/s" : null,
    speed: speedMatch ? speedMatch[1].replace(/\s+/g, "") : null
  };
}

async function fetchPetGameStats(petName) {
  const entry = findCatalogPet(petName);
  if (!entry) return { income: null, speed: null };

  const key = normalizeFeedKey(entry.petName);
  const cached = petStatsCache.get(key);
  if (cached && Date.now() - cached.at < PET_PAGE_CACHE_TTL_MS) {
    return cached.stats;
  }

  const page = await fetchPetPage(entry.petName);
  const stats = parseGameStatsFromPetPage(page?.body || "");
  petStatsCache.set(key, { stats, at: Date.now() });
  return stats;
}

function publicPetImageUrl(petName) {
  if (!PUBLIC_BASE_URL) return null;
  const slug = slugify(petName);
  if (!slug) return null;
  return PUBLIC_BASE_URL + "/cdn/pets/" + encodeURIComponent(slug) + ".png";
}

async function trimImageCaches() {
  const maxEntries = 40;

  if (petPngBufferCache.size > maxEntries) {
    const oldest = [...petPngBufferCache.entries()]
      .sort((a, b) => a[1].at - b[1].at)
      .slice(0, petPngBufferCache.size - maxEntries);

    for (const [key] of oldest) {
      petPngBufferCache.delete(key);
    }
  }

  if (imageFallbackCache.size > maxEntries * 2) {
    const oldest = [...imageFallbackCache.entries()]
      .sort((a, b) => a[1].at - b[1].at)
      .slice(0, imageFallbackCache.size - maxEntries * 2);

    for (const [key] of oldest) {
      imageFallbackCache.delete(key);
    }
  }
}

async function imageHasTransparentPixels(input) {
  try {
    const { data, info } = await sharp(input)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    for (let offset = 3; offset < data.length; offset += info.channels) {
      if (data[offset] < 250) return true;
    }
  } catch {
    return false;
  }

  return false;
}

function colorDistance(r1, g1, b1, r2, g2, b2) {
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function nearestCornerColor(data, info, x, y) {
  const { width, channels } = info;
  const offset = (y * width + x) * channels;
  return [data[offset], data[offset + 1], data[offset + 2]];
}

function medianColor(colors) {
  const channels = [0, 1, 2].map(index =>
    colors.map(color => color[index]).sort((a, b) => a - b)
  );
  const mid = Math.floor(channels[0].length / 2);

  return [
    channels[0][mid],
    channels[1][mid],
    channels[2][mid]
  ];
}

async function removeSimpleBackground(input) {
  try {
    const prepared = await sharp(input, { failOn: "none" })
      .resize({
        width: 768,
        height: 768,
        fit: "inside",
        withoutEnlargement: true
      })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { data, info } = prepared;
    const { width, height, channels } = info;

    if (!width || !height || width * height > 600000) return null;

    const samplePoints = [
      [0, 0],
      [Math.max(0, width - 1), 0],
      [0, Math.max(0, height - 1)],
      [Math.max(0, width - 1), Math.max(0, height - 1)],
      [Math.floor(width / 2), 0],
      [Math.floor(width / 2), Math.max(0, height - 1)],
      [0, Math.floor(height / 2)],
      [Math.max(0, width - 1), Math.floor(height / 2)]
    ];

    const background = medianColor(
      samplePoints.map(([x, y]) => nearestCornerColor(data, info, x, y))
    );

    const visited = new Uint8Array(width * height);
    const queue = new Int32Array(width * height);
    let head = 0;
    let tail = 0;

    const maxDistance = 58;
    const pixelsToCheck = [];

    function trySeed(x, y) {
      if (x < 0 || x >= width || y < 0 || y >= height) return;
      const index = y * width + x;
      if (visited[index]) return;

      const offset = index * channels;
      if (data[offset + 3] === 0) {
        visited[index] = 1;
        return;
      }

      const distance = colorDistance(
        data[offset],
        data[offset + 1],
        data[offset + 2],
        background[0],
        background[1],
        background[2]
      );

      if (distance <= maxDistance) {
        visited[index] = 1;
        queue[tail++] = index;
      }
    }

    for (let x = 0; x < width; x++) {
      trySeed(x, 0);
      trySeed(x, height - 1);
    }
    for (let y = 1; y < height - 1; y++) {
      trySeed(0, y);
      trySeed(width - 1, y);
    }

    while (head < tail) {
      const index = queue[head++];
      pixelsToCheck.push(index);

      const x = index % width;
      const y = Math.floor(index / width);
      trySeed(x - 1, y);
      trySeed(x + 1, y);
      trySeed(x, y - 1);
      trySeed(x, y + 1);
    }

    if (pixelsToCheck.length < Math.max(100, Math.floor(width * height * 0.01))) {
      return null;
    }

    for (const index of pixelsToCheck) {
      data[index * channels + 3] = 0;
    }

    const output = await sharp(data, {
      raw: {
        width,
        height,
        channels
      }
    })
      .trim()
      .png({ compressionLevel: 9 })
      .toBuffer();

    return await imageHasTransparentPixels(output) ? output : null;
  } catch (error) {
    console.warn("Simple background removal failed:", error?.message || error);
    return null;
  }
}

async function getPetPngBuffer(petName) {
  const entry = findCatalogPet(petName);
  if (!entry) return null;

  const key = normalizeFeedKey(entry.petName);
  const cached = petPngBufferCache.get(key);
  if (cached && Date.now() - cached.at < PET_PNG_CACHE_TTL_MS) {
    return cached.buffer;
  }

  const sourceUrl = await resolvePetImageSource(entry.petName);
  if (!sourceUrl) return null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LIVE_FEED_TIMEOUT_MS);

    const response = await fetch(sourceUrl, {
      headers: {
        "accept": "image/avif,image/webp,image/png,image/*;q=0.9,*/*;q=0.8",
        "user-agent": "FSMM-SAB-Live-Notifier/5.0"
      },
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!response.ok) return null;

    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength && contentLength > MAX_REMOTE_IMAGE_BYTES) return null;

    const input = Buffer.from(await response.arrayBuffer());
    if (input.length > MAX_REMOTE_IMAGE_BYTES) return null;

    let pngBuffer = null;
    const alreadyTransparent = await imageHasTransparentPixels(input);

    if (!alreadyTransparent) {
      pngBuffer = await removeSimpleBackground(input);

      if (pngBuffer) {
        console.log("Character cutout created:", entry.petName);
      } else {
        console.warn(
          "Background could not be fully removed; keeping normalized PNG:",
          entry.petName
        );
      }
    }

    if (!pngBuffer) {
      pngBuffer = await sharp(input, { failOn: "none" })
        .ensureAlpha()
        .trim()
        .png({ compressionLevel: 9 })
        .toBuffer();
    }

    petPngBufferCache.set(key, { buffer: pngBuffer, at: Date.now() });
    trimImageCaches();
    return pngBuffer;
  } catch (error) {
    console.warn(
      "Pet PNG processing failed for " + entry.petName + ":",
      error?.message || error
    );
    return null;
  }
}
async function resolveImageUrl(eggName, _providedUrl = null) {
  const entry = findCatalogEgg(eggName);
  if (!entry?.petName) return null;

  const petName = entry.petName;

  if (PUBLIC_BASE_URL) {
    const pngUrl = publicPetImageUrl(petName);
    if (pngUrl) {
      // Warm the cache in the background so Discord never has to wait on
      // the first image request.
      getPetPngBuffer(petName).catch(() => {});
      imageFallbackCache.set(normalizeFeedKey(eggName), { url: pngUrl, at: Date.now() });
      return pngUrl;
    }
  }

  return resolvePetImageSource(petName);
}

async function warmPetImageCache(options = {}) {
  if (imageWarmupInFlight) return;
  imageWarmupInFlight = true;

  const maxWorkers = Math.max(1, Number(options.workers || 1));
  const entries = eggImageCatalog.filter(entry => entry?.active !== false);
  let warmed = 0;
  let cursor = 0;

  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= entries.length) return;

      const entry = entries[index];

      try {
        const source = await resolvePetImageSource(entry.petName);
        if (!source) continue;

        const buffer = await getPetPngBuffer(entry.petName);
        if (buffer) warmed++;
      } catch (error) {
        console.warn(
          "Image warm-up failed for " + entry.petName + ":",
          error?.message || error
        );
      }
    }
  }

  try {
    await Promise.all(
      Array.from(
        { length: Math.min(maxWorkers, entries.length) },
        () => worker()
      )
    );

    console.log(
      "Pet image cache warm:",
      warmed + "/" + entries.length,
      "(transparent PNG cache)"
    );
  } finally {
    imageWarmupInFlight = false;
  }
}

function scheduleImageWarmup() {
  setTimeout(() => {
    warmPetImageCache({ workers: 1 }).catch(error => {
      console.error("Background image warm-up failed:", error);
    });
  }, 1500);
}

app.get("/cdn/pets/:pet.png", async (req, res) => {
  const rawPet = String(req.params.pet || "")
    .replace(/\.png$/i, "")
    .replace(/-/g, " ")
    .trim();

  const entry = findCatalogPet(rawPet) ||
    eggImageCatalog.find(item => slugify(item?.petName || "") === slugify(rawPet));

  if (!entry) {
    return res.status(404).end();
  }

  const pngBuffer = await getPetPngBuffer(entry.petName);
  if (!pngBuffer) {
    return res.status(404).end();
  }

  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "public, max-age=21600, stale-while-revalidate=86400");
  return res.status(200).send(pngBuffer);
});

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
    "eggName", "eggLabel", "eggDisplayName", "egg",
    "itemName", "item", "displayName", "name", "title"
  );

  const rarity = get("rarity", "tier", "rarityName");
  const area = get("spawnArea", "area", "location", "biome", "zone", "world", "place");
  const spawnedAt = get(
    "spawnedAt", "spawned_at", "detectedAt", "detected_at",
    "timestamp", "time", "createdAt", "created_at", "date"
  );
  const sourceEventId = get(
    "eventId", "eventID", "event_id", "spawnId", "spawnID",
    "spawn_id", "id", "uuid"
  );
  const imageUrl = firstImageUrl(value);

  if (typeof eggName === "string" && typeof rarity === "string") {
    const rarityKey = rarity.trim().toLowerCase();

    if (["secret", "eternal", "divine"].includes(rarityKey)) {
      const parsedTime = parseTimestamp(spawnedAt);
      const catalogEgg = findCatalogEgg(eggName.trim()) ||
        (parsedTime ? ensureCatalogEgg(eggName.trim(), rarity, area) : null);

      if (catalogEgg && parsedTime && catalogEgg.rarity.toLowerCase() === rarityKey) {
        const pathText = path.join(".").toLowerCase();
        let score = 20;

        for (const marker of [
          "latest", "current", "confirmed", "latestconfirmed",
          "latestegg", "currentegg", "lastspawn", "recent", "feed"
        ]) {
          if (pathText.includes(marker)) score += 5;
        }

        if (sourceEventId) score += 8;
        if (typeof area === "string" && area.trim()) score += 2;

        out.push({
          eggName: catalogEgg.eggName,
          rarity: catalogEgg.rarity,
          biome: catalogEgg.biome || (typeof area === "string" && area.trim() ? area.trim() : "Unknown"),
          petName: catalogEgg.petName || catalogEgg.eggName.replace(/s+Egg$/i, "").trim(),
          spawnedAt: parsedTime.toISOString(),
          sourceEventId: sourceEventId ? String(sourceEventId) : null,
          imageUrl: normalizeImageUrl(imageUrl),
          score,
          path: path.join(".")
        });
      }
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

  const now = Date.now();
  const fresh = candidates.filter(candidate => {
    const ts = candidate.spawnedAt ? Date.parse(candidate.spawnedAt) : NaN;
    if (!Number.isFinite(ts)) return false;
    const age = now - ts;
    return age >= -60_000 && age <= LIVE_FEED_MAX_AGE_MS;
  });

  const pool = fresh.length ? fresh : candidates;

  pool.sort((a, b) => {
    const aTime = a.spawnedAt ? Date.parse(a.spawnedAt) : 0;
    const bTime = b.spawnedAt ? Date.parse(b.spawnedAt) : 0;
    if (b.score !== a.score) return b.score - a.score;
    return bTime - aTime;
  });

  return pool[0];
}

function syncLastSeenFromFeedPayload(payload) {
  const candidates = collectEggCandidates(payload);
  if (!candidates.length) return 0;

  const changedRarities = new Set();

  for (const candidate of candidates) {
    const rarity = String(candidate?.rarity || "").trim().toLowerCase();
    if (!LAST_SEEN_RARITIES.includes(rarity)) continue;

    const spawnedTime = Date.parse(candidate?.spawnedAt || "");
    if (!Number.isFinite(spawnedTime) || spawnedTime > Date.now() + 60_000) continue;

    const eggName = canonicalEggName(candidate.eggName);
    const entry = findCatalogEgg(eggName) ||
      ensureCatalogEgg(eggName, candidate.rarity, candidate.biome || "Unknown");

    if (!entry) continue;

    const key = normalizeFeedKey(entry.eggName);
    const existing = lastSeenByRarity[rarity].get(key);
    const existingTime = existing ? Date.parse(existing.spawnedAt || "") : NaN;

    if (existing && Number.isFinite(existingTime) && existingTime >= spawnedTime) {
      continue;
    }

    const candidateArea =
      candidate.biome && candidate.biome !== "Unknown"
        ? candidate.biome
        : entry.biome || "Unknown";

    lastSeenByRarity[rarity].set(key, {
      eggName: entry.eggName,
      petName: entry.petName || candidate.petName || entry.eggName.replace(/\s+Egg$/i, "").trim(),
      area: candidateArea,
      spawnedAt: new Date(spawnedTime).toISOString(),
      detectedAt: existing?.detectedAt || new Date().toISOString()
    });

    changedRarities.add(rarity);
  }

  for (const rarity of changedRarities) {
    scheduleLastSeenUpdate(rarity);
  }

  if (changedRarities.size) {
    scheduleStateSave();
  }

  return changedRarities.size;
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
  const rawHtml = String(html || "");
  const text = rawHtml
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
    eggName: canonicalEggName(eggMatch[1].replace(/\s+/g, " ").trim()),
    rarity: rarity[0].toUpperCase() + rarity.slice(1).toLowerCase(),
    biome: areaMatch?.[1]?.replace(/\s+/g, " ").trim() || "Unknown",
    spawnedAt,
    imageUrl: pageImageUrl,
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

    const contentLength = Number(response.headers.get("content-length") || 0);

    if (contentLength && contentLength > MAX_REMOTE_TEXT_BYTES) {
      throw new Error("remote_payload_too_large");
    }

    const body = await response.text();

    if (Buffer.byteLength(body, "utf8") > MAX_REMOTE_TEXT_BYTES) {
      throw new Error("remote_payload_too_large");
    }

    return { response, body };
  } finally {
    clearTimeout(timeout);
  }
}

async function processAdditionalEggWatchCandidates(payload, primaryCandidate, url) {
  const all = collectEggCandidates(payload);
  const primaryTime = Date.parse(primaryCandidate.spawnedAt);
  if (!Number.isFinite(primaryTime)) return 0;

  const candidates = all
    .filter(candidate => {
      const candidateTime = Date.parse(candidate.spawnedAt);
      return (
        candidateTime === primaryTime &&
        normalizeFeedKey(candidate.eggName) !== normalizeFeedKey(primaryCandidate.eggName) &&
        Date.now() - candidateTime >= -60_000 &&
        Date.now() - candidateTime <= LIVE_FEED_MAX_AGE_MS
      );
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  let sent = 0;

  for (const candidate of candidates) {
    const feedEventKey = [
      "feed",
      candidate.rarity.toLowerCase(),
      normalizeFeedKey(candidate.eggName),
      normalizeFeedKey(candidate.biome),
      Math.floor(primaryTime / 1000)
    ].join("|");

    if (seen.has(feedEventKey)) continue;

    const event = {
      live: true,
      eggName: candidate.eggName,
      displayName: candidate.eggName,
      rarity: candidate.rarity,
      biome: candidate.biome || "Unknown",
      spawnedAt: candidate.spawnedAt,
      imageUrl: null,
      source: "EggWatch Global Feed",
      sourceEventId: candidate.sourceEventId || null
    };

    try {
      seen.set(feedEventKey, Date.now());
      recordSpawnHistory(event, "EggWatch Global Feed");
      await sendAlert(event, Math.max(0, Date.now() - primaryTime));
      liveFeedEventsAccepted++;
      sent++;
      console.log(
        "Forwarded additional EggWatch feed event:",
        candidate.rarity,
        candidate.eggName,
        "area=" + candidate.biome,
        "url=" + url
      );
    } catch (error) {
      seen.delete(feedEventKey);
      liveFeedErrors++;
      console.warn(
        "Additional EggWatch candidate failed:",
        candidate.eggName,
        error?.message || error
      );
    }
  }

  return sent;
}

async function pollEggWatch() {
  if (!LIVE_FEED_ENABLED || !LIVE_FEED_URLS.length) return;
  if (liveFeedPollInFlight) return;

  liveFeedPollInFlight = true;
  liveFeedLastPollAt = new Date().toISOString();

  try {
    for (const url of LIVE_FEED_URLS) {
    try {
      const { response, body } = await fetchLiveFeed(url);

      if (!response.ok) {
        continue;
      }

      liveFeedLastSuccessAt = new Date().toISOString();
      updateLiveFeedHealth();

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

      // EggWatch can keep prior detections in the same feed payload.
      // Sync those saved detections into Last Seen without sending alerts.
      syncLastSeenFromFeedPayload(payload);

      // The live API is the authoritative receiver. Do not scrape page HTML here:
      // the page contains banners/marketing artwork that can never be a spawn image.
      const candidate =
        typeof payload === "object" && payload !== null
          ? pickLatestEggFromFeed(payload)
          : null;

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
        candidate.sourceEventId ? String(candidate.sourceEventId) : "",
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
          "url=" + url,
          "catalogSource=" + (findCatalogEgg(candidate.eggName) ? "available" : "none")
        );

        // The first live result is still valid Last Seen data,
        // but must never be sent as a duplicate alert.
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
        continue;
      }

      if (feedStateLooksOffline(payload)) {
        console.log("EggWatch feed changed while watcher is explicitly offline; trying next feed endpoint.");
        continue;
      }

      const feedEventKey = [
        "feed",
        candidate.rarity.toLowerCase(),
        normalizeFeedKey(candidate.eggName),
        normalizeFeedKey(candidate.biome),
        Math.floor(eventTime / 1000)
      ].join("|");

      const alreadySeenFeedEvent = seen.get(feedEventKey) || 0;
      if (Date.now() - alreadySeenFeedEvent < SEEN_TTL_MS) {
        return;
      }

      seen.set(feedEventKey, Date.now());

      const imageUrl = await resolveImageUrl(
        candidate.eggName,
        candidate.imageUrl
      );

      const event = {
        live: true,
        eggName: candidate.eggName,
        displayName: candidate.eggName,
        rarity: candidate.rarity,
        biome: candidate.biome || "Unknown",
        spawnedAt: candidate.spawnedAt,
        imageUrl,
        source: "EggWatch Global Feed",
        sourceEventId: candidate.sourceEventId || null
      };

      try {
        recordSpawnHistory(event, "EggWatch Global Feed");

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

        const additionalSent = await processAdditionalEggWatchCandidates(
          payload,
          candidate,
          url
        );

        if (additionalSent > 0) {
          console.log(
            "Multi-egg announcement:",
            candidate.eggName,
            "+" + additionalSent + " additional rare eggs"
          );
        }

        console.log(
          "Forwarded EggWatch feed event:",
          existingKey,
          "latencyMs=" + (ageMs >= 0 ? ageMs : "unknown"),
          "image=" + (imageUrl ? "attached" : "not-found")
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
  } finally {
    liveFeedPollInFlight = false;
  }
}

function decodeHtmlText(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, "\"")
    .replace(/&#x27;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function extractSupportedEggsFromGuide(html) {
  const text = decodeHtmlText(
    String(html || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, "\n")
  );

  const lines = text
    .split(/\n+/)
    .map(line => line.replace(/^[*\-•]\s*/, "").trim())
    .filter(Boolean);

  const found = [];
  let rarity = "";

  for (const rawLine of lines) {
    const line = decodeHtmlText(rawLine);

    if (/^Secret$/i.test(line)) {
      rarity = "Secret";
      continue;
    }
    if (/^Eternal$/i.test(line)) {
      rarity = "Eternal";
      continue;
    }
    if (/^Divine$/i.test(line)) {
      rarity = "Divine";
      continue;
    }
    if (!rarity) continue;

    const match = line.match(
      /^(.+?)\s+(Jungle|Snow|Volcano|Abyss Ocean|Prehistoric|Cosmic|Cherry Blossom|Titan Temple|Angels and Demons|Area not listed)$/i
    );

    if (!match) continue;

    const name = match[1].replace(/\s+Egg$/i, "").trim();
    if (!name) continue;

    found.push({
      eggName: name + " Egg",
      rarity,
      area: match[2]
    });
  }

  return found;
}

function recordSpawnHistory(event, source = "EggWatch Global Feed") {
  const timestamp = Date.parse(event?.spawnedAt);
  const record = {
    id: event?.sourceEventId || [
      normalizeFeedKey(event?.rarity),
      normalizeFeedKey(event?.eggName),
      normalizeFeedKey(event?.biome),
      event?.spawnedAt || Date.now()
    ].join("|"),
    eggName: event?.eggName || "Unknown Egg",
    petName: event?.displayName || event?.eggName || "Unknown",
    rarity: event?.rarity || "Unknown",
    area: event?.biome || "Unknown",
    spawnedAt: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : new Date().toISOString(),
    detectedAt: new Date().toISOString(),
    source
  };

  const same = spawnHistory.find(item => item.id === record.id);
  if (same) return same;

  spawnHistory.unshift(record);
  if (spawnHistory.length > MAX_HISTORY) spawnHistory.length = MAX_HISTORY;

  recordLastSeen(event);
  scheduleStateSave();
  return record;
}

function recordGameEvent(event) {
  const key = [
    event.type || "event",
    normalizeFeedKey(event.title),
    event.date || "",
    normalizeFeedKey(event.source)
  ].join("|");

  if (gameEventHistory.some(item => item.key === key)) return null;

  const record = {
    key,
    type: event.type || "event",
    title: String(event.title || "Game Event").slice(0, 200),
    description: String(event.description || "").slice(0, 800),
    date: event.date || null,
    source: event.source || "Game Update Discovery",
    detectedAt: new Date().toISOString()
  };

  gameEventHistory.unshift(record);
  if (gameEventHistory.length > MAX_EVENT_HISTORY) {
    gameEventHistory.length = MAX_EVENT_HISTORY;
  }

  scheduleStateSave();
  return record;
}

function extractLatestUpdateFromHomepage(html) {
  const rawHtml = String(html || "");

  const text = decodeHtmlText(
    rawHtml
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, "\n")
  );

  const lines = text.split("\n").map(decodeHtmlText).filter(Boolean);
  const index = lines.findIndex(line => /^(latest update|game update)$/i.test(line));

  if (index === -1) return null;

  const windowLines = lines.slice(index, index + 15);
  const title = windowLines.find((line, offset) =>
    offset > 0 &&
    !/^(latest update|game update|admin abuse)$/i.test(line) &&
    /(?:update|darkness|event|egg|angels|demons|rifts?)/i.test(line)
  ) || windowLines[1] || null;

  if (!title) return null;

  let updateUrl = null;

  for (const match of rawHtml.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const anchorText = decodeHtmlText(match[2]);
    if (
      normalizeFeedKey(anchorText).includes(normalizeFeedKey(title)) ||
      (/\bupdate\b/i.test(title) && /\bupdate\b/i.test(anchorText))
    ) {
      try {
        updateUrl = new URL(match[1], "https://robloxstealanegg.wiki/").href;
      } catch {
        updateUrl = null;
      }
      if (updateUrl) break;
    }
  }

  return {
    title: title.slice(0, 200),
    description: windowLines.slice(1, 7).join(" ").slice(0, 800),
    source: "robloxstealanegg.wiki",
    url: updateUrl
  };
}

function extractEventMentions(html) {
  const text = decodeHtmlText(
    String(html || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, "\n")
  );

  const patterns = [
    { type: "limited_event", re: /\bDr\.?\s*Scramble\b[^\n]{0,180}/i },
    { type: "limited_event", re: /\bAdmin Abuse\b[^\n]{0,180}/i },
    { type: "limited_event", re: /\bAngels?\s*(?:vs|and)\s*Demons?\b[^\n]{0,180}/i },
    { type: "game_update", re: /\bUpdate\s*#?\d+\b[^\n]{0,180}/i }
  ];

  const found = [];

  for (const pattern of patterns) {
    const match = text.match(pattern.re);
    if (match?.[0]) {
      found.push({
        type: pattern.type,
        title: match[0].trim().slice(0, 200),
        description: match[0].trim().slice(0, 800),
        source: "robloxstealanegg.wiki"
      });
    }
  }

  return found;
}

async function sendGameUpdateAlert(update, newEggs = []) {
  if (!EVENT_ALERTS_ENABLED || !CHANNEL_ID || !update?.title) return;

  try {
    const channel = await getAlertChannel();

    const eggText = newEggs.length
      ? "\n\n🥚 New rare eggs: **" +
        newEggs.slice(0, 12).map(item =>
          item.petName || item.eggName.replace(/\s+Egg$/i, "")
        ).join(", ") +
        (newEggs.length > 12 ? " +" + (newEggs.length - 12) + " more" : "") +
        "**"
      : "";

    const embed = new EmbedBuilder()
      .setColor(0x3b82f6)
      .setTitle("🆕 Game Update Detected")
      .setDescription(
        "**" + String(update.title).slice(0, 180) + "**\n" +
        String(update.description || "A new Steal An Egg update was detected.").slice(0, 700) +
        eggText
      )
      .addFields(
        { name: "🎮 Game", value: "Steal An Egg", inline: true },
        { name: "📡 Source", value: String(update.source || "Auto Discovery"), inline: true },
        { name: "🕒 Detected", value: "<t:" + Math.floor(Date.now() / 1000) + ":R>", inline: true }
      )
      .setFooter({ text: "Steal An Egg • Update Monitor" })
      .setTimestamp();

    await channel.send({
      content: "🆕 **Steal An Egg update detected!**",
      embeds: [embed],
      allowedMentions: { parse: [] }
    });
  } catch (error) {
    monitorErrors++;
    console.warn("Game update alert failed:", error?.message || error);
  }
}

async function scanForGameUpdates() {
  if (!AUTO_DISCOVERY_ENABLED) return;

  lastUpdateCheckAt = new Date().toISOString();
  const supportedEggs = [];
  const detectedEvents = [];
  let homepageUpdate = null;

  for (const url of AUTO_DISCOVERY_URLS) {
    try {
      const { response, body } = await fetchLiveFeed(url);
      if (!response.ok) continue;

      if (url === "https://robloxstealanegg.wiki/") {
        homepageUpdate = extractLatestUpdateFromHomepage(body);
      }

      if (url.includes("how-the-live-feed-works")) {
        supportedEggs.push(...extractSupportedEggsFromGuide(body));
      }

      detectedEvents.push(...extractEventMentions(body));
    } catch (error) {
      console.warn("Auto discovery fetch failed:", url, error?.message || error);
    }
  }

  let added = 0;
  const newlyAdded = [];

  for (const item of supportedEggs) {
    const before = findCatalogEgg(item.eggName);
    const entry = ensureCatalogEgg(item.eggName, item.rarity, item.area || "Unknown");

    if (entry && !before) {
      added++;
      autoDiscoveredCount++;
      newlyAdded.push(entry);

      getPetPngBuffer(entry.petName)
        .then(buffer => {
          if (buffer) {
            console.log(
              "Pre-cached new egg character PNG:",
              entry.rarity,
              entry.petName
            );
          }
        })
        .catch(error => {
          console.warn(
            "New egg image preparation failed for " + entry.petName + ":",
            error?.message || error
          );
        });
    }
  }

  if (newlyAdded.length && lastUpdateFingerprint) {
    recordGameEvent({
      type: "catalog_change",
      title: "New rare eggs discovered",
      description:
        newlyAdded.map(item =>
          item.rarity + " • " + (item.petName || item.eggName)
        ).join(", ").slice(0, 800),
      source: "Auto Catalog Sync"
    });
  }

  if (homepageUpdate?.title) {
    const updateFingerprint = normalizeFeedKey(
      homepageUpdate.title + "|" + (homepageUpdate.url || "")
    );

    if (!lastUpdateFingerprint) {
      lastUpdateFingerprint = updateFingerprint;
      lastUpdateTitle = homepageUpdate.title;

      recordGameEvent({
        type: "game_update",
        title: homepageUpdate.title,
        description: homepageUpdate.description,
        source: homepageUpdate.source
      });

      console.log("Game update discovery primed:", homepageUpdate.title);
    } else if (updateFingerprint !== lastUpdateFingerprint) {
      lastUpdateFingerprint = updateFingerprint;
      lastUpdateTitle = homepageUpdate.title;

      const eventRecord = recordGameEvent({
        type: "game_update",
        title: homepageUpdate.title,
        description: homepageUpdate.description,
        source: homepageUpdate.source
      });

      if (eventRecord) {
        await sendGameUpdateAlert(homepageUpdate, newlyAdded);
        console.log("New game update detected:", homepageUpdate.title);
      }
    }
  }

  if (newlyAdded.length && lastUpdateFingerprint) {
    await sendGameUpdateAlert(
      {
        title: "New rare eggs added to the game catalog",
        description: "The Steal An Egg rare-egg catalog changed.",
        source: "Auto Catalog Sync"
      },
      newlyAdded
    );
  }

  for (const event of detectedEvents) {
    recordGameEvent(event);
  }

  const fingerprint = supportedEggs
    .filter(item => item?.eggName && item?.rarity)
    .map(item => item.rarity + ":" + item.eggName)
    .sort()
    .join("|");

  if (fingerprint && fingerprint !== autoDiscoveryLastFingerprint) {
    autoDiscoveryLastFingerprint = fingerprint;
    console.log(
      "Auto catalogue sync:",
      supportedEggs.filter(item => item?.eggName && item?.rarity).length,
      "supported rare eggs; new=" + added
    );
  }
}

function startAutoDiscovery() {
  if (!AUTO_DISCOVERY_ENABLED) return;

  setTimeout(() => {
    scanForGameUpdates().catch(error => {
      console.warn("Initial update discovery failed:", error);
    });
  }, 2500);

  autoDiscoveryTimer = setInterval(() => {
    scanForGameUpdates().catch(error => {
      console.warn("Scheduled update discovery failed:", error);
    });
  }, AUTO_DISCOVERY_POLL_MS);
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

async function resolveAlertRoleId(rarity) {
  const rarityKey = String(rarity || "").toLowerCase();

  if (ALERT_ROLE_IDS[rarityKey]) {
    return ALERT_ROLE_IDS[rarityKey];
  }

  const cached = resolvedRoleCache.get(rarityKey);
  if (cached && Date.now() - cached.at < ROLE_CACHE_TTL_MS) {
    return cached.id;
  }

  if (!alertChannel?.guild) return "";

  try {
    const roles = await alertChannel.guild.roles.fetch();
    const role = roles.find(candidate =>
      candidate.name?.trim().toLowerCase() === rarityKey
    );

    const id = role?.id || "";
    resolvedRoleCache.set(rarityKey, { id, at: Date.now() });

    if (role) {
      console.log("Auto-resolved alert role:", rarityKey, role.name, role.id);
    }
    return id;
  } catch (error) {
    console.warn("Automatic role lookup failed for " + rarityKey + ":", error?.message || error);
    resolvedRoleCache.set(rarityKey, { id: "", at: Date.now() });
    return "";
  }
}

function liveFeedHealth() {
  if (!LIVE_FEED_ENABLED) return "DISABLED";
  if (!liveFeedLastSuccessAt) return "WAITING";

  const ageMs = Date.now() - new Date(liveFeedLastSuccessAt).getTime();
  return ageMs > LIVE_FEED_STALE_AFTER_MS ? "STALE" : "ACTIVE";
}

function updateLiveFeedHealth() {
  const current = liveFeedHealth();

  if (current !== liveFeedHealthState) {
    liveFeedHealthState = current;

    if (current === "STALE") {
      console.warn(
        "EggWatch feed is stale. Last successful response:",
        liveFeedLastSuccessAt || "never"
      );
    } else if (current === "ACTIVE") {
      console.log(
        "EggWatch feed health:",
        "ACTIVE",
        "lastSuccessAt=" + liveFeedLastSuccessAt
      );
    }
  }

  return current;
}

function cleanupCaches(now = Date.now()) {
  for (const [key, timestamp] of seenRiftAlerts) {
    if (now - timestamp > RIFT_DEDUP_TTL_MS) seenRiftAlerts.delete(key);
  }

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

function lastSeenColor(rarity) {
  return {
    secret: 0x7c3aed,
    eternal: 0xf59e0b,
    divine: 0xef4444
  }[rarity] || 0x5865f2;
}

function lastSeenLabel(rarity) {
  return rarity[0].toUpperCase() + rarity.slice(1);
}

function getLastSeenEntries(rarity) {
  const map = lastSeenByRarity[rarity];
  if (!map) return [];

  return eggImageCatalog
    .filter(entry => entry?.active !== false && entry?.rarity?.toLowerCase() === rarity)
    .map(entry => ({
      entry,
      record: map.get(normalizeFeedKey(entry.eggName)) || null
    }));
}

function buildLastSeenEmbed(rarity) {
  const entries = getLastSeenEntries(rarity);
  const seenEntries = entries.filter(item => item.record);
  const neverEntries = entries.filter(item => !item.record);

  const lines = [];

  for (const { entry, record } of entries) {
    if (!record) {
      lines.push("⚪ **" + (entry.petName || entry.eggName) + "** — Never");
      continue;
    }

    const timestamp = Date.parse(record.spawnedAt);
    const unix = Number.isFinite(timestamp)
      ? Math.floor(timestamp / 1000)
      : Math.floor(Date.now() / 1000);

    const displayArea =
      record.area && record.area !== "Unknown"
        ? record.area
        : entry.biome || "Unknown";

    lines.push(
      "🟢 **" + (entry.petName || record.petName || entry.eggName) + "** — <t:" +
      unix + ":R> • 📍 " + String(displayArea).slice(0, 80)
    );
  }

  if (!lines.length) {
    lines.push("⚪ No eggs are configured for this rarity yet.");
  }

  const description = lines.join("\n").slice(0, 4090);

  return new EmbedBuilder()
    .setColor(lastSeenColor(rarity))
    .setTitle("🕒 " + lastSeenLabel(rarity) + " • Last Seen")
    .setDescription(
      "**Live tracker — updates automatically after every spawn.**\n\n" +
      description
    )
    .addFields(
      {
        name: "📊 Tracking",
        value:
          "**" + seenEntries.length + "** seen • **" +
          neverEntries.length + "** never seen",
        inline: true
      },
      {
        name: "🔄 Update delay",
        value: "~1–2 seconds after a confirmed spawn",
        inline: true
      }
    )
    .setFooter({ text: "Steal An Egg • Live Last Seen Tracker" })
    .setTimestamp();
}

async function getLastSeenChannel() {
  if (!LAST_SEEN_CHANNEL_ID) return null;
  if (lastSeenChannel?.isTextBased()) return lastSeenChannel;

  const channel = await client.channels.fetch(LAST_SEEN_CHANNEL_ID);
  if (!channel || !channel.isTextBased()) {
    throw new Error("last_seen_channel_unavailable");
  }

  lastSeenChannel = channel;
  return channel;
}

async function findExistingLastSeenMessage(channel, rarity) {
  const expectedTitle = "🕒 " + lastSeenLabel(rarity) + " • Last Seen";

  if (lastSeenMessageIds[rarity]) {
    try {
      const saved = await channel.messages.fetch(lastSeenMessageIds[rarity]);
      if (
        saved &&
        saved.author?.id === client.user?.id &&
        saved.embeds?.[0]?.title === expectedTitle
      ) {
        return saved;
      }
    } catch {
      // Saved message ID may be stale after a restart or manual deletion.
    }
  }

  try {
    const recent = await channel.messages.fetch({ limit: 100 });
    const matches = [...recent.values()]
      .filter(message =>
        message.author?.id === client.user?.id &&
        message.embeds?.[0]?.title === expectedTitle
      )
      .sort((a, b) => Number(a.id) - Number(b.id));

    if (!matches.length) return null;

    const primary = matches[0];
    lastSeenMessageIds[rarity] = primary.id;

    // Remove duplicate Last Seen messages created by previous restarts.
    for (const duplicate of matches.slice(1)) {
      try {
        await duplicate.delete();
        console.log("Removed duplicate Last Seen message:", rarity, duplicate.id);
      } catch (error) {
        console.warn(
          "Could not remove duplicate Last Seen message for " + rarity + ":",
          error?.message || error
        );
      }
    }

    return primary;
  } catch (error) {
    console.warn(
      "Last Seen message lookup failed for " + rarity + ":",
      error?.message || error
    );
    return null;
  }
}

async function ensureLastSeenMessages() {
  const channel = await getLastSeenChannel();
  if (!channel) return false;

  for (const rarity of LAST_SEEN_RARITIES) {
    const embed = buildLastSeenEmbed(rarity);
    const message = await findExistingLastSeenMessage(channel, rarity);

    if (message) {
      await message.edit({ embeds: [embed] });
      continue;
    }

    const created = await channel.send({ embeds: [embed] });
    lastSeenMessageIds[rarity] = created.id;
  }

  scheduleStateSave();
  return true;
}

async function updateLastSeenMessage(rarity) {
  if (!LAST_SEEN_CHANNEL_ID || !LAST_SEEN_RARITIES.includes(rarity)) return;

  const channel = await getLastSeenChannel();
  if (!channel) return;

  const embed = buildLastSeenEmbed(rarity);
  const existingPromise = lastSeenUpdateInFlight.get(rarity);

  if (existingPromise) {
    await existingPromise;
    return;
  }

  const promise = (async () => {
    const message = await findExistingLastSeenMessage(channel, rarity);

    if (message) {
      await message.edit({ embeds: [embed] });
    } else {
      const created = await channel.send({ embeds: [embed] });
      lastSeenMessageIds[rarity] = created.id;
    }

    scheduleStateSave();
  })();

  lastSeenUpdateInFlight.set(rarity, promise);

  try {
    await promise;
  } finally {
    lastSeenUpdateInFlight.delete(rarity);
  }
}

function scheduleLastSeenUpdate(rarity, retry = false) {
  if (!LAST_SEEN_CHANNEL_ID || !LAST_SEEN_RARITIES.includes(rarity)) return;

  const oldTimer = lastSeenUpdateTimers.get(rarity);
  if (oldTimer) clearTimeout(oldTimer);

  const delay = retry ? LAST_SEEN_RETRY_DELAY_MS : LAST_SEEN_UPDATE_DELAY_MS;

  const timer = setTimeout(() => {
    lastSeenUpdateTimers.delete(rarity);

    updateLastSeenMessage(rarity).catch(error => {
      monitorErrors++;
      console.warn(
        "Last Seen update failed for " + rarity + ":",
        error?.message || error
      );

      scheduleLastSeenUpdate(rarity, true);
    });
  }, delay);

  lastSeenUpdateTimers.set(rarity, timer);
}

function recordLastSeen(event) {
  const rarity = String(event?.rarity || "").trim().toLowerCase();
  if (!LAST_SEEN_RARITIES.includes(rarity)) return;

  const eggName = canonicalEggName(event?.eggName || event?.displayName || "Unknown Egg");
  const entry = findCatalogEgg(eggName) ||
    ensureCatalogEgg(eggName, event.rarity, event.biome);

  const canonical = entry?.eggName || eggName;
  const petName = entry?.petName || event?.displayName || canonical.replace(/\\s+Egg$/i, "").trim();

  const eventArea =
    event?.biome && event.biome !== "Unknown"
      ? event.biome
      : entry?.biome || "Unknown";

  lastSeenByRarity[rarity].set(normalizeFeedKey(canonical), {
    eggName: canonical,
    petName,
    area: eventArea,
    spawnedAt: event?.spawnedAt || new Date().toISOString(),
    detectedAt: new Date().toISOString()
  });

  scheduleLastSeenUpdate(rarity);
}

async function rebuildLastSeenFromHistory() {
  if (!spawnHistory.length) return;

  for (const record of [...spawnHistory].reverse()) {
    const key = String(record?.rarity || "").toLowerCase();
    if (!LAST_SEEN_RARITIES.includes(key)) continue;

    const eggName = canonicalEggName(record.eggName || record.petName);
    const entry = findCatalogEgg(eggName);
    if (!entry) continue;

    const mapKey = normalizeFeedKey(entry.eggName);
    if (!lastSeenByRarity[key].has(mapKey)) {
      lastSeenByRarity[key].set(mapKey, {
        eggName: entry.eggName,
        petName: entry.petName || record.petName || entry.eggName,
        area: record.area || entry.biome || "Unknown",
        spawnedAt: record.spawnedAt,
        detectedAt: record.detectedAt || record.spawnedAt
      });
    }
  }
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

  for (const rarity of ["secret", "eternal", "divine"]) {
    try {
      const roleId = await resolveAlertRoleId(rarity);

      if (!roleId) {
        console.warn("No alert role available for", rarity);
        continue;
      }

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

function buildAlertEmbed(event, _latencyMs = null, includeImage = true) {
  const rarity = String(event.rarity || "Unknown").trim();
  const rarityKey = rarity.toLowerCase();
  const emoji = getRarityEmoji(rarity);
  const eggName = String(event.displayName || event.eggName || "Unknown").trim();
  const area = String(event.biome || "Unknown").trim();

  const timestamp = Date.parse(event.spawnedAt);
  const unix = Number.isFinite(timestamp)
    ? Math.floor(timestamp / 1000)
    : Math.floor(Date.now() / 1000);

  const fields = [
    { name: "🥚 Egg", value: eggName.slice(0, 1024), inline: true },
    { name: "📍 Location", value: area.slice(0, 1024), inline: true },
    { name: "🕒 Spawned", value: "<t:" + unix + ":R>", inline: true }
  ];

  const embed = new EmbedBuilder()
    .setColor(
      {
        secret: 0x7c3aed,
        eternal: 0xf59e0b,
        divine: 0xef4444
      }[rarityKey] || 0x5865f2
    )
    .setTitle(emoji + "  " + rarity + " Egg Spawned!")
    .setDescription(
      "**" + eggName.slice(0, 200) + "** spawned in **" + area.slice(0, 200) + "**."
    )
    .addFields(fields)
    .setFooter({ text: "Steal An Egg • Live Spawn • EggWatch" })
    .setTimestamp(Number.isFinite(timestamp) ? new Date(timestamp) : new Date());

  if (includeImage) {
    if (event.imageBuffer) {
      embed.setThumbnail("attachment://egg-character.png");
    } else if (event.imageUrl) {
      embed.setThumbnail(event.imageUrl);
    }
  }

  return embed;
}

function buildActionRow(event) {
  const buttons = [
    new ButtonBuilder()
      .setLabel("Join Game")
      .setStyle(ButtonStyle.Link)
      .setURL(event.joinUrl || STEAL_AN_EGG_GAME_URL)
  ];

  if (event.messageUrl) {
    buttons.push(
      new ButtonBuilder()
        .setLabel("View Spawn")
        .setStyle(ButtonStyle.Link)
        .setURL(event.messageUrl)
    );
  }

  return new ActionRowBuilder().addComponents(...buttons.slice(0, 5));
}

async function enrichAlertEvent(event) {
  const entry =
    findCatalogEgg(event.eggName || event.displayName) ||
    ensureCatalogEgg(event.eggName || event.displayName, event.rarity, event.biome);

  if (!entry) return event;

  event.eggName = entry.eggName;
  event.displayName = entry.petName || entry.displayName || entry.eggName;
  event.biome = event.biome || entry.biome || "Unknown";

  const imageKey = normalizeFeedKey(entry.petName);
  const cachedPng = petPngBufferCache.get(imageKey);

  if (cachedPng && Date.now() - cachedPng.at < PET_PNG_CACHE_TTL_MS) {
    event.imageBuffer = cachedPng.buffer;
  }

  const cachedSource = imageFallbackCache.get(normalizeFeedKey(entry.eggName));
  if (!event.imageUrl) {
    event.imageUrl =
      cachedSource?.url ||
      (PUBLIC_BASE_URL ? publicPetImageUrl(entry.petName) : null);
  }

  // First-time images are awaited so the alert is not sent without a picture.
  if (!cachedPng) {
    try {
      const buffer = await getPetPngBuffer(entry.petName);
      if (buffer) {
        event.imageBuffer = buffer;
        console.log("Pet PNG ready before alert:", entry.petName);
      }
    } catch (error) {
      console.warn(
        "Pet image preparation failed before alert for " + entry.petName + ":",
        error?.message || error
      );
    }
  }

  return event;
}

function recordRiftHistory(event, test = false) {
  const record = {
    type: event.type,
    bannerKey: event.bannerKey || null,
    bannerName: event.bannerName || null,
    bossName: event.bossName || null,
    changedLabel: event.changedLabel || null,
    nextChangeLabel: event.nextChangeLabel || null,
    createdTimestamp: event.createdTimestamp || Date.now(),
    joinUrl: event.joinUrl || null,
    messageUrl: event.messageUrl || null,
    sourceName: event.sourceName || null,
    test
  };

  riftHistory.unshift(record);
  if (riftHistory.length > MAX_RIFT_HISTORY) {
    riftHistory.length = MAX_RIFT_HISTORY;
  }

  if (test) return;

  const observedAt = new Date().toISOString();

  if (event.type === "banner") {
    riftState = {
      ...riftState,
      currentBannerKey: event.bannerKey || null,
      currentBannerName: event.bannerName || null,
      changedLabel: event.changedLabel || null,
      nextChangeLabel: event.nextChangeLabel || null,
      lastChangedAt: Number(event.createdTimestamp || Date.now()),
      lastObservedAt: observedAt,
      lastJoinUrl: event.joinUrl || null,
      lastSourceMessageUrl: event.messageUrl || null
    };
  } else if (event.type === "boss") {
    riftState = {
      ...riftState,
      lastBossAt: Number(event.createdTimestamp || Date.now()),
      lastBossMessageUrl: event.messageUrl || null
    };
  }

  scheduleStateSave();
}

async function sendRiftAlert(event, options = {}) {
  const isTest = options.test === true;

  if (!RIFT_ALERTS_ENABLED || !CHANNEL_ID) return false;
  if (event?.type === "boss" && !RIFT_BOSS_ALERTS_ENABLED) return false;

  const dedupKey = [
    "rift",
    event?.type || "unknown",
    event?.bannerKey || event?.bossName || "unknown",
    event?.changedLabel || event?.nextChangeLabel || event?.createdTimestamp || "unknown"
  ]
    .join("|")
    .toLowerCase();

  if (!isTest) {
    const previous = seenRiftAlerts.get(dedupKey) || 0;
    if (Date.now() - previous < RIFT_DEDUP_TTL_MS) return false;
    seenRiftAlerts.set(dedupKey, Date.now());
  }

  const channel = await getAlertChannel();
  const alertLine =
    event.type === "banner"
      ? "🟣 **The Rift shifted — " + event.bannerName + " is now active!**"
      : "🌀 **Abyss Overlord is active!**";

  let mentionContent = alertLine;
  const roleId = RIFT_ALERT_ROLE_ID;

  if (RIFT_ALERT_MENTION_MODE === "role" && roleId) {
    mentionContent = "<@&" + roleId + "> " + alertLine;
  } else if (RIFT_ALERT_MENTION_MODE === "here") {
    mentionContent = "@here " + alertLine;
  }

  const message = await channel.send({
    content: mentionContent,
    embeds: [buildRiftAlertEmbed(event)],
    components: [buildRiftActionRow(event)],
    allowedMentions: {
      parse: RIFT_ALERT_MENTION_MODE === "here" ? ["everyone"] : [],
      roles: RIFT_ALERT_MENTION_MODE === "role" && roleId ? [roleId] : []
    }
  });

  recordRiftHistory(event, isTest);

  if (event.type === "banner") {
    const data = getRiftData(event.bannerKey);

    console.log(
      "Rift banner alert sent:",
      event.bannerName,
      "rotationChance=" + (data?.rotationChance || "unknown"),
      "message=" + message.id,
      "source=" + (event.sourceName || "unknown")
    );
  } else {
    console.log(
      "Rift boss alert sent:",
      event.bossName || "Abyss Overlord",
      "message=" + message.id
    );
  }

  return true;
}

async function sendAlert(event, latencyMs = null) {
  await enrichAlertEvent(event);
  const channel = await getAlertChannel();
  const rarity = String(event.rarity || "Unknown").trim();
  const rarityKey = rarity.toLowerCase();
  const roleId = await resolveAlertRoleId(rarity);
  const emoji = getRarityEmoji(rarity);

  const petName = String(event.displayName || event.eggName || "Unknown").trim();
  const area = String(event.biome || "Unknown").trim();

  const alertText =
    emoji +
    " **" +
    rarity +
    " egg " +
    petName +
    " spawned in " +
    area +
    "!**";

  const mentionContent =
    ALERT_MENTION_MODE === "role" && roleId
      ? "<@&" + roleId + "> " + alertText
      : ALERT_MENTION_MODE === "here"
        ? "@here " + alertText
        : alertText;

  const payload = {
    content: mentionContent,
    embeds: [buildAlertEmbed(event, latencyMs, true)],
    files: event.imageBuffer
      ? [{
          attachment: event.imageBuffer,
          name: "egg-character.png",
          description: "Transparent Steal An Egg character image"
        }]
      : undefined,
    allowedMentions: {
      parse: ALERT_MENTION_MODE === "here" ? ["everyone"] : [],
      roles: ALERT_MENTION_MODE === "role" && roleId ? [roleId] : []
    }
  };

  const row = buildActionRow(event);
  if (row) payload.components = [row];

  let sentMessage = null;

  try {
    sentMessage = await channel.send(payload);
  } catch (firstError) {
    console.error("Primary alert send failed:", firstError);
    alertChannel = null;

    const freshChannel = await getAlertChannel();

    if (event.imageUrl || event.imageBuffer) {
      payload.embeds = [buildAlertEmbed(event, latencyMs, true)];
    }

    sentMessage = await freshChannel.send(payload);
  }

  if (!event.imageBuffer && sentMessage) {
    const entry = findCatalogEgg(event.eggName || event.displayName);

    if (entry?.petName) {
      getPetPngBuffer(entry.petName)
        .then(async buffer => {
          if (!buffer) return;

          await sentMessage.edit({
            embeds: [
              buildAlertEmbed(
                { ...event, imageBuffer: buffer },
                latencyMs,
                true
              )
            ],
            files: [{
              attachment: buffer,
              name: "egg-character.png",
              description: "Transparent Steal An Egg character image"
            }]
          });

          console.log("Post-send PNG attached:", entry.petName);
        })
        .catch(error => {
          console.warn("Post-send PNG attach failed:", error?.message || error);
        });
    }
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

  const messageData = extractMessageData(message);

  const riftChannelAllowed =
    !RIFT_SOURCE_CHANNEL_IDS.size || RIFT_SOURCE_CHANNEL_IDS.has(message.channelId);
  const riftBotAllowed =
    !RIFT_SOURCE_BOT_IDS.size || RIFT_SOURCE_BOT_IDS.has(message.author?.id);

  if (RIFT_ALERTS_ENABLED && riftChannelAllowed && riftBotAllowed) {
    const riftEvent = parseRiftChange(messageData);

    if (riftEvent) {
      riftEvent.messageUrl = messageData.messageUrl || null;
      riftEvent.createdTimestamp = messageData.createdTimestamp || Date.now();
      riftEvent.imageUrl = messageData.imageUrl || null;
      riftEvent.sourceName =
        message.author?.tag ||
        message.author?.username ||
        "Discord Source";

      try {
        await sendRiftAlert(riftEvent);
      } catch (error) {
        monitorErrors++;
        console.warn("Rift alert failed:", error?.message || error);
      }

      return;
    }
  }

  if (SOURCE_CHANNEL_IDS.size && !SOURCE_CHANNEL_IDS.has(message.channelId)) return;
  if (SOURCE_BOT_IDS.size && !SOURCE_BOT_IDS.has(message.author?.id)) return;

  lastSourceMessageAt = new Date(message.createdTimestamp || Date.now()).toISOString();
  lastSourceMessageId = message.id || null;

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
    liveFeedLastSuccessAt,
    liveFeedHealth: liveFeedHealth(),
    liveFeedEventsReceived,
    liveFeedEventsAccepted,
    liveFeedErrors,
    publicPngProxy: Boolean(PUBLIC_BASE_URL),
    sourceImageAlphaOnly: SOURCE_IMAGE_ALPHA_ONLY,

    autoDiscoveryEnabled: AUTO_DISCOVERY_ENABLED,
    autoDiscoveredCount,
    lastUpdateCheckAt,
    lastUpdateTitle,
    spawnHistoryCount: spawnHistory.length,
    gameEventHistoryCount: gameEventHistory.length,
    memoryRssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    memorySoftLimitMb: MEMORY_SOFT_LIMIT_MB,
    memoryHardLimitMb: MEMORY_HARD_LIMIT_MB,
    statePersistence: true,
    cachedPetImages: [...imageFallbackCache.keys()].filter(key => key.startsWith("pet:") && imageFallbackCache.get(key)?.url).length
  });
});

app.get("/api/history", (_req, res) => {
  res.json({
    count: spawnHistory.length,
    items: spawnHistory.slice(0, 50)
  });
});

app.get("/api/events", (_req, res) => {
  res.json({
    count: gameEventHistory.length,
    lastUpdateTitle,
    lastUpdateCheckAt,
    items: gameEventHistory.slice(0, 20)
  });
});

app.get("/api/rift", (_req, res) => {
  res.json({
    enabled: RIFT_ALERTS_ENABLED,
    bossAlertsEnabled: RIFT_BOSS_ALERTS_ENABLED,
    state: riftState,
    history: riftHistory.slice(0, 20)
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
    recordSpawnHistory(req.body, "Signed API");
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
  console.log("Memory guard:", MEMORY_SOFT_LIMIT_MB + "MB soft / " + MEMORY_HARD_LIMIT_MB + "MB hard");
  console.log("Auto discovery:", AUTO_DISCOVERY_ENABLED ? "enabled" : "disabled");
  console.log("Event alerts:", EVENT_ALERTS_ENABLED ? "enabled" : "disabled");

  if (CHANNEL_ID) {
    try {
      alertChannel = await client.channels.fetch(CHANNEL_ID);
      console.log("Alert channel cached.");
      await validateAlertRoles();
    } catch (error) {
      console.error("Alert channel preload failed:", error);
    }
  }

  await rebuildLastSeenFromHistory();

  if (LAST_SEEN_CHANNEL_ID) {
    try {
      await ensureLastSeenMessages();
      console.log("Last Seen tracker ready.");
    } catch (error) {
      monitorErrors++;
      console.error("Last Seen tracker initialization failed:", error);
    }
  }

  scheduleImageWarmup();

  try {
    const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_BOT_TOKEN);

    await registerDiscordCommands(rest, client.user.id);
  } catch (error) {
    console.error("Slash command registration failed:", error);
  }
});

setInterval(() => {
  cleanupCaches();
}, 60_000);

startEggWatchPoller();
startAutoDiscovery();

setInterval(() => {
  const memoryMb = process.memoryUsage().rss / 1024 / 1024;

  if (memoryMb > MEMORY_SOFT_LIMIT_MB) {
    console.warn(
      "Memory pressure detected:",
      Math.round(memoryMb) + "MB",
      "softLimit=" + MEMORY_SOFT_LIMIT_MB + "MB"
    );

    // Drop transient caches first; the catalog/history remain intact.
    petPageCache.clear();
    petStatsCache.clear();
    imageFallbackCache.clear();
  }

  if (memoryMb > MEMORY_HARD_LIMIT_MB) {
    console.error(
      "Memory hard limit exceeded:",
      Math.round(memoryMb) + "MB",
      "hardLimit=" + MEMORY_HARD_LIMIT_MB + "MB",
      "requesting Railway restart."
    );

    saveRuntimeState();
    process.exit(1);
  }
}, 30_000);

setInterval(() => {
  updateLiveFeedHealth();

  console.log(
    "Heartbeat:",
    "ready=" + client.isReady(),
    "source=" + sourceHealth(),
    "eggWatch=" + liveFeedHealth(),
    "detected=" + detectedCount,
    "alerts=" + alertCount,
    "errors=" + monitorErrors,
    "avgLatencyMs=" + (latencySamples
      ? Math.round(totalLatencyMs / latencySamples)
      : "N/A"),
    "rift=" + (RIFT_ALERTS_ENABLED
      ? (riftState.currentBannerName || "waiting")
      : "disabled")
  );
}, 60_000);

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  try {
    if (interaction.commandName === "health-check") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const checks = [];
      const memoryMb = Math.round(process.memoryUsage().rss / 1024 / 1024);

      checks.push(
        (client.isReady() ? "✅" : "❌") + " Discord connection"
      );
      checks.push(
        (CHANNEL_ID ? "✅" : "❌") + " Alert channel configuration"
      );
      checks.push(
        (LAST_SEEN_CHANNEL_ID ? "✅" : "🟡") + " Last Seen channel configuration"
      );
      checks.push(
        (liveFeedHealth() === "ACTIVE" ? "✅" : liveFeedHealth() === "WAITING" ? "🟡" : "❌") +
        " EggWatch feed: " + liveFeedHealth()
      );
      checks.push(
        (AUTO_DISCOVERY_ENABLED ? "✅" : "🟡") +
        " Auto update discovery"
      );
      checks.push(
        (RIFT_ALERTS_ENABLED ? "✅" : "🟡") +
        " Rift tracker: " +
        (riftState.currentBannerName || "WAITING")
      );
      checks.push(
        (RIFT_ALERTS_ENABLED && RIFT_SOURCE_BOT_IDS.size
          ? "✅"
          : "🟡") +
        " Rift source bot filter: " +
        (RIFT_SOURCE_BOT_IDS.size ? "CONFIGURED" : "ALL")
      );
      checks.push(
        (SOURCE_IMAGE_ALPHA_ONLY ? "✅" : "🟡") +
        " Transparent source image mode"
      );
      checks.push(
        (memoryMb < MEMORY_SOFT_LIMIT_MB ? "✅" : memoryMb < MEMORY_HARD_LIMIT_MB ? "🟡" : "❌") +
        " Memory: " + memoryMb + "MB"
      );
      checks.push(
        "🥚 Catalog: " + eggImageCatalog.length + " entries"
      );
      checks.push(
        "🧾 Spawn history: " + spawnHistory.length
      );
      checks.push(
        "🎮 Event history: " + gameEventHistory.length
      );
      checks.push(
        "⏱️ Uptime: " + Math.floor(process.uptime()) + "s"
      );

      return await interaction.editReply({
        content: "**🩺 Notifier Doctor**\\n" + checks.join("\\n")
      });
    }

    if (interaction.commandName === "bot-status") {
      const uptimeSeconds = Math.floor(process.uptime());
      const days = Math.floor(uptimeSeconds / 86400);
      const hours = Math.floor((uptimeSeconds % 86400) / 3600);
      const minutes = Math.floor((uptimeSeconds % 3600) / 60);
      const ping = Math.max(0, Math.round(client.ws.ping));

      const status = [
        "🤖 **Bot:** " + (client.isReady() ? "ONLINE" : "NOT READY"),
        "⚡ **Discord latency:** " + ping + "ms",
        "⏱️ **Uptime:** " + days + "d " + hours + "h " + minutes + "m",
        "📡 **Live monitor:** " + (MONITOR_ENABLED ? "ENABLED" : "DISABLED"),
        "🎯 **Rarities:** " + [...RARITIES].join(", "),
        "📥 **Source channels:** " + (SOURCE_CHANNEL_IDS.size ? [...SOURCE_CHANNEL_IDS].join(", ") : "ALL"),
        "📤 **Alert channel:** " + (CHANNEL_ID ? "CONFIGURED" : "NOT CONFIGURED"),
        "🕒 **Last Seen channel:** " + (LAST_SEEN_CHANNEL_ID ? "CONFIGURED" : "NOT CONFIGURED"),
        "🔔 **Role ping:** " + ALERT_MENTION_MODE.toUpperCase(),
        "📡 **Discord source:** " + sourceHealth(),
        "🌐 **EggWatch feed:** " + liveFeedHealth(),
        "🖼️ **Character PNG:** " + (SOURCE_IMAGE_ALPHA_ONLY ? "ENABLED" : "NORMALIZE"),
        "🔄 **Auto catalog:** " + (AUTO_DISCOVERY_ENABLED ? "ENABLED" : "DISABLED") + " (" + autoDiscoveredCount + " new)",
        "🎮 **Event alerts:** " + (EVENT_ALERTS_ENABLED ? "ON" : "OFF"),
        "🟣 **Rift tracker:** " + (RIFT_ALERTS_ENABLED ? "ON" : "OFF"),
        "🌀 **Current Rift:** " + (riftState.currentBannerName || "WAITING"),
        "⏭️ **Rift next change:** " + (riftState.nextChangeLabel || "Unknown"),
        "🧩 **Rift source filter:** " + (RIFT_SOURCE_BOT_IDS.size ? "BOT FILTER" : "ALL BOTS"),
        "🆕 **Last update:** " + (lastUpdateTitle || "Unknown"),
        "🥚 **Alerts sent:** " + alertCount,
        "🔎 **Eggs detected:** " + detectedCount,
        "⚡ **Average alert latency:** " + (latencySamples
          ? Math.round(totalLatencyMs / latencySamples) + "ms"
          : "N/A"),
        "🛠️ **Errors:** " + monitorErrors,
        "💾 **Cache entries:** " + seen.size,
        "🧾 **Spawn history:** " + spawnHistory.length,
        "🎮 **Game events:** " + gameEventHistory.length,
        "🥚 **Catalog entries:** " + eggImageCatalog.length,
        "🟣 **Secret role:** " + (ALERT_ROLE_IDS.secret ? "SET" : "NOT SET"),
        "🟠 **Eternal role:** " + (ALERT_ROLE_IDS.eternal ? "SET" : "NOT SET"),
        "🔴 **Divine role:** " + (ALERT_ROLE_IDS.divine ? "SET" : "NOT SET"),
        "🩺 **Detailed diagnostics:** /health-check"
      ].join("\n");

      return await interaction.reply({
        content: status,
        flags: MessageFlags.Ephemeral
      });
    }
    if (interaction.commandName === "egg-history") {
      if (!spawnHistory.length) {
        return await interaction.reply({
          content: "📭 No spawn history recorded yet.",
          flags: MessageFlags.Ephemeral
        });
      }

      const historyText = spawnHistory.slice(0, 15).map(item =>
        getRarityEmoji(item.rarity) +
        " **" + item.petName + "** • " +
        item.rarity +
        " • 📍 " + item.area +
        " • <t:" + Math.floor(new Date(item.spawnedAt).getTime() / 1000) + ":R>"
      ).join("\\n");

      return await interaction.reply({
        content: "📜 **Rare Egg Spawn History**\\n" + historyText,
        flags: MessageFlags.Ephemeral
      });
    }

    if (interaction.commandName === "game-events") {
      if (!gameEventHistory.length) {
        return await interaction.reply({
          content: "📭 No game events or updates discovered yet.",
          flags: MessageFlags.Ephemeral
        });
      }

      const eventText = gameEventHistory.slice(0, 10).map(item =>
        "🎮 **" + item.title + "**\\n" +
        (item.description || "No description available.")
      ).join("\\n\\n");

      return await interaction.reply({
        content: "🛰️ **Game Events & Updates**\\n" + eventText.slice(0, 3900),
        flags: MessageFlags.Ephemeral
      });
    }

    if (interaction.commandName === "rift") {
      if (!RIFT_ALERTS_ENABLED) {
        return await interaction.reply({
          content: "🟣 Rift tracker is disabled.",
          flags: MessageFlags.Ephemeral
        });
      }

      if (!riftState.currentBannerKey) {
        return await interaction.reply({
          content: "📭 No Rift banner has been observed yet.",
          flags: MessageFlags.Ephemeral
        });
      }

      const data = getRiftData(riftState.currentBannerKey);
      const pets = data?.pets || [];

      const lines = [
        "🟣 **Current Rift — " + (riftState.currentBannerName || data?.name || "Unknown") + "**",
        "🕒 Changed: " + (riftState.changedLabel || "Unknown"),
        "⏭️ Next Change: " + (riftState.nextChangeLabel || "Unknown"),
        "🎲 Rotation Chance: " + (data?.rotationChance || "Unknown"),
        "",
        "🐾 **Possible Pets**",
        ...pets.map(pet =>
          "**" + pet.name + "** — " + pet.chance + " • " + pet.income
        ),
        "",
        "ℹ️ The rotation percentage is the banner rotation share, not a pet hatch chance."
      ];

      return await interaction.reply({
        content: lines.join("\n").slice(0, 3900),
        flags: MessageFlags.Ephemeral
      });
    }

    if (interaction.commandName === "rift-test") {
      if (!RIFT_ALERTS_ENABLED) {
        return await interaction.reply({
          content: "🟣 Rift tracker is disabled.",
          flags: MessageFlags.Ephemeral
        });
      }

      const requested = interaction.options.getString("banner") || "riftborn";
      const data = getRiftData(requested);

      if (!data) {
        return await interaction.reply({
          content: "❌ Unknown Rift banner.",
          flags: MessageFlags.Ephemeral
        });
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const testEvent = {
        type: "banner",
        bannerKey: requested,
        bannerName: data.name,
        eggName: data.eggName,
        rotationChance: data.rotationChance,
        changedLabel: "Test alert",
        nextChangeLabel: "Test schedule",
        possiblePets: data.pets,
        joinUrl: STEAL_AN_EGG_GAME_URL,
        createdTimestamp: Date.now(),
        sourceName: "Manual Test"
      };

      await sendRiftAlert(testEvent, { test: true });

      return await interaction.editReply({
        content: "✅ Rift test alert sent for **" + data.name + "**."
      });
    }

    if (interaction.commandName === "image-check") {
      const requested = interaction.options.getString("egg", true);
      const entry = findCatalogEgg(requested) || findCatalogPet(requested);

      if (!entry) {
        return await interaction.reply({
          content: "❌ I couldn't find that egg in the verified Secret/Eternal/Divine catalog.",
          flags: MessageFlags.Ephemeral
        });
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const imageUrl = await resolveImageUrl(entry.eggName);
      const imageBuffer = await getPetPngBuffer(entry.petName);
      const stats = await fetchPetGameStats(entry.petName);

      const testEvent = {
        live: true,
        eggName: entry.eggName,
        displayName: entry.petName,
        rarity: entry.rarity,
        biome: entry.biome,
        spawnedAt: new Date().toISOString(),
        imageUrl,
        imageBuffer,
        gameStats: stats
      };

      const embed = buildAlertEmbed(testEvent, null, true);

      return await interaction.editReply({
        content: imageBuffer
          ? "✅ Transparent PNG character image verified for **" + entry.petName + "**."
          : "⚠️ The game record is valid, but no character image was generated for **" + entry.petName + "** yet.",
        embeds: [embed],
        files: imageBuffer
          ? [{
              attachment: imageBuffer,
              name: "egg-character.png",
              description: "Transparent Steal An Egg character image"
            }]
          : undefined
      });
    }

    if (interaction.commandName === "bot-reload") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      seen.clear();
      alertedMessageIds.clear();
      inFlightKeys.clear();
      alertChannel = null;
      petPageCache.clear();
      petPngBufferCache.clear();
      petStatsCache.clear();
      imageFallbackCache.clear();
      resolvedRoleCache.clear();

      if (CHANNEL_ID) {
        await getAlertChannel();
        await validateAlertRoles();
      }

      if (LAST_SEEN_CHANNEL_ID) {
        await ensureLastSeenMessages();
      }

      warmPetImageCache({ workers: 2 }).catch(error => {
        console.error("Reload image warm-up failed:", error);
      });

      const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_BOT_TOKEN);

      await registerDiscordCommands(rest, client.user.id);

      saveRuntimeState();

      return await interaction.editReply({
        content: "✅ Notifier caches refreshed and commands reloaded."
      });
    }

    if (interaction.commandName === "role-test") {
      const rarity = interaction.options.getString("rarity", true);
      const roleId = await resolveAlertRoleId(rarity);

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

    if (interaction.commandName === "egg-test") {
      if (!CHANNEL_ID) {
        return await interaction.reply({
          content: "❌ DISCORD_DEFAULT_CHANNEL_ID is not configured.",
          flags: MessageFlags.Ephemeral
        });
      }

      const requested = interaction.options.getString("egg") || "Gargoyle";
      const entry = findCatalogEgg(requested) || findCatalogPet(requested);

      if (!entry) {
        return await interaction.reply({
          content: "❌ That egg is not in the verified Secret/Eternal/Divine catalog.",
          flags: MessageFlags.Ephemeral
        });
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const beforeAlerts = alertCount;
      const beforeLastSpawn = lastSpawnAt;
      const beforeRecentLength = recentSpawns.length;

      const testEvent = {
        live: true,
        eggName: entry.eggName,
        displayName: entry.petName,
        rarity: entry.rarity,
        biome: entry.biome,
        spawnedAt: new Date().toISOString(),
        source: "Test"
      };

      await sendAlert(testEvent);

      alertCount = beforeAlerts;
      lastSpawnAt = beforeLastSpawn;
      if (recentSpawns.length > beforeRecentLength) {
        recentSpawns.splice(beforeRecentLength);
      }

      return await interaction.editReply({
        content:
          "✅ Test alert sent for **" +
          entry.petName +
          "** (" +
          entry.rarity +
          ")."
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

client.on("shardReconnecting", shardId => {
  alertChannel = null;
  resolvedRoleCache.clear();
  console.warn("Discord shard reconnecting:", shardId);
});

client.on("shardReady", shardId => {
  console.log("Discord shard ready:", shardId);
});

client.on("shardDisconnect", (event, shardId) => {
  alertChannel = null;
  resolvedRoleCache.clear();
  console.warn("Discord shard disconnected:", shardId, event?.code || "unknown");
});

client.on("shardResume", (replayed, shardId) => {
  console.log("Discord shard resumed:", shardId, "replayed=" + replayed);
});

client.on("error", error => console.error("Discord client error:", error));
client.on("shardError", error => console.error("Discord shard error:", error));

process.on("unhandledRejection", error => {
  monitorErrors++;
  console.error(
    "Unhandled rejection after " + Math.floor(process.uptime()) + "s uptime:",
    error
  );
});

process.on("uncaughtException", error => {
  monitorErrors++;
  console.error(
    "Uncaught exception. rssMb=" +
    Math.round(process.memoryUsage().rss / 1024 / 1024) +
    ":",
    error
  );
  saveRuntimeState();
  process.exit(1);
});

async function shutdown(signal) {
  console.log("Received " + signal + ", shutting down gracefully...");

  try {
    saveRuntimeState();
  } catch {}

  if (stateSaveTimer) {
    clearTimeout(stateSaveTimer);
    stateSaveTimer = null;
  }

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
