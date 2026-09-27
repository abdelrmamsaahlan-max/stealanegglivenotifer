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
  MessageFlags,
  PermissionFlagsBits
} from "discord.js";
import { extractMessageData, parseSpawn } from "./parser.js";
import {
  hydrateRuntimeStateFile,
  persistRuntimeState,
  persistSpawnRecord,
  persistGameEvent,
  persistCatalog,
  persistAlertDelivery,
  persistSourceHealth,
  persistenceStats,
  cleanupStorage
} from "./database.js";
import {
  calculateEvidenceConfidence,
  chooseBestUpdate,
  detectCatalogChanges,
  discoveryFingerprint,
  extractDiscoveryEvents,
  extractRelevantLinks,
  extractSupportedEggsFromDiscovery,
  extractUpdateSnapshot,
  mergeEggObservations,
  snapshotEggs
} from "./discovery.js";
import {
  addEvidence,
  anomalyGuard,
  calculateEventConfidence,
  createIncidentId,
  eventFingerprint,
  rankSourceHealth,
  timestampGuard,
  transitionEventState
} from "./reliability.js";
import {
  mergeNearDuplicateFeedCandidates,
  shouldProcessLiveFeedCandidate
} from "./live-feed-gate.js";
import {
  findLowPlayerServers,
  SERVER_FINDER_PLACE_ID,
  SERVER_FINDER_MAX_PLAYERS
} from "./server-finder.js";
import {
  addDeadLetterAlert,
  buildWeeklyReportText,
  getOpsSummary,
  markWeeklyReportSent,
  noteSourceObservation,
  recordLatency,
  recordLifecycle,
  restoreOpsState,
  shouldRunWeeklyReport,
  snapshotOpsState
} from "./ops.js";

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
    .setDescription("View live feed, alerts, images, roles, memory, uptime, and source status."),
  new SlashCommandBuilder()
    .setName("egg-test")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDescription("Admin: send a sample rare-egg alert to test the embed, image, roles, and Join Game button.")
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
    .setName("find")
    .setDescription("Find the most recent sighting of a rare egg.")
    .addStringOption(option =>
      option
        .setName("egg")
        .setDescription("Egg or pet name to search.")
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("server-find")
    .setDescription("Find low-player public Steal An Egg servers for server hopping.")
    .addIntegerOption(option =>
      option
        .setName("max")
        .setDescription("Maximum players allowed in each result (default: 1).")
        .setMinValue(0)
        .setMaxValue(2)
        .setRequired(false)
    ),


  new SlashCommandBuilder()
    .setName("role-test")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
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
    .setName("bot-reload")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDescription("Admin: clear runtime caches, refresh image data, reload roles, and sync Discord commands."),

  new SlashCommandBuilder()
    .setName("spawn-stats")
    .setDescription("View recent tracked spawn statistics by rarity, area, and egg."),
  new SlashCommandBuilder()
    .setName("alerts-pause")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDescription("Admin: pause public rare-egg alert delivery without stopping detection."),
  new SlashCommandBuilder()
    .setName("alerts-resume")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDescription("Admin: resume public rare-egg alert delivery.")
].map(command => command.toJSON());

const ADMIN_COMMANDS = new Set([
  "egg-test",
  "role-test",
  "bot-reload",
  "alerts-pause",
  "alerts-resume"
]);

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

const INGEST_GLOBAL_PER_SECOND =
  Math.max(5, Number(process.env.INGEST_GLOBAL_PER_SECOND || 60));

const SERVER_FINDER_COOLDOWN_MS = 10_000;
const SERVER_FINDER_PAGE_SIZE = 10;
const SERVER_FINDER_MAX_PAGES = 5;
const serverFinderUserCooldowns = new Map();
const serverFinderMessageStates = new Map();

const MAX_HISTORY = 100;
const MAX_EVENT_HISTORY = 30;

const ALERT_QUEUE_MAX =
  Math.max(20, Number(process.env.ALERT_QUEUE_MAX || 100));

const ALERT_QUEUE_WORKERS =
  Math.max(1, Math.min(6, Number(process.env.ALERT_QUEUE_WORKERS || 5)));

const ALERT_QUEUE_RESERVED_LIVE_SLOTS =
  Math.max(1, Math.min(25, Number(process.env.ALERT_QUEUE_RESERVED_LIVE_SLOTS || 15)));

const ALERT_RETRY_LIMIT =
  Math.max(0, Math.min(3, Number(process.env.ALERT_RETRY_LIMIT || 2)));

const SOURCE_STALE_AFTER_MS =
  Math.max(30, Number(process.env.SOURCE_STALE_AFTER_SECONDS || 180)) * 1000;

const LIVE_FEED_ENABLED =
  (process.env.LIVE_FEED_ENABLED || "true").toLowerCase() === "true";

const LIVE_FEED_URLS = [
  ...(process.env.LIVE_SOURCE_URLS || "").split(",")
]
  .map(value => value.trim())
  .filter(Boolean)
  .filter((value, index, array) => array.indexOf(value) === index);

const LIVE_FEED_POLL_MS =
  Math.min(800, Math.max(500, Number(process.env.LIVE_FEED_POLL_MS || 500)));

const LIVE_FEED_TIMEOUT_MS =
  Math.max(1000, Number(process.env.LIVE_FEED_TIMEOUT_MS || 5000));

const LIVE_FEED_MAX_AGE_MS =
  Math.max(60, Number(process.env.LIVE_FEED_MAX_AGE_SECONDS || 600)) * 1000;

const LIVE_FEED_STALE_AFTER_MS =
  Math.max(15, Number(process.env.LIVE_FEED_STALE_AFTER_SECONDS || 30)) * 1000;

const AUTO_DISCOVERY_ENABLED =
  (process.env.AUTO_DISCOVERY_ENABLED || "true").toLowerCase() === "true";

const MEMORY_SOFT_LIMIT_MB =
  Math.max(128, Number(process.env.MEMORY_SOFT_LIMIT_MB || 350));

const MEMORY_HARD_LIMIT_MB =
  Math.max(MEMORY_SOFT_LIMIT_MB + 50, Number(process.env.MEMORY_HARD_LIMIT_MB || 450));

const CONFIGURED_STATE_FILE = String(process.env.RUNTIME_STATE_FILE || "").trim();
const STATE_FILE = path.resolve(
  CONFIGURED_STATE_FILE || path.join(process.cwd(), "data/runtime-state.json")
);
const STATE_BACKUP_FILE = STATE_FILE + ".bak";
const STATE_PERSISTENCE_MODE = CONFIGURED_STATE_FILE
  ? "configured-path"
  : "local-runtime-file";
const DURABLE_VOLUME_CONFIGURED =
  Boolean(process.env.RAILWAY_VOLUME_MOUNT_PATH) ||
  String(process.env.RUNTIME_STATE_DURABLE || "").toLowerCase() === "true";

const ALERT_QUEUE_STALE_AFTER_MS =
  Math.max(10, Number(process.env.ALERT_QUEUE_STALE_AFTER_SECONDS || 45)) * 1000;
const WATCHDOG_INTERVAL_MS =
  Math.max(15, Number(process.env.WATCHDOG_INTERVAL_SECONDS || 30)) * 1000;
const WATCHDOG_RECOVERY_COOLDOWN_MS =
  Math.max(15, Number(process.env.WATCHDOG_RECOVERY_COOLDOWN_SECONDS || 60)) * 1000;
const LIVE_FEED_REPRIME_AGE_MS =
  Math.max(5, Number(process.env.LIVE_FEED_REPRIME_AGE_SECONDS || 15)) * 1000;
const ADMIN_API_TOKEN = String(
  process.env.ADMIN_API_TOKEN || SECRET || ""
).trim();

const ALERT_PIPELINE_SELF_TEST_ONCE =
  String(process.env.ALERT_PIPELINE_SELF_TEST_ONCE || "false").toLowerCase() === "true";

const WEEKLY_RELIABILITY_REPORT_ENABLED =
  String(process.env.WEEKLY_RELIABILITY_REPORT_ENABLED || "true").toLowerCase() === "true";

const WEEKLY_RELIABILITY_REPORT_CHANNEL_ID =
  String(process.env.WEEKLY_RELIABILITY_REPORT_CHANNEL_ID || CHANNEL_ID).trim();

let alertsPaused =
  String(process.env.ALERTS_PAUSED || "false").toLowerCase() === "true";

function loadDiscoverySources() {
  const raw = String(process.env.DISCOVERY_SOURCES_JSON || "").trim();
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter(item => item && typeof item.url === "string" && /^https?:\/\//i.test(item.url))
      .map((item, index) => ({
        key: String(item.key || "source-" + (index + 1)),
        name: String(item.name || "Source " + (index + 1)),
        url: String(item.url).trim(),
        rank: Math.max(0, Math.min(10, Number(item.rank ?? 5))),
        parseUpdates: item.parseUpdates !== false,
        parseEggs: item.parseEggs !== false,
        parseEvents: item.parseEvents !== false,
        followLinks: item.followLinks === true
      }));
  } catch (error) {
    console.warn("Discovery source configuration is invalid:", error?.message || error);
    return [];
  }
}

const AUTO_DISCOVERY_SOURCES = loadDiscoverySources();
const AUTO_DISCOVERY_LINK_LIMIT = 3;
const AUTO_DISCOVERY_POLL_MS = Math.max(
  45_000,
  Number(process.env.AUTO_DISCOVERY_POLL_SECONDS || 90) * 1000
);

let autoDiscoveryTimer = null;
let experimentScheduleTimer = null;
let imageWarmupInFlight = false;
let autoDiscoveryLastFingerprint = "";
let autoDiscoveredCount = 0;
let lastUpdateFingerprint = null;
let lastUpdateCheckAt = null;
let lastUpdateTitle = null;
let autoDiscoverySourceHealth = new Map();
let autoDiscoveryLastSummary = null;
let autoDiscoveryInFlight = false;
let discoveryCatalogSnapshot = {};
let discoveryChangelog = [];
let discoveryLastDecision = null;
let discoveryScanSequence = 0;
const PUBLIC_LIVE_SOURCE_LABEL = "Live Feed";
const PUBLIC_DISCOVERY_SOURCE_LABEL = "Auto Discovery";
const MAX_DISCOVERY_CHANGELOG = 50;
const spawnHistory = [];
const gameEventHistory = [];

const REVENGE_EVENT = Object.freeze({
  id: "6472065313709097739",
  title: "DR. SCRAMBLE’S REVENGE",
  sourceUrl: "https://www.roblox.com/events/6472065313709097739",
  startAt: "2026-09-26T15:00:00.000Z",
  endAt: "2026-09-27T16:00:00.000Z"
});

const REVENGE_EVENT_POLL_MS = 30_000;
const REVENGE_EVENT_SIGNAL_COOLDOWN_MS = 5 * 60_000;
let revengeEventTrackerTimer = null;
let revengeEventLastPhase = null;
let revengeEventLastSignalFingerprint = "";
let revengeEventLastSignalAt = 0;

function getRevengeEventPhase(now = Date.now()) {
  const startAt = Date.parse(REVENGE_EVENT.startAt);
  const endAt = Date.parse(REVENGE_EVENT.endAt);

  if (now < startAt) return "UPCOMING";
  if (now < endAt) return "LIVE";
  return "ENDED";
}

function getRevengeEventHealth() {
  return {
    enabled: true,
    id: REVENGE_EVENT.id,
    title: REVENGE_EVENT.title,
    sourceUrl: REVENGE_EVENT.sourceUrl,
    phase: getRevengeEventPhase(),
    startAt: REVENGE_EVENT.startAt,
    endAt: REVENGE_EVENT.endAt,
    lastObservedPhase: revengeEventLastPhase,
    lastSignalAt: revengeEventLastSignalAt
      ? new Date(revengeEventLastSignalAt).toISOString()
      : null,
    timerActive: Boolean(revengeEventTrackerTimer)
  };
}

function detectRevengeEventSignal(messageData) {
  const text = [
    messageData?.text || "",
    ...(Array.isArray(messageData?.fields)
      ? messageData.fields.flatMap(field => [field?.name || "", field?.value || ""])
      : [])
  ].join("\n");

  const compact = String(text)
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, " ")
    .trim();

  if (!compact) return null;

  if (/dr\.?\s*scramble['’]?s\s+revenge/i.test(compact)) {
    return { type: "event_title" };
  }

  if (
    /dr\.?\s*scramble/i.test(compact) &&
    /final\s+showdown/i.test(compact)
  ) {
    return { type: "final_showdown" };
  }

  if (
    /dr\.?\s*scramble/i.test(compact) &&
    /ben\s+needs\s+your\s+help/i.test(compact)
  ) {
    return { type: "ben_help" };
  }

  return null;
}

async function publishRevengeEventUpdate(reason, signalType = null) {
  const phase = getRevengeEventPhase();

  if (reason === "source-signal") {
    const fingerprint = String(signalType || "signal");
    const now = Date.now();

    if (
      fingerprint === revengeEventLastSignalFingerprint &&
      now - revengeEventLastSignalAt < REVENGE_EVENT_SIGNAL_COOLDOWN_MS
    ) {
      return false;
    }

    revengeEventLastSignalFingerprint = fingerprint;
    revengeEventLastSignalAt = now;
  }

  if (!CHANNEL_ID) return false;

  const channel = await getAlertChannel();
  if (!channel) return false;
  if (!discordCircuitCanSend()) return false;

  const phaseText =
    phase === "LIVE"
      ? "The official event window is LIVE."
      : phase === "UPCOMING"
        ? "The official event window is scheduled."
        : "The official event window has ended.";

  const statusEmoji =
    phase === "LIVE" ? "🟢" : phase === "UPCOMING" ? "🕒" : "🏁";

  const embed = new EmbedBuilder()
    .setTitle("🧪 " + REVENGE_EVENT.title)
    .setDescription(statusEmoji + " " + phaseText)
    .addFields(
      {
        name: "Status",
        value: phase,
        inline: true
      },
      {
        name: "Event Window",
        value: "<t:" + Math.floor(Date.parse(REVENGE_EVENT.startAt) / 1000) +
          ":F> → <t:" + Math.floor(Date.parse(REVENGE_EVENT.endAt) / 1000) + ":F>",
        inline: false
      }
    )
    .setURL(REVENGE_EVENT.sourceUrl)
    .setTimestamp();

  if (reason === "source-signal") {
    embed.addFields({
      name: "Live Signal",
      value: "A matching event signal was detected from the configured source.",
      inline: false
    });
  }

  try {
    await sendDiscordPayload(channel, { embeds: [embed] });

    persistGameEvent({
      type: "official_event",
      title: REVENGE_EVENT.title,
      description:
        reason === "source-signal"
          ? "Live event signal detected."
          : phaseText,
      date: new Date().toISOString(),
      source: PUBLIC_DISCOVERY_SOURCE_LABEL,
      sourceEventId: REVENGE_EVENT.id,
      eventState: phase,
      confidence: reason === "source-signal" ? 0.9 : 1,
      evidence: [{
        source: reason === "source-signal" ? "Discord Source" : "Official Roblox Event",
        type: reason
      }]
    }).catch(error => {
      recordMonitorError("storage", error, "Revenge event state persistence failed");
    });

    scheduleStateSave();
    return true;
  } catch (error) {
    recordMonitorError("discord", error, "Revenge event alert failed");
    return false;
  }
}

async function checkRevengeEventTracker() {
  const phase = getRevengeEventPhase();

  if (phase !== revengeEventLastPhase) {
    const previous = revengeEventLastPhase;
    revengeEventLastPhase = phase;

    // On first boot, announce only when the event is currently live.
    // This avoids replaying an old upcoming/ended state after a restart.
    if (!previous && phase !== "LIVE") return;

    await publishRevengeEventUpdate("official-phase");
  }
}
const LAST_SEEN_RARITIES = ["secret", "eternal", "divine"];
const NON_NEST_SPAWN_EGGS = new Set([
  "bomboclat crocolat egg",
  "strawberry elephant egg",
  "luminous egg",
  "monster egg",
  "brainrot egg"
]);
const NON_NEST_SPAWN_PETS = new Set([
  "bomboclat crocolat",
  "strawberry elephant",
  "cthulhu",
  "electric eel",
  "terra snapper",
  "luminous spike",
  "luminous spirit manta",
  "luminous abyss shark",
  "luminous electric eel",
  "luminous terra snapper",
  "luminous cthulhu",
  "scorpio",
  "mecha scorpio",
  "froggo",
  "mecha froggo",
  "crawler",
  "mecha crawler",
  "dreadscale",
  "mecha dreadscale",
  "krakenoid",
  "mecha krakenoid",
  "crocodon",
  "mecha crocodon"
]);
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
const lastSeenMessageCache = new Map();
let lastSeenChannel = null;
let lastSeenMessagesReady = false;
let lastSeenMessagesInitInFlight = null;
const lastSeenUpdateTimers = new Map();
const lastSeenUpdateInFlight = new Map();
const lastSeenContentFingerprints = new Map();
const eggCustomEmojiCache = new Map();
const eggCustomEmojiSetupState = {
  running: false,
  ready: false,
  lastError: null
};

const adminCommandUsage = new Map();
const ADMIN_COMMAND_MAX_PER_MINUTE = 15;
const ADMIN_COMMAND_WINDOW_MS = 60_000;
const ADMIN_COMMAND_COOLDOWN_MS = 3_000;

function consumeAdminCommandRateLimit(userId, commandName) {
  const key = String(userId || "unknown") + "|" + String(commandName || "unknown");
  const now = Date.now();
  const previous = adminCommandUsage.get(key) || [];
  const recent = previous.filter(at => now - at < ADMIN_COMMAND_WINDOW_MS);

  if (
    recent.length >= ADMIN_COMMAND_MAX_PER_MINUTE ||
    (recent.length && now - recent[recent.length - 1] < ADMIN_COMMAND_COOLDOWN_MS)
  ) {
    adminCommandUsage.set(key, recent);
    return false;
  }

  recent.push(now);
  adminCommandUsage.set(key, recent);
  return true;
}

function cleanupAdminCommandUsage(now = Date.now()) {
  for (const [key, timestamps] of adminCommandUsage) {
    const recent = timestamps.filter(at => now - at < ADMIN_COMMAND_WINDOW_MS);

    if (recent.length) {
      adminCommandUsage.set(key, recent);
    } else {
      adminCommandUsage.delete(key);
    }
  }
}

function loadRuntimeState() {
  try {
    const stateCandidates = [STATE_FILE, STATE_BACKUP_FILE];
    let loadedPath = null;
    let rawState = null;

    for (const candidate of stateCandidates) {
      try {
        if (!fs.existsSync(candidate)) continue;
        const candidateRaw = fs.readFileSync(candidate, "utf8");
        JSON.parse(candidateRaw);
        loadedPath = candidate;
        rawState = candidateRaw;
        break;
      } catch {
        // Fall back to the backup if the primary state file is incomplete.
      }
    }

    if (!loadedPath || !rawState) return;

    const state = JSON.parse(rawState);
    restoreOpsState(state?.ops || {});
    if (typeof state?.alertsPaused === "boolean") {
      alertsPaused = state.alertsPaused;
    }

    if (Array.isArray(state.spawnHistory)) {
      spawnHistory.push(...state.spawnHistory.slice(0, MAX_HISTORY));
    }

    if (Array.isArray(state.gameEventHistory)) {
      gameEventHistory.push(
        ...state.gameEventHistory
          .slice(0, MAX_EVENT_HISTORY)
          .map(item => ({
            ...item,
            source:
              item?.source === "Manual Test"
                ? "Manual Test"
                : PUBLIC_DISCOVERY_SOURCE_LABEL
          }))
      );
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
            lastSeenByRarity[rarity].set(eggIdentityKey(record.eggName), {
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

    if (state.deliveredAlertKeys && typeof state.deliveredAlertKeys === "object") {
      for (const [key, value] of Object.entries(state.deliveredAlertKeys)) {
        if (key && Number.isFinite(Number(value)) && Number(value) > Date.now()) {
          deliveredAlertKeys.set(key, Number(value));
        }
      }
    }

    if (state.seenSemanticKeys && typeof state.seenSemanticKeys === "object") {
      for (const [key, value] of Object.entries(state.seenSemanticKeys)) {
        if (key && Number.isFinite(Number(value))) {
          seen.set(key, Number(value));
        }
      }
    }

    if (state.liveFeed && typeof state.liveFeed === "object") {
      liveFeedLastFingerprint =
        typeof state.liveFeed.lastFingerprint === "string"
          ? state.liveFeed.lastFingerprint
          : null;
      liveFeedLastEventAt =
        typeof state.liveFeed.lastEventAt === "string"
          ? state.liveFeed.lastEventAt
          : null;
      liveFeedPrimed = state.liveFeed.primed === true;

      for (const [key, value] of Object.entries(state.liveFeed.processedEvents || {})) {
        if (
          key &&
          Number.isFinite(Number(value)) &&
          Number(value) > Date.now() - LIVE_FEED_EVENT_DEDUP_MS
        ) {
          liveFeedProcessedEvents.set(key, Number(value));
        }
      }
    }

    if (state.alertedMessageIds && typeof state.alertedMessageIds === "object") {
      for (const [key, value] of Object.entries(state.alertedMessageIds)) {
        if (key && Number.isFinite(Number(value))) {
          alertedMessageIds.set(key, Number(value));
        }
      }
    }

    if (state.reliability && typeof state.reliability === "object") {
      for (const [key, values] of Object.entries(state.reliability.evidence || {})) {
        if (key && Array.isArray(values)) reliabilityEvidence.set(key, values.slice(0, 8));
      }
      for (const [key, value] of Object.entries(state.reliability.incidents || {})) {
        if (key && typeof value === "string") reliabilityIncidents.set(key, value);
      }
      for (const [key, values] of Object.entries(state.reliability.occurrences || {})) {
        if (key && Array.isArray(values)) {
          reliabilityOccurrences.set(
            key,
            values.map(Number).filter(Number.isFinite).slice(-30)
          );
        }
      }
    }

    if (typeof state.lastUpdateFingerprint === "string") {
      lastUpdateFingerprint = state.lastUpdateFingerprint;
    }

    if (typeof state.lastUpdateTitle === "string") {
      lastUpdateTitle = state.lastUpdateTitle;
    }

    if (state.discoveryState && typeof state.discoveryState === "object") {
      if (state.discoveryState.catalogSnapshot && typeof state.discoveryState.catalogSnapshot === "object") {
        discoveryCatalogSnapshot = state.discoveryState.catalogSnapshot;
      }

      if (Array.isArray(state.discoveryState.changelog)) {
        discoveryChangelog = state.discoveryState.changelog
          .filter(item => item && typeof item === "object")
          .slice(0, MAX_DISCOVERY_CHANGELOG);
      }

      if (state.discoveryState.lastDecision && typeof state.discoveryState.lastDecision === "object") {
        discoveryLastDecision = state.discoveryState.lastDecision;
      }

      if (Number.isFinite(Number(state.discoveryState.scanSequence))) {
        discoveryScanSequence = Number(state.discoveryState.scanSequence);
      }

      if (Array.isArray(state.discoveryState.sourceHealth)) {
        autoDiscoverySourceHealth = new Map(
          state.discoveryState.sourceHealth
            .filter(item => item && item.key)
            .map(item => [item.key, item])
        );
      }
    }

    if (Array.isArray(state.dynamicEggs)) {
      for (const entry of state.dynamicEggs.slice(0, 50)) {
        if (
          entry &&
          entry.source === "Auto Discovery" &&
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
      "events=" + gameEventHistory.length,
      "file=" + loadedPath
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
      version: 7,
      savedAt: new Date().toISOString(),
      alertsPaused,
      lastUpdateFingerprint,
      lastUpdateTitle,
      discoveryState: {
        catalogSnapshot: discoveryCatalogSnapshot,
        changelog: discoveryChangelog.slice(0, MAX_DISCOVERY_CHANGELOG),
        lastDecision: discoveryLastDecision,
        scanSequence: discoveryScanSequence,
        sourceHealth: discoverySummary()
      },
      deliveredAlertKeys: Object.fromEntries(
        [...deliveredAlertKeys.entries()]
          .filter(([, expiresAt]) => Number(expiresAt) > Date.now())
          .slice(0, 500)
      ),
      seenSemanticKeys: Object.fromEntries(
        [...seen.entries()]
          .slice(-500)
      ),
      alertedMessageIds: Object.fromEntries(
        [...alertedMessageIds.entries()]
          .slice(-500)
      ),
      alertPipelineSelfTestAt,
      alertPipelineSelfTestResult,
      liveFeed: {
        primed: liveFeedPrimed,
        lastFingerprint: liveFeedLastFingerprint,
        lastEventAt: liveFeedLastEventAt,
        processedEvents: Object.fromEntries(
          [...liveFeedProcessedEvents.entries()]
            .filter(([, seenAt]) => Number(seenAt) > Date.now() - LIVE_FEED_EVENT_DEDUP_MS)
            .slice(-500)
        )
      },
      reliability: {
        evidence: Object.fromEntries(
          [...reliabilityEvidence.entries()]
            .slice(-300)
            .map(([key, values]) => [key, Array.isArray(values) ? values.slice(0, 8) : []])
        ),
        incidents: Object.fromEntries([...reliabilityIncidents.entries()].slice(-300)),
        occurrences: Object.fromEntries(
          [...reliabilityOccurrences.entries()]
            .slice(-300)
            .map(([key, values]) => [key, Array.isArray(values) ? values.slice(-30) : []])
        )
      },
      ops: snapshotOpsState(),
      spawnHistory: spawnHistory.slice(0, MAX_HISTORY),
      gameEventHistory: gameEventHistory.slice(0, MAX_EVENT_HISTORY),
      lastSeenMessageIds,
      lastSeenByRarity: Object.fromEntries(
        LAST_SEEN_RARITIES.map(rarity => [
          rarity,
          Object.fromEntries(lastSeenByRarity[rarity])
        ])
      ),
      dynamicEggs: eggImageCatalog
        .filter(entry => entry?.source === "Auto Discovery")
        .slice(0, 50)
    };

    const tempFile = STATE_FILE + ".tmp";
    fs.writeFileSync(tempFile, JSON.stringify(payload), "utf8");

    if (fs.existsSync(STATE_FILE)) {
      try {
        fs.copyFileSync(STATE_FILE, STATE_BACKUP_FILE);
      } catch {
        // Best-effort backup; atomic primary save still proceeds.
      }
    }

    fs.renameSync(tempFile, STATE_FILE);
    persistRuntimeState(payload).catch(error => {
      recordMonitorError("storage", error, "Supabase runtime state save failed");
    });
  } catch (error) {
    recordMonitorError("storage", error, "Runtime state save failed");
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
const liveFeedProcessedEvents = new Map();
const LIVE_FEED_EVENT_DEDUP_MS =
  Math.max(60, Number(process.env.LIVE_FEED_EVENT_DEDUP_SECONDS || 900)) * 1000;
const LIVE_FEED_EVENT_MERGE_MS = 20_000;
const ALERT_SEMANTIC_DEDUP_BUCKET_MS = 20_000;

let eggImageCatalog = [];
try {
  const catalogPath = path.resolve(process.cwd(), "data/eggs.json");
  const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  eggImageCatalog = Array.isArray(catalog.eggs) ? catalog.eggs : [];
} catch (error) {
  console.warn("Egg image catalog could not be loaded:", error?.message || error);
}

function dedupeCatalogEntries() {
  const unique = new Map();
  let removed = 0;

  for (const entry of eggImageCatalog) {
    if (!entry || typeof entry !== "object") continue;

    const rawName = String(
      entry.eggName ||
      entry.displayName ||
      (entry.petName ? entry.petName + " Egg" : "")
    ).trim();

    const key = eggIdentityKey(rawName);

    if (!key) continue;

    // Auto Discovery must never turn update/version headings into pets.
    if (
      entry.source === "Auto Discovery" &&
      /^(?:update|version)\s*\d+/i.test(rawName)
    ) {
      removed++;
      continue;
    }

    const existing = unique.get(key);
    if (!existing) {
      unique.set(key, entry);
      continue;
    }

    removed++;
    existing.aliases = [
      ...new Set([
        ...(Array.isArray(existing.aliases) ? existing.aliases : []),
        ...(Array.isArray(entry.aliases) ? entry.aliases : []),
        entry.eggName,
        entry.displayName,
        entry.petName
      ].filter(Boolean))
    ];

    if ((!existing.biome || existing.biome === "Unknown") && entry.biome) {
      existing.biome = entry.biome;
    }

    if (!existing.sourcePage && entry.sourcePage) {
      existing.sourcePage = entry.sourcePage;
    }

    if (!existing.petName && entry.petName) {
      existing.petName = entry.petName;
    }
  }

  if (removed) {
    eggImageCatalog = [...unique.values()];
    scheduleStateSave();
    console.log("Catalog duplicate cleanup removed:", removed, "duplicate entries");
  }
}

// Catalog identity helpers are initialized before restoring runtime state.
 // Runtime state may contain Auto Discovery entries that need canonical catalog matching.
 // Keep restoration after these helpers exist so there is no temporal-dead-zone lookup.


function eggIdentityKey(value) {
  return normalizeFeedKey(value)
    .replace(/^(?:secret|eternal|divine)\s+/, "")
    .replace(/\s+egg$/i, "")
    .trim();
}

const verifiedCatalogByIdentity = new Map(
  eggImageCatalog
    .filter(entry => entry?.source !== "Auto Discovery")
    .map(entry => [eggIdentityKey(entry.eggName || entry.displayName || entry.petName), entry])
    .filter(([key]) => Boolean(key))
);

function findCatalogEgg(input) {
  const wanted = normalizeFeedKey(input);
  if (!wanted) return null;

  const identity = eggIdentityKey(wanted);

  // Always resolve against the live in-memory catalog first. This handles:
  // - rarity-prefixed feeds such as "Divine Kitsune Egg"
  // - alias names
  // - Auto Discovery entries added after startup
  // without relying on a stale startup-only index.
  const direct = eggImageCatalog.find(entry => {
    const names = [
      entry?.eggName,
      entry?.displayName,
      ...(Array.isArray(entry?.aliases) ? entry.aliases : []),
      entry?.petName ? entry.petName + " Egg" : ""
    ].filter(Boolean);

    return names.some(name => {
      const normalized = normalizeFeedKey(name);
      const normalizedIdentity = eggIdentityKey(normalized);
      return normalized === wanted || normalizedIdentity === identity;
    });
  });

  return direct || verifiedCatalogByIdentity.get(identity) || null;
}

// Runtime state is restored at startup after the remote Supabase snapshot is hydrated.
dedupeCatalogEntries();
rebuildLastSeenFromHistory().catch(error => {
  console.warn("Last Seen history rebuild failed:", error?.message || error);
});

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
    source: "Auto Discovery",
    _runtimeOnlyKey: normalized
  };
}

function ensureCatalogEgg(eggName, rarity, area = "Unknown") {
  const eggKey = normalizeFeedKey(eggName);
  const areaKey = normalizeFeedKey(area);

  if (
    NON_NEST_SPAWN_EGGS.has(eggKey) ||
    areaKey === "event" ||
    areaKey === "shop" ||
    areaKey === "robux" ||
    areaKey === "area not listed"
  ) {
    return null;
  }

  const petKey = normalizeFeedKey(String(eggName).replace(/\s+Egg$/i, ""));

  // Canonical + pet-key lookup prevents Auto Discovery from creating
  // duplicate runtime entries when an upstream source uses "Divine Kitsune Egg"
  // while the verified catalog stores "Kitsune Egg" with that form as an alias.
  let existing = eggImageCatalog.find(candidate => {
    const candidateEggKey = normalizeFeedKey(
      candidate?.eggName ||
      candidate?.displayName ||
      (candidate?.petName ? candidate.petName + " Egg" : "")
    );
    const candidatePetKey = normalizeFeedKey(candidate?.petName || "");

    return candidateEggKey === eggKey || candidatePetKey === petKey;
  }) || findCatalogEgg(eggName);

  if (!existing) {
    existing = eggImageCatalog.find(candidate => {
      const candidatePetKey = normalizeFeedKey(candidate?.petName || "");
      const aliases = Array.isArray(candidate?.aliases)
        ? candidate.aliases.map(normalizeFeedKey)
        : [];

      return (
        candidatePetKey === petKey ||
        aliases.includes(petKey) ||
        aliases.includes(normalizeFeedKey(eggName))
      );
    }) || null;

    if (existing) {
      const canonicalKey = normalizeFeedKey(existing.eggName);
      const incomingKey = normalizeFeedKey(eggName);

      if (canonicalKey !== incomingKey) {
        existing.aliases = [
          ...new Set([
            ...(Array.isArray(existing.aliases) ? existing.aliases : []),
            eggName,
            String(eggName).replace(/\s+Egg$/i, "")
          ])
        ];
        console.log(
          "Auto catalog repair: merged alias",
          eggName,
          "into",
          existing.eggName
        );
      }

      if (
        rarity &&
        ["Secret", "Eternal", "Divine"].includes(normalizeRarityName(rarity))
      ) {
        existing.rarity = normalizeRarityName(rarity);
      }

      if (area && area !== "Unknown") {
        existing.biome = String(area).trim();
      }

      persistCatalog([existing]).catch(error => {
        recordMonitorError("storage", error, "Supabase catalog persistence failed");
      });
      scheduleStateSave();
      return existing;
    }
  }

  if (!AUTO_DISCOVERY_ENABLED) return null;

  const dynamic = buildDynamicCatalogEntry(eggName, rarity, area);
  if (!dynamic) return null;

  eggImageCatalog.push(dynamic);
  registerPetImageDatabaseEntry(dynamic);
  dedupeCatalogEntries();

  // If canonical cleanup found an older equivalent entry, keep that entry and
  // do not misreport the observation as a genuinely new catalog item.
  const canonicalIdentity = eggIdentityKey(dynamic.eggName);
  const canonicalEntry =
    eggImageCatalog.find(candidate => {
      const rawName =
        candidate?.eggName ||
        candidate?.displayName ||
        (candidate?.petName ? candidate.petName + " Egg" : "");
      return eggIdentityKey(rawName) === canonicalIdentity;
    }) || dynamic;

  persistCatalog([canonicalEntry]).catch(error => {
    recordMonitorError("storage", error, "Supabase catalog persistence failed");
  });
  scheduleStateSave();

  if (canonicalEntry !== dynamic) {
    return canonicalEntry;
  }

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

const ADMIN_API_RATE_LIMIT_PER_MINUTE =
  Math.max(1, Number(process.env.ADMIN_API_RATE_LIMIT_PER_MINUTE || 6));

const IMAGE_PROXY_RATE_LIMIT_PER_MINUTE =
  Math.max(1, Number(process.env.IMAGE_PROXY_RATE_LIMIT_PER_MINUTE || 30));

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
const adminApiRate = new Map();
const imageProxyRate = new Map();
const inFlightKeys = new Set();
const deliveredAlertKeys = new Map();
const alertDeliveryInFlight = new Set();
const ALERT_DELIVERY_DEDUP_MS =
  Math.max(120, Number(process.env.ALERT_DELIVERY_DEDUP_SECONDS || 900)) * 1000;

const MIN_ALERT_CONFIDENCE =
  Math.min(0.95, Math.max(0.50, Number(process.env.MIN_ALERT_CONFIDENCE || 0.70)));

const reliabilityEvidence = new Map();
const reliabilityIncidents = new Map();
const reliabilityOccurrences = new Map();
const reliabilityMetrics = {
  corroborated: 0,
  anomalyFlags: 0,
  timestampSuppressions: 0,
  confidenceSuppressions: 0,
  lastSuppression: null
};

const alertQueues = {
  live: [],
  source: [],
  api: []
};
const alertQueueKeys = new Set();
let alertQueueActive = 0;

function alertQueueName(event) {
  if (event?.source === "Live Feed") return "live";
  if (event?.source === "Signed API") return "api";
  return "source";
}

function alertQueueDepth(name = null) {
  if (name && alertQueues[name]) return alertQueues[name].length;
  return Object.values(alertQueues).reduce((total, queue) => total + queue.length, 0);
}
const ingestGlobalTimestamps = [];

const DISCORD_CIRCUIT_FAILURE_THRESHOLD = Math.max(
  2,
  Number(process.env.DISCORD_CIRCUIT_FAILURE_THRESHOLD || 3)
);
const DISCORD_CIRCUIT_OPEN_MS = Math.max(
  5_000,
  Number(process.env.DISCORD_CIRCUIT_OPEN_SECONDS || 15) * 1000
);

const discordCircuit = {
  state: "CLOSED",
  failures: 0,
  openedAt: 0,
  lastFailureAt: null,
  lastSuccessAt: null
};

function discordCircuitCanSend() {
  if (discordCircuit.state === "CLOSED") return true;

  if (discordCircuit.state === "OPEN") {
    if (Date.now() - discordCircuit.openedAt < DISCORD_CIRCUIT_OPEN_MS) {
      return false;
    }

    discordCircuit.state = "HALF_OPEN";
  }

  return true;
}

function recordDiscordSendSuccess() {
  discordCircuit.state = "CLOSED";
  discordCircuit.failures = 0;
  discordCircuit.lastSuccessAt = new Date().toISOString();
}

function recordDiscordSendFailure(error) {
  discordCircuit.failures++;
  discordCircuit.lastFailureAt = new Date().toISOString();

  if (discordCircuit.failures >= DISCORD_CIRCUIT_FAILURE_THRESHOLD) {
    discordCircuit.state = "OPEN";
    discordCircuit.openedAt = Date.now();
  }
}

function discordCircuitRetryAfterSeconds() {
  if (discordCircuit.state !== "OPEN") return 0;
  return Math.max(
    1,
    Math.ceil((DISCORD_CIRCUIT_OPEN_MS - (Date.now() - discordCircuit.openedAt)) / 1000)
  );
}

const alertMetrics = {
  duplicateSuppressed: 0,
  sendFailures: 0,
  queueRejected: 0,
  queueRetried: 0,
  queueStalePromoted: 0,
  lastSuccessAt: null,
  lastFailureAt: null,
  byRarity: {
    secret: 0,
    eternal: 0,
    divine: 0
  },
  byArea: new Map()
};

const errorMetrics = {
  source: 0,
  discord: 0,
  image: 0,
  queue: 0,
  discovery: 0,
  storage: 0,
  other: 0
};

let lastErrorCategory = null;
let lastErrorAt = null;

function recordMonitorError(category = "other", error = null, context = "") {
  const key = Object.prototype.hasOwnProperty.call(errorMetrics, category)
    ? category
    : "other";

  monitorErrors++;
  errorMetrics[key]++;
  lastErrorCategory = key;
  lastErrorAt = new Date().toISOString();

  if (error && context) {
    console.error(context + ":", error?.message || error);
  }
}

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
let alertPipelineSelfTestAt = null;
let alertPipelineSelfTestResult = null;
let alertPipelineSelfTestInFlight = false;
let alertPipelineSelfTestRunThisProcess = false;
let liveFeedLastUrl = null;
let liveFeedLastPollAt = null;
let liveFeedEventsReceived = 0;
let liveFeedEventsAccepted = 0;
let liveFeedErrors = 0;
let liveFeedPrimed = false;
let liveFeedLastSuccessAt = null;
let liveFeedHealthState = "WAITING";
const liveFeedEndpointCooldownUntil = new Map();
const liveFeedEndpointHealth = new Map();
const liveFeedHealthPersistedAt = new Map();
let liveFeedConsecutiveFailures = 0;
let liveFeedRecoveryCount = 0;
let liveFeedPrimaryUrl = null;
const LIVE_FEED_404_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const LIVE_FEED_ERROR_COOLDOWN_MS = 15 * 1000;

function updateLiveFeedEndpointHealth(url, patch = {}) {
  const index = LIVE_FEED_URLS.indexOf(url);
  const key = index >= 0 ? index + 1 : "unknown";
  const previous = liveFeedEndpointHealth.get(key) || {
    endpoint: key,
    status: "WAITING",
    checkedAt: null,
    httpStatus: null,
    failures: 0,
    lastErrorAt: null,
    lastSuccessAt: null
  };

  const next = {
    ...previous,
    ...patch,
    endpoint: key,
    checkedAt: new Date().toISOString()
  };

  const recovered =
    next.status === "ACTIVE" &&
    previous.status &&
    previous.status !== "ACTIVE" &&
    (previous.failures || 0) > 0;

  if (recovered) {
    liveFeedRecoveryCount++;
    next.recoveredAt = new Date().toISOString();
    console.log("Live feed endpoint recovered:", "endpoint=" + key);
  }

  if (next.status === "ACTIVE") {
    liveFeedPrimaryUrl = url;
  }

  liveFeedEndpointHealth.set(key, next);

  const persistedAt = liveFeedHealthPersistedAt.get(key) || 0;
  const shouldPersist =
    previous.status !== next.status ||
    previous.httpStatus !== next.httpStatus ||
    Date.now() - persistedAt >= 60_000;

  if (shouldPersist) {
    liveFeedHealthPersistedAt.set(key, Date.now());
    persistSourceHealth({
      key: "live-feed-" + key,
      url,
      status: next.status,
      lastSuccessAt: next.lastSuccessAt,
      lastErrorAt: next.lastErrorAt,
      consecutiveFailures: Number(next.failures || 0),
      latencyMs: Number.isFinite(Number(next.latencyMs))
        ? Number(next.latencyMs)
        : null,
      value: next
    }).catch(error => {
      recordMonitorError("storage", error, "Supabase live feed health persistence failed");
    });
  }

  return recovered;
}

function liveFeedEndpointCoolingDown(url) {
  return Date.now() < (liveFeedEndpointCooldownUntil.get(url) || 0);
}

function coolDownLiveFeedEndpoint(url, status = null) {
  const delay = Number(status) === 404
    ? LIVE_FEED_404_COOLDOWN_MS
    : LIVE_FEED_ERROR_COOLDOWN_MS;

  liveFeedEndpointCooldownUntil.set(url, Date.now() + delay);
}

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

function reliabilityCorrelationKey(event) {
  const timestamp = event?.spawnedAt ||
    event?.occurredAt ||
    event?.appearedAt ||
    event?.createdTimestamp ||
    event?.date ||
    Date.now();
  const parsed = new Date(timestamp).getTime();
  const bucket = Number.isFinite(parsed)
    ? Math.floor(parsed / 30_000)
    : Math.floor(Date.now() / 30_000);

  return [
    normalizeFeedKey(event?.rarity || event?.type || "event"),
    normalizeFeedKey(
      event?.eggName ||
      event?.bannerKey ||
      event?.bossName ||
      event?.title ||
      "event"
    ),
    normalizeFeedKey(event?.biome || event?.area || "unknown"),
    bucket
  ].join("|");
}

function reliabilitySourceName(event) {
  return String(
    event?.source ||
    event?.sourceName ||
    "unknown"
  ).trim() || "unknown";
}

function reliabilitySourceRank(event) {
  const source = reliabilitySourceName(event);
  if (source === "Live Feed") return 10;
  if (source === "Signed API") return 9;
  if (source === "Discord Source") return 8;
  if (source === PUBLIC_DISCOVERY_SOURCE_LABEL || source === "Auto Discovery") return 7;
  if (source === "Manual Test" || source === "Test") return 10;
  return 5;
}

function eventOccurredAt(event) {
  return event?.spawnedAt ||
    event?.occurredAt ||
    event?.appearedAt ||
    event?.createdTimestamp ||
    event?.date ||
    null;
}

function persistSuppressedDetection(event, reason, confidence, evidence) {
  persistGameEvent({
    source: reliabilitySourceName(event),
    type: "suppressed_detection",
    title: String(
      event?.title ||
      event?.eggName ||
      event?.bannerName ||
      event?.bossName ||
      "Detection"
    ).slice(0, 200),
    description: String(reason || "reliability_guard").slice(0, 800),
    date: (() => {
      const value = eventOccurredAt(event);
      const parsed = value == null ? NaN : new Date(value).getTime();
      return Number.isFinite(parsed)
        ? new Date(parsed).toISOString()
        : new Date().toISOString();
    })(),
    sourceEventId:
      event?.sourceEventId ||
      event?.sourceMessageId ||
      event?.messageId ||
      null,
    incidentId: event?.incidentId || null,
    confidence: Number(confidence || 0),
    eventState: "SUPPRESSED",
    evidence: Array.isArray(evidence) ? evidence.slice(0, 8) : []
  }).catch(error => {
    recordMonitorError("storage", error, "Suppressed detection persistence failed");
  });
}

function evaluateEventReliability(event, options = {}) {
  if (!event || typeof event !== "object") {
    return { ok: false, reason: "invalid_event", confidence: 0, evidence: [] };
  }

  const source = reliabilitySourceName(event);
  const sourceRank = reliabilitySourceRank(event);
  const correlationKey = reliabilityCorrelationKey(event);
  const now = Date.now();
  const occurredAt = eventOccurredAt(event);

  const timeGuard = timestampGuard(occurredAt, {
    now,
    maxPastMs:
      source === "Live Feed"
        ? Math.max(LIVE_FEED_MAX_AGE_MS, 10 * 60_000)
        : 2 * 60 * 60_000,
    maxFutureMs: Math.max(30_000, MAX_INGEST_SKEW_SECONDS * 1000)
  });

  if (!timeGuard.ok) {
    reliabilityMetrics.timestampSuppressions++;
    reliabilityMetrics.lastSuppression = {
      reason: timeGuard.reason,
      source,
      at: new Date().toISOString()
    };
    persistSuppressedDetection(
      event,
      timeGuard.reason,
      0,
      reliabilityEvidence.get(correlationKey) || []
    );
    event.suppressedReason = timeGuard.reason;
    return {
      ok: false,
      reason: timeGuard.reason,
      confidence: 0,
      evidence: reliabilityEvidence.get(correlationKey) || []
    };
  }

  const evidence = addEvidence(
    reliabilityEvidence.get(correlationKey) || [],
    {
      source,
      sourceKey: source,
      sourceEventId:
        event?.sourceEventId ||
        event?.sourceMessageId ||
        event?.messageId ||
        null,
      observedAt: new Date(now).toISOString(),
      parser: options.parser || String(event?.type || "event")
    }
  );

  reliabilityEvidence.set(correlationKey, evidence);

  const confidence = calculateEventConfidence({
    source,
    sourceRank,
    parserConfidence: Number.isFinite(Number(options.parserConfidence))
      ? Number(options.parserConfidence)
      : 0.85,
    evidence,
    occurredAt,
    now
  });

  if (new Set(evidence.map(item => item?.sourceKey || item?.source).filter(Boolean)).size > 1) {
    reliabilityMetrics.corroborated++;
  }

  const occurrenceKey = eventFingerprint({
    ...event,
    source: undefined,
    sourceEventId: undefined
  });

  const recentOccurrences = (reliabilityOccurrences.get(occurrenceKey) || [])
    .filter(at => now - Number(at) <= 60_000)
    .slice(-30);

  const anomaly = anomalyGuard({
    event,
    now,
    occurrenceTimes: recentOccurrences,
    burstWindowMs: 30_000,
    burstLimit: 8
  });

  if (anomaly.anomaly) reliabilityMetrics.anomalyFlags++;
  recentOccurrences.push(now);
  reliabilityOccurrences.set(occurrenceKey, recentOccurrences.slice(-30));

  let incidentId = reliabilityIncidents.get(correlationKey);
  if (!incidentId) {
    incidentId = createIncidentId(
      event?.rarity ? "EGG" :
      event?.type === "scramble_boss" ? "SCR" :
      (event?.bannerKey || event?.bossName) ? "RIFT" : "EVT"
    );
    reliabilityIncidents.set(correlationKey, incidentId);
  }

  const effectiveConfidence = anomaly.anomaly
    ? Math.max(0, confidence * 0.65)
    : confidence;

  event.incidentId = incidentId;
  event.evidence = evidence;
  event.verificationCount = new Set(
    evidence.map(item => item?.sourceKey || item?.source).filter(Boolean)
  ).size;
  event.confidence = Number(effectiveConfidence.toFixed(4));
  event.eventState = transitionEventState({
    occurredAt,
    now,
    cycleMs: 30 * 60_000,
    activeMs: 5 * 60_000
  });

  if (effectiveConfidence < MIN_ALERT_CONFIDENCE) {
    reliabilityMetrics.confidenceSuppressions++;
    reliabilityMetrics.lastSuppression = {
      reason: "low_confidence",
      source,
      confidence: effectiveConfidence,
      at: new Date().toISOString()
    };
    persistSuppressedDetection(event, "low_confidence", effectiveConfidence, evidence);
    event.suppressedReason = "low_confidence";
    return {
      ok: false,
      reason: "low_confidence",
      confidence: effectiveConfidence,
      evidence
    };
  }

  return {
    ok: true,
    incidentId,
    confidence: effectiveConfidence,
    evidence,
    verificationCount: event.verificationCount,
    eventState: event.eventState,
    anomaly: anomaly.anomaly,
    correlationKey
  };
}

function reliabilitySummary() {
  const corroboratedEvents = [...reliabilityEvidence.values()].filter(items =>
    new Set(
      (items || []).map(item => item?.sourceKey || item?.source).filter(Boolean)
    ).size > 1
  ).length;

  return {
    minConfidence: MIN_ALERT_CONFIDENCE,
    trackedCorrelations: reliabilityEvidence.size,
    trackedIncidents: reliabilityIncidents.size,
    corroboratedEvents,
    anomalyFlags: reliabilityMetrics.anomalyFlags,
    timestampSuppressions: reliabilityMetrics.timestampSuppressions,
    confidenceSuppressions: reliabilityMetrics.confidenceSuppressions,
    lastSuppression: reliabilityMetrics.lastSuppression
  };
}

function alertDeliveryKeys(event) {
  const rarity = normalizeFeedKey(event?.rarity);
  const egg = normalizeFeedKey(event?.eggName || event?.displayName);
  const area = normalizeFeedKey(event?.biome || "unknown");
  const parsedTime = Date.parse(event?.spawnedAt || "");
  // Absorb tiny source timestamp differences while keeping separate spawns distinct.
  const timeBucket = Number.isFinite(parsedTime)
    ? Math.floor(parsedTime / 10_000)
    : Math.floor(Date.now() / 10_000);

  const keys = [
    "core|" + rarity + "|" + egg + "|" + area + "|" + timeBucket
  ];

  // Cross-source observations can have different IDs and a few seconds of
  // timestamp drift. Persist a short source-independent claim as well.
  const semanticBucket = Number.isFinite(parsedTime)
    ? Math.round(parsedTime / ALERT_SEMANTIC_DEDUP_BUCKET_MS)
    : null;
  if (semanticBucket !== null) {
    keys.push("semantic|" + rarity + "|" + egg + "|" + area + "|" + semanticBucket);
  }

  if (event?.sourceEventId) {
    keys.push("source|" + String(event.sourceEventId).slice(0, 200));
  }

  return keys.filter(Boolean);
}

function reserveAlertDelivery(event) {
  const keys = alertDeliveryKeys(event);
  const now = Date.now();

  for (const [key, expiresAt] of deliveredAlertKeys) {
    if (expiresAt <= now) deliveredAlertKeys.delete(key);
  }

  if (keys.some(key =>
    deliveredAlertKeys.has(key) || alertDeliveryInFlight.has(key)
  )) {
    alertMetrics.duplicateSuppressed++;
    return null;
  }

  for (const key of keys) {
    deliveredAlertKeys.set(key, now + ALERT_DELIVERY_DEDUP_MS);
    alertDeliveryInFlight.add(key);
  }

  return keys;
}

function releaseAlertDelivery(keys, success) {
  for (const key of keys || []) {
    alertDeliveryInFlight.delete(key);
    if (!success) deliveredAlertKeys.delete(key);
  }
}

function consumeGlobalIngestRate() {
  const now = Date.now();

  while (
    ingestGlobalTimestamps.length &&
    now - ingestGlobalTimestamps[0] >= 1000
  ) {
    ingestGlobalTimestamps.shift();
  }

  if (ingestGlobalTimestamps.length >= INGEST_GLOBAL_PER_SECOND) {
    return false;
  }

  ingestGlobalTimestamps.push(now);
  return true;
}

function retryDelayMs(error, attempt) {
  const retryAfter = Number(
    error?.retryAfter ??
    error?.rawError?.retry_after ??
    error?.data?.retry_after ??
    0
  );

  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(10_000, Math.max(250, retryAfter * 1000));
  }

  return Math.min(5_000, 500 * (2 ** attempt));
}

function isRetryableAlertError(error) {
  const status = Number(
    error?.status ??
    error?.httpStatus ??
    error?.rawError?.status ??
    0
  );

  if ([429, 500, 502, 503, 504].includes(status)) return true;

  return /timeout|timed\s*out|network|econn|etimedout|eai_again|socket|fetch/i.test(
    String(error?.message || error || "")
  );
}

async function deliverQueuedAlert(job) {
  for (let attempt = 0; attempt <= ALERT_RETRY_LIMIT; attempt++) {
    try {
      const sent = await sendAlert(job.event, job.latencyMs);
      if (!sent) return;

      if (attempt > 0) {
        console.log(
          "Alert delivery recovered on retry:",
          job.event?.rarity,
          job.event?.eggName,
          "attempt=" + (attempt + 1)
        );
      }

      return;
    } catch (error) {
      if (!isRetryableAlertError(error) || attempt >= ALERT_RETRY_LIMIT) {
        throw error;
      }

      alertMetrics.queueRetried++;
      const delay = retryDelayMs(error, attempt);

      console.warn(
        "Transient alert send failure; retrying:",
        job.event?.rarity,
        job.event?.eggName,
        "attempt=" + (attempt + 1),
        "delayMs=" + delay
      );

      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

function alertQueuePriority(event) {
  const rarityScore = rarityPriority(event?.rarity) * 100;
  const sourceScore =
    event?.source === "Live Feed"
      ? 40
      : event?.source === "Signed API"
        ? 10
        : 25;

  return rarityScore + sourceScore;
}

function alertQueueJobPriority(job) {
  const base = alertQueuePriority(job?.event);
  const ageMs = Math.max(0, Date.now() - Number(job?.enqueuedAt || Date.now()));
  const ageBonus = Math.min(30, Math.floor(ageMs / 1000) * 2);
  const staleBonus = ageMs >= ALERT_QUEUE_STALE_AFTER_MS ? 1000 : 0;

  return base + ageBonus + staleBonus;
}

function dequeueNextAlert() {
  const candidates = [];

  for (const [name, queue] of Object.entries(alertQueues)) {
    if (queue.length) {
      candidates.push({
        name,
        job: queue.reduce(
          (best, item) =>
            !best || alertQueueJobPriority(item) > alertQueueJobPriority(best)
              ? item
              : best,
          null
        )
      });
    }
  }

  if (!candidates.length) return null;

  let best = candidates[0];
  for (let i = 1; i < candidates.length; i++) {
    if (
      alertQueueJobPriority(candidates[i].job) >
      alertQueueJobPriority(best.job)
    ) {
      best = candidates[i];
    }
  }

  const queue = alertQueues[best.name];
  const index = queue.indexOf(best.job);
  const job = index >= 0 ? queue.splice(index, 1)[0] : null;

  if (
    job &&
    Date.now() - Number(job.enqueuedAt || Date.now()) >= ALERT_QUEUE_STALE_AFTER_MS
  ) {
    alertMetrics.queueStalePromoted++;
  }

  return job;
}

function pumpAlertQueue() {
  while (alertQueueActive < ALERT_QUEUE_WORKERS && alertQueueDepth() > 0) {
    const job = dequeueNextAlert();
    if (!job) return;

    for (const key of job.deliveryKeys || []) {
      alertQueueKeys.delete(key);
    }

    alertQueueActive++;

    deliverQueuedAlert(job)
      .catch(error => {
        alertMetrics.sendFailures++;
        alertMetrics.lastFailureAt = new Date().toISOString();
        recordLifecycle(job.event, "FAILED", {
          detail: error?.message || "queued_delivery_failed"
        });
        const deadLetter = addDeadLetterAlert(
          job.event,
          error,
          ALERT_RETRY_LIMIT + 1
        );
        persistGameEvent({
          source: job.event?.source || "unknown",
          type: "alert_dead_letter",
          title: String(job.event?.eggName || job.event?.displayName || "Alert").slice(0, 200),
          description: deadLetter.error,
          date: deadLetter.failedAt,
          sourceEventId: job.event?.sourceEventId || null,
          incidentId: job.event?.incidentId || null,
          confidence: Number(job.event?.confidence || 0),
          eventState: "DEAD_LETTER",
          evidence: Array.isArray(job.event?.evidence) ? job.event.evidence.slice(0, 8) : []
        }).catch(storageError => {
          recordMonitorError("storage", storageError, "Dead-letter persistence failed");
        });
        scheduleStateSave();
        recordMonitorError(
          "queue",
          error,
          "Queued alert delivery failed for " +
            (job.event?.rarity || "unknown") + " " +
            (job.event?.eggName || "unknown")
        );
      })
      .finally(() => {
        alertQueueActive--;
        pumpAlertQueue();
      });
  }
}

function enqueueAlert(event, latencyMs = null) {
  if (alertsPaused) {
    recordLifecycle(event, "SUPPRESSED", { detail: "alerts_paused" });
    return {
      queued: false,
      duplicate: false,
      full: false,
      suppressed: true,
      reason: "alerts_paused",
      confidence: 0
    };
  }

  const sourceConflict = noteSourceObservation(event);
  if (sourceConflict) {
    recordMonitorError(
      "source",
      null,
      "Source disagreement observed for " +
        (event?.rarity || "unknown") + " " +
        (event?.eggName || "unknown")
    );
    event.sourceDisagreement = sourceConflict;
  }

  const reliability = evaluateEventReliability(event, {
    parser: event?.source === "Live Feed" ? "live-feed-egg" : "discord-egg",
    parserConfidence:
      event?.source === "Live Feed"
        ? 0.92
        : event?.source === "Signed API"
          ? 0.90
          : 0.84
  });

  if (!reliability.ok) {
    recordLifecycle(event, "SUPPRESSED", {
      detail: reliability.reason || "reliability_guard"
    });
    console.warn(
      "Detection suppressed by reliability guard:",
      reliability.reason,
      event?.rarity,
      event?.eggName,
      reliability.confidence ?? 0
    );
    return {
      queued: false,
      duplicate: false,
      full: false,
      suppressed: true,
      reason: reliability.reason,
      confidence: reliability.confidence ?? 0
    };
  }

  if (reliability.anomaly) {
    recordLifecycle(event, "SUPPRESSED", {
      detail: "duplicate_storm:" + String(reliability.reason || "burst_frequency")
    });
    persistSuppressedDetection(
      event,
      "duplicate_storm",
      reliability.confidence,
      reliability.evidence
    );
    event.suppressedReason = "duplicate_storm";
    return {
      queued: false,
      duplicate: false,
      full: false,
      suppressed: true,
      reason: "duplicate_storm",
      confidence: reliability.confidence
    };
  }

  recordLifecycle(event, "VERIFIED", {
    detail: "confidence=" + String(reliability.confidence)
  });

  const deliveryKeys = alertDeliveryKeys(event);

  if (deliveryKeys.some(key =>
    alertQueueKeys.has(key) ||
    deliveredAlertKeys.has(key) ||
    alertDeliveryInFlight.has(key)
  )) {
    alertMetrics.duplicateSuppressed++;
    return { queued: false, duplicate: true, full: false };
  }

  const queueName = alertQueueName(event);
  const queue = alertQueues[queueName];
  const isApiIngress = queueName === "api";
  const apiLimit = Math.max(1, ALERT_QUEUE_MAX - ALERT_QUEUE_RESERVED_LIVE_SLOTS);
  const perQueueLimit = isApiIngress
    ? apiLimit
    : queueName === "live"
      ? ALERT_QUEUE_MAX
      : Math.max(1, Math.floor(ALERT_QUEUE_MAX / 2));

  if (
    queue.length >= perQueueLimit ||
    alertQueueDepth() >= ALERT_QUEUE_MAX
  ) {
    alertMetrics.queueRejected++;
    console.error(
      "Alert queue full; rejecting new alert:",
      event?.rarity,
      event?.eggName,
      "depth=" + alertQueueDepth()
    );

    return { queued: false, duplicate: false, full: true };
  }

  for (const key of deliveryKeys) {
    alertQueueKeys.add(key);
  }

  queue.push({
    event: { ...event },
    latencyMs,
    deliveryKeys,
    enqueuedAt: Date.now(),
    queueName
  });
  recordLifecycle(event, "QUEUED", {
    detail: "queue=" + queueName
  });

  pumpAlertQueue();

  return { queued: true, duplicate: false, full: false };
}

function recordAlertMetric(event, area) {
  const rarityKey = normalizeFeedKey(event?.rarity);
  if (Object.prototype.hasOwnProperty.call(alertMetrics.byRarity, rarityKey)) {
    alertMetrics.byRarity[rarityKey]++;
  }

  const areaKey = String(area || "Unknown").trim() || "Unknown";
  alertMetrics.byArea.set(
    areaKey,
    (alertMetrics.byArea.get(areaKey) || 0) + 1
  );

  if (alertMetrics.byArea.size > 50) {
    const oldest = alertMetrics.byArea.keys().next().value;
    if (oldest != null) alertMetrics.byArea.delete(oldest);
  }

  alertMetrics.lastSuccessAt = new Date().toISOString();
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

function isPngBuffer(buffer) {
  return Buffer.isBuffer(buffer) &&
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
    );
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

const PET_IMAGE_DB_FILE = path.resolve(process.cwd(), "data/pet-images.json");
const PET_IMAGE_DIR = path.resolve(process.cwd(), "data/pets");

const imageFallbackCache = new Map();
const petPageCache = new Map();
const petPngBufferCache = new Map();
const IMAGE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const IMAGE_NEGATIVE_CACHE_TTL_MS = 5 * 60 * 1000;
const PET_PAGE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const PET_PNG_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_REMOTE_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_REMOTE_TEXT_BYTES = 2 * 1024 * 1024;

let petImageDatabase = new Map();

function loadPetImageDatabase() {
  try {
    const raw = fs.readFileSync(PET_IMAGE_DB_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const records = Array.isArray(parsed?.pets) ? parsed.pets : [];

    petImageDatabase = new Map(
      records
        .filter(item =>
          item &&
          typeof item.petName === "string" &&
          typeof item.sourcePage === "string" &&
          /^https?:\/\//i.test(item.sourcePage)
        )
        .map(item => [
          normalizeFeedKey(item.petName),
          {
            petName: item.petName.trim(),
            sourcePage: item.sourcePage.trim(),
            format: "png",
            imageKind: "original-pet-icon"
          }
        ])
    );

    console.log("Pet image database loaded:", petImageDatabase.size + " PNG records");
  } catch (error) {
    petImageDatabase = new Map();
    console.warn("Pet image database could not be loaded:", error?.message || error);
  }
}

function cleanupNonPngPetImages() {
  try {
    fs.mkdirSync(PET_IMAGE_DIR, { recursive: true });

    let removed = 0;
    for (const name of fs.readdirSync(PET_IMAGE_DIR)) {
      const fullPath = path.join(PET_IMAGE_DIR, name);
      if (!fs.statSync(fullPath).isFile()) continue;
      if (!/\.png$/i.test(name)) {
        try {
          fs.unlinkSync(fullPath);
          removed++;
        } catch {}
      }
    }

    if (removed) {
      console.log("Removed non-PNG pet images:", removed);
    }
  } catch (error) {
    console.warn("Pet image directory cleanup failed:", error?.message || error);
  }
}

function savePetImageDatabase() {
  try {
    fs.mkdirSync(path.dirname(PET_IMAGE_DB_FILE), { recursive: true });
    const payload = {
      schemaVersion: 1,
      format: "png",
      purpose: "Curated pet-only image source catalog. Egg, area, banner, and other artwork is excluded.",
      pets: [...petImageDatabase.values()]
        .sort((a, b) => a.petName.localeCompare(b.petName))
        .map(item => ({
          petName: item.petName,
          sourcePage: item.sourcePage,
          format: "png",
          imageKind: "original-pet-icon"
        }))
    };

    const tempFile = PET_IMAGE_DB_FILE + ".tmp";
    fs.writeFileSync(tempFile, JSON.stringify(payload, null, 2) + "\n", "utf8");
    fs.renameSync(tempFile, PET_IMAGE_DB_FILE);
  } catch (error) {
    console.warn("Pet image database save failed:", error?.message || error);
  }
}

function registerPetImageDatabaseEntry(entry) {
  const petName = String(entry?.petName || "").trim();
  if (!petName) return;

  const key = normalizeFeedKey(petName);
  const existing = petImageDatabase.get(key);
  if (existing?.sourcePage) return;

  const sourcePage = "https://stealanegg-wiki.com/wiki/" +
    slugify(petName).replace(/-egg$/i, "") +
    "/";

  petImageDatabase.set(key, {
    petName,
    sourcePage,
    format: "png",
    imageKind: "original-pet-icon"
  });
  savePetImageDatabase();
}

loadPetImageDatabase();
cleanupNonPngPetImages();

function findCatalogPet(input) {
  const wanted = normalizeFeedKey(input);
  if (!wanted) return null;

  return eggImageCatalog.find(entry => {
    const names = [
      entry?.petName,
      ...(Array.isArray(entry?.aliases) ? entry.aliases : [])
    ].filter(Boolean);

    return names.some(name => normalizeFeedKey(name) === wanted);
  }) || null;
}

function petImageNameKeys(petName) {
  const entry = findCatalogPet(petName);
  const keys = [
    petName,
    entry?.petName,
    ...(Array.isArray(entry?.aliases) ? entry.aliases : [])
  ]
    .filter(Boolean)
    .map(normalizeFeedKey)
    .filter(Boolean);

  return [...new Set(keys)];
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

  const databaseRecord = petImageDatabase.get(key);
  if (!databaseRecord?.sourcePage) {
    petPageCache.set(key, { pageUrl: null, body: null, at: Date.now() });
    return null;
  }

  try {
    const { response, body } = await fetchLiveFeed(databaseRecord.sourcePage);
    if (!response.ok) throw new Error("pet_page_http_" + response.status);

    const result = {
      pageUrl: databaseRecord.sourcePage,
      body,
      at: Date.now()
    };
    petPageCache.set(key, result);
    return result;
  } catch {
    petPageCache.set(key, { pageUrl: null, body: null, at: Date.now() });
    return null;
  }
}

function parseImgCandidates(html, pageUrl, targetPetName) {
  const targetKeys = petImageNameKeys(targetPetName);
  const markup = String(html || "");
  const tags =
    markup.match(/<(?:img|source)\b[^>]*>/gi) || [];

  const matchesPetName = value => {
    const normalized = normalizeFeedKey(value);
    if (!normalized) return false;
    return targetKeys.some(key =>
      normalized === key ||
      normalized.includes(key) ||
      key.includes(normalized)
    );
  };

  const results = [];

  for (const tag of tags) {
    const attrs = extractTagAttributes(tag);
    const src =
      attrs.src ||
      attrs["data-src"] ||
      attrs["data-lazy-src"] ||
      attrs["data-original"] ||
      attrs["data-bg"] ||
      attrs["data-background-image"] ||
      "";

    const srcSet =
      attrs.srcset ||
      attrs["data-srcset"] ||
      "";

    const alt = attrs.alt || "";
    const title = attrs.title || "";
    const className = attrs.class || "";
    const metadata = (alt + " " + title + " " + className + " " + src).toLowerCase();

    const srcParts = [];
    if (src) srcParts.push(src);
    if (srcSet) {
      for (const part of srcSet.split(",")) {
        const candidate = part.trim().split(/\s+/)[0];
        if (candidate) srcParts.push(candidate);
      }
    }

    const urls = srcParts
      .map(value => absolutizeUrl(value, pageUrl))
      .filter(Boolean)
      .filter(isTrustedPetImageUrl);

    if (!urls.length) continue;

    let score = 0;
    const altKey = normalizeFeedKey(alt);
    const titleKey = normalizeFeedKey(title);

    if (matchesPetName(alt)) score += altKey === targetKeys[0] ? 250 : 180;
    if (matchesPetName(title)) score += titleKey === targetKeys[0] ? 220 : 160;
    if (/original\s+pet\s+icon/i.test(alt + " " + title + " " + className)) score += 500;
    if (/\bpet\b/i.test(alt + " " + title)) score += 60;
    if (/images\/pets|images\/optimized|assets\/images/i.test(metadata)) score += 60;
    if (/\b(egg|eggs|area|biome|banner|hero|og|logo|favicon|screenshot|update-\d+)\b/i.test(metadata)) score -= 500;
    if (/\b(article|author|profile|thumbnail|avatar)\b/i.test(metadata)) score -= 150;
    if (matchesPetName(src)) score += 150;

    results.push({ urls, score });
  }

  // Some pet pages render the artwork as CSS background images or lazy data
  // attributes instead of a normal <img>. Keep this parser pet-only by scoring
  // the URL itself against the known pet names and rejecting common UI artwork.
  for (const match of markup.matchAll(/(?:background-image\s*:\s*url\(|data-(?:bg|background-image)=["'])([^)"']+)/gi)) {
    const rawUrl = match[1];
    const url = absolutizeUrl(rawUrl, pageUrl);
    if (!url || !isTrustedPetImageUrl(url)) continue;

    const normalizedUrl = normalizeFeedKey(url);
    let score = matchesPetName(url) ? 220 : 30;
    if (/\b(egg|eggs|area|biome|banner|hero|og|logo|favicon|screenshot|update-\d+)\b/i.test(normalizedUrl)) score -= 500;
    results.push({ urls: [url], score });
  }

  return results
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
      host === "steal-an-egg-roblox.wiki" ||
      host === "stealanegg-wiki.com";

    const blockedPath =
      /(?:\/eggs?(?:\/|$)|\/og\/|\/hero\/|\/banner\/|\/logo\/|\/favicon|sprite)/i.test(pathName);

    return trustedHost && !blockedPath;
  } catch {
    return false;
  }
}

async function resolvePetImageSource(petName) {
  const entry = findCatalogPet(petName);
  if (!entry) return null;

  const key = normalizeFeedKey(entry.petName);
  registerPetImageDatabaseEntry(entry);

  const cached = imageFallbackCache.get("pet:" + key);
  if (cached) {
    const ttl = cached.url ? IMAGE_CACHE_TTL_MS : IMAGE_NEGATIVE_CACHE_TTL_MS;
    if (Date.now() - cached.at < ttl) return cached.url;
    imageFallbackCache.delete("pet:" + key);
  }

  const databaseRecord = petImageDatabase.get(key);
  const directSlugs = petImageNameKeys(entry.petName)
    .map(slugify)
    .filter(Boolean);

  const directCandidates = [];
  try {
    const sourceHost = new URL(databaseRecord?.sourcePage || "").hostname.toLowerCase();
    const bases = [
      `https://${sourceHost}/images/pets/`,
      `https://${sourceHost}/images/`,
      `https://${sourceHost}/assets/images/pets/`,
      `https://${sourceHost}/wp-content/uploads/`
    ];

    for (const base of bases) {
      for (const slug of directSlugs) {
        for (const extension of [".webp", ".png", ".jpg", ".jpeg"]) {
          directCandidates.push(base + encodeURIComponent(slug) + extension);
        }
      }
    }
  } catch {}

  const seenUrls = new Set();
  const tryCandidates = async candidates => {
    for (const candidate of candidates) {
      for (const url of candidate.urls || [candidate]) {
        if (!url || seenUrls.has(url) || !isTrustedPetImageUrl(url)) continue;
        seenUrls.add(url);

        try {
          const { response } = await fetchLiveFeed(url);
          const contentType = String(response.headers.get("content-type") || "").toLowerCase();

          if (
            response.ok &&
            contentType.startsWith("image/") &&
            !contentType.includes("svg") &&
            !contentType.includes("gif")
          ) {
            imageFallbackCache.set("pet:" + key, { url, at: Date.now() });
            console.log("Pet image source found:", entry.petName);
            return url;
          }
        } catch {}
      }
    }
    return null;
  };

  const directFound = await tryCandidates(directCandidates);
  if (directFound) return directFound;

  const page = await fetchPetPage(entry.petName);
  if (!page?.body || !page?.pageUrl) {
    imageFallbackCache.set("pet:" + key, { url: null, at: Date.now() });
    return null;
  }

  const candidates = parseImgCandidates(page.body, page.pageUrl, entry.petName);
  const pageFound = await tryCandidates(candidates);
  if (pageFound) return pageFound;

  imageFallbackCache.set("pet:" + key, { url: null, at: Date.now() });
  return null;
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

async function getPetPngBuffer(petName) {
  const entry = findCatalogPet(petName);
  if (!entry) return null;

  const key = normalizeFeedKey(entry.petName);
  const cached = petPngBufferCache.get(key);
  if (cached && Date.now() - cached.at < PET_PNG_CACHE_TTL_MS) {
    return cached.buffer;
  }

  const localPath = path.join(PET_IMAGE_DIR, petSlugForEntry(entry) + ".png");
  try {
    if (fs.existsSync(localPath)) {
      const localBuffer = fs.readFileSync(localPath);
      if (isPngBuffer(localBuffer)) {
        petPngBufferCache.set(key, {
          buffer: localBuffer,
          at: Date.now(),
          transparent: Boolean(localBuffer.length)
        });
        return localBuffer;
      }
      fs.unlinkSync(localPath);
    }
  } catch {}

  const sourceUrl = await resolvePetImageSource(entry.petName);
  if (!sourceUrl || !isTrustedPetImageUrl(sourceUrl)) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LIVE_FEED_TIMEOUT_MS);

  try {
    const databaseRecord = petImageDatabase.get(key);
    const response = await fetch(sourceUrl, {
      headers: {
        "accept": "image/avif,image/webp,image/png,image/jpeg,image/jpg,*/*;q=0.8",
        "referer": databaseRecord?.sourcePage || "",
        "user-agent": "FSMM-SAB-Live-Notifier/6.0"
      },
      signal: controller.signal
    });

    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    if (!response.ok || contentType.includes("text/html") || contentType.includes("application/json")) {
      return null;
    }

    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength && contentLength > MAX_REMOTE_IMAGE_BYTES) return null;

    const input = Buffer.from(await response.arrayBuffer());
    if (input.length > MAX_REMOTE_IMAGE_BYTES || input.length < 64) {
      return null;
    }

    let pngBuffer;
    try {
      const metadata = await sharp(input, { failOn: "none" }).metadata();
      if (!metadata?.format || ["svg", "gif"].includes(String(metadata.format).toLowerCase())) {
        throw new Error("unsupported_pet_image_format");
      }

      pngBuffer = await sharp(input, { failOn: "none" })
        .png({
          compressionLevel: 9,
          adaptiveFiltering: true
        })
        .toBuffer();
      if (!pngBuffer?.length) {
        throw new Error("empty_png_output");
      }
    } catch (error) {
      console.warn(
        "Pet image conversion failed:",
        entry.petName,
        "source=" + sourceUrl,
        "contentType=" + (contentType || "unknown"),
        "bytes=" + input.length,
        "reason=" + (error?.message || error)
      );
      return null;
    }

    if (!isPngBuffer(pngBuffer)) {
      console.warn("Pet image conversion did not produce PNG:", entry.petName);
      return null;
    }

    fs.mkdirSync(PET_IMAGE_DIR, { recursive: true });
    const tempPath = localPath + ".tmp";
    fs.writeFileSync(tempPath, pngBuffer);
    fs.renameSync(tempPath, localPath);

    petPngBufferCache.set(key, {
      buffer: pngBuffer,
      at: Date.now(),
      transparent: false
    });
    trimImageCaches();
    console.log(
      "Pet PNG cached:",
      entry.petName,
      "source=" + (contentType || "image/*")
    );
    return pngBuffer;
  } catch (error) {
    console.warn(
      "Pet PNG fetch failed for " + entry.petName + ":",
      error?.message || error
    );
    return null;
  } finally {
    clearTimeout(timeout);
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
  const entries = eggImageCatalog.filter(isPetImageEligibleEntry);
  let warmed = 0;
  let failed = [];
  let cursor = 0;

  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= entries.length) return;

      const entry = entries[index];
      const imageKey = normalizeFeedKey(entry.petName);
      const cached = petPngBufferCache.get(imageKey);

      if (cached && Date.now() - cached.at < PET_PNG_CACHE_TTL_MS) {
        warmed++;
        continue;
      }

      try {
        const buffer = await getPetPngBuffer(entry.petName);
        if (buffer) {
          warmed++;
        } else {
          failed.push(entry.petName);
          console.warn(
            "Pet image source found but PNG processing failed:",
            entry.petName
          );
        }
      } catch (error) {
        failed.push(entry.petName);
        console.warn(
          "Image warm-up failed for " + entry.petName + ":",
          error?.message || error
        );
      }

      if (!petPngBufferCache.has(normalizeFeedKey(entry.petName))) {
        const key = normalizeFeedKey(entry.petName);
        failed.push(entry.petName);
        if (!imageFallbackCache.get("pet:" + key)?.url) {
          console.warn("No usable PNG pet image available:", entry.petName);
        }
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

    failed = [...new Set(failed)];
    console.log(
      "Pet image cache warm:",
      warmed + "/" + entries.length,
      "(valid PNG cache)"
    );
    const transparentReady = entries.filter(entry =>
      Boolean(petPngBufferCache.get(normalizeFeedKey(entry.petName))?.transparent)
    ).length;
    console.log(
      "Transparent PNG coverage:",
      transparentReady + "/" + entries.length
    );
    if (failed.length) {
      console.warn(
        "Pet images still missing:",
        failed.join(", ")
      );
    }
  } finally {
    imageWarmupInFlight = false;
  }
}

let imageWarmupTimer = null;

function scheduleImageWarmup() {
  const run = () => {
    warmPetImageCache({ workers: 3 }).catch(error => {
      console.error("Background image warm-up failed:", error);
    });
  };

  setTimeout(run, 1500);

  if (!imageWarmupTimer) {
    imageWarmupTimer = setInterval(run, 15 * 60 * 1000);
  }
}

app.get("/cdn/pets/:pet.png", async (req, res) => {
  const key = rateLimitKey(req);
  if (!consumeImageProxyRateLimit(key)) {
    setRetryAfter(res, 60);
    return res.status(429).end();
  }

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
          petName: catalogEgg.petName || catalogEgg.eggName.replace(/\s+Egg$/i, "").trim(),
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

    if (!entry || !isLastSeenEligibleEntry(entry)) continue;

    const key = eggIdentityKey(entry.eggName);
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

function parseLiveFeedHtml(html) {
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

async function processAdditionalLiveCandidates(payload, primaryCandidate, url) {
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
    if (!resolveAlertEntry(candidate)) continue;

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
      source: "Live Feed",
      sourceEventId: candidate.sourceEventId || null
    };

    try {
      seen.set(feedEventKey, Date.now());
      recordSpawnHistory(event, "Live Feed");
      const queued = enqueueAlert(
        event,
        Math.max(0, Date.now() - primaryTime)
      );

      if (queued.queued) {
        liveFeedEventsAccepted++;
        sent++;
      } else if (queued.full) {
        seen.delete(feedEventKey);
      }

      console.log(
        "Queued additional Live feed event:",
        candidate.rarity,
        candidate.eggName,
        "area=" + candidate.biome,
        "queueDepth=" + alertQueueDepth()
      );
    } catch (error) {
      seen.delete(feedEventKey);
      liveFeedErrors++;
      console.warn(
        "Additional Live source candidate failed:",
        candidate.eggName,
        error?.message || error
      );
    }
  }

  return sent;
}

async function pollLiveFeed() {
  if (!LIVE_FEED_ENABLED || !LIVE_FEED_URLS.length) return;
  if (liveFeedPollInFlight) return;

  liveFeedPollInFlight = true;
  liveFeedLastPollAt = new Date().toISOString();

  try {
    const orderedLiveFeedTargets = LIVE_FEED_URLS
      .map((url, index) => ({ url, index }))
      .sort((a, b) => {
        const left = liveFeedEndpointHealth.get(a.index + 1) || {};
        const right = liveFeedEndpointHealth.get(b.index + 1) || {};
        const activeScore = value =>
          String(value?.status || "").toUpperCase() === "ACTIVE" ? 0 : 1;
        return (
          activeScore(left) - activeScore(right) ||
          Number(left?.failures || 0) - Number(right?.failures || 0) ||
          Number(left?.latencyMs || 999999) - Number(right?.latencyMs || 999999) ||
          a.index - b.index
        );
      })
      .filter(item =>
        !liveFeedEndpointCoolingDown(item.url) &&
        liveFeedEndpointHealth.get(item.index + 1)?.status !== "DISABLED"
      );

    const results = await Promise.allSettled(
      orderedLiveFeedTargets
        .map(async ({ url, index }) => {
          try {
            const { response, body } = await fetchLiveFeed(url);

            if (!response.ok) {
              const status = Number(response.status) || 0;

              if (status === 404) {
                coolDownLiveFeedEndpoint(url, 404);
              }

              updateLiveFeedEndpointHealth(url, {
                status:
                status === 404
                  ? "DEAD"
                  : status === 429 || status >= 500
                    ? "DEGRADED"
                    : "HTTP_ERROR",
                httpStatus: status,
                failures:
                  (liveFeedEndpointHealth.get(index + 1)?.failures || 0) + 1,
                lastErrorAt: new Date().toISOString()
              });

              return { ok: false, index, url, status };
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

            syncLastSeenFromFeedPayload(payload);

            const candidates = typeof payload === "object" && payload !== null
              ? collectEggCandidates(payload)
              : [];

            const recovered = updateLiveFeedEndpointHealth(url, {
              status: "ACTIVE",
              httpStatus: response.status,
              failures: 0,
              lastSuccessAt: new Date().toISOString(),
              lastErrorAt: null
            });

            return {
              ok: true,
              recovered,
              index,
              url,
              status: response.status,
              payload,
              candidates
            };
          } catch (error) {
            coolDownLiveFeedEndpoint(url);
            updateLiveFeedEndpointHealth(url, {
              status: "ERROR",
              failures:
                (liveFeedEndpointHealth.get(index + 1)?.failures || 0) + 1,
              lastErrorAt: new Date().toISOString()
            });
            throw error;
          }
        })
    );

    const successful = [];

    for (const result of results) {
      if (result.status === "fulfilled") {
        if (result.value.ok) {
          successful.push(result.value);
        } else if (Number(result.value.status) !== 404) {
          liveFeedErrors++;
          const message =
            "Live feed endpoint returned HTTP " + result.value.status +
            " (endpoint " + (result.value.index + 1) + ").";
          console.warn(message);
        }
      } else {
        liveFeedErrors++;
        recordMonitorError(
          "source",
          result.reason,
          "Live feed endpoint failed"
        );
      }
    }

    if (!successful.length) {
      liveFeedConsecutiveFailures++;
      updateLiveFeedHealth();
      return;
    }

    liveFeedConsecutiveFailures = 0;
    liveFeedLastSuccessAt = new Date().toISOString();
    updateLiveFeedHealth();

    const now = Date.now();
    // Snapshot the previous feed watermark once per poll. Do not mutate the
    // watermark while iterating candidates or later candidates in the same
    // response can incorrectly look like old events and get dropped.
    const previousLastEventAt = liveFeedLastEventAt;
    const startupBaselineAt = previousLastEventAt
      ? Date.parse(previousLastEventAt)
      : null;

    for (const [fingerprint, seenAt] of liveFeedProcessedEvents) {
      if (now - seenAt > LIVE_FEED_EVENT_DEDUP_MS) {
        liveFeedProcessedEvents.delete(fingerprint);
      }
    }

    const candidateMap = new Map();

    for (const result of successful) {
      for (const candidate of result.candidates || []) {
        if (!candidate?.eggName || !candidate?.rarity || !candidate?.spawnedAt) {
          continue;
        }

        const rarityKey = normalizeFeedKey(candidate.rarity);
        if (!["secret", "eternal", "divine"].includes(rarityKey)) {
          continue;
        }

        const eventTime = Date.parse(candidate.spawnedAt);
        if (!Number.isFinite(eventTime)) continue;

        const ageMs = now - eventTime;
        if (ageMs < -60_000 || ageMs > LIVE_FEED_MAX_AGE_MS) continue;
        if (feedStateLooksOffline(result.payload)) continue;
        if (!resolveAlertEntry(candidate)) continue;

        const sourceEventId = candidate.sourceEventId
          ? String(candidate.sourceEventId)
          : "";

        // Prefer the upstream event ID. When a feed does not expose one,
        // use a source-independent canonical timestamp bucket so equivalent
        // observations from multiple endpoints collapse to one event.
        const eventSecond = Math.floor(eventTime / 1000);
        const fingerprint = sourceEventId
          ? [
              "id",
              sourceEventId,
              rarityKey,
              normalizeFeedKey(candidate.eggName),
              normalizeFeedKey(candidate.biome)
            ].join("|")
          : [
              "event",
              rarityKey,
              normalizeFeedKey(candidate.eggName),
              normalizeFeedKey(candidate.biome),
              eventSecond
            ].join("|");

        const existing = candidateMap.get(fingerprint);

        if (!existing || candidate.score > existing.candidate.score) {
          candidateMap.set(fingerprint, {
            candidate,
            eventTime,
            ageMs,
            url: result.url,
            index: result.index,
            fingerprint
          });
        }
      }
    }

    const rawCandidates = [...candidateMap.values()]
      .sort((a, b) => {
        if (a.eventTime !== b.eventTime) return a.eventTime - b.eventTime;
        return b.candidate.score - a.candidate.score;
      });

    const candidates = mergeNearDuplicateFeedCandidates(rawCandidates, {
      toleranceMs: LIVE_FEED_EVENT_MERGE_MS
    });

    if (!candidates.length) {
      return;
    }

    let acceptedThisPoll = 0;

    for (const item of candidates) {
      const { candidate, eventTime, ageMs, url, index, fingerprint } = item;

      liveFeedEventsReceived++;
      liveFeedLastUrl = url;

      const feedGate = shouldProcessLiveFeedCandidate({
        eventTime,
        fingerprint,
        primed: liveFeedPrimed,
        startupBaselineAt,
        processedEvents: liveFeedProcessedEvents,
        now
      });

      if (!feedGate.process) {
        if (feedGate.reason === "startup_prime") {
          liveFeedProcessedEvents.set(fingerprint, now);
        }
        continue;
      }

      liveFeedProcessedEvents.set(fingerprint, now);

      const event = {
        live: true,
        eggName: candidate.eggName,
        displayName: candidate.eggName,
        rarity: candidate.rarity,
        biome: candidate.biome || "Unknown",
        spawnedAt: candidate.spawnedAt,
        imageUrl: candidate.imageUrl || null,
        source: "Live Feed",
        sourceEventId: candidate.sourceEventId || null
      };

      const semanticKey = [
        event.rarity.toLowerCase(),
        normalizeFeedKey(event.eggName),
        normalizeFeedKey(event.biome)
      ].join("|");

      const endpointState = liveFeedEndpointHealth.get(index + 1);
      const recoveredAt = endpointState?.recoveredAt
        ? Date.parse(endpointState.recoveredAt)
        : NaN;
      const recentlyRecovered =
        Number.isFinite(recoveredAt) &&
        now - recoveredAt <= WATCHDOG_RECOVERY_COOLDOWN_MS;

      if (
        recentlyRecovered &&
        ageMs >= LIVE_FEED_REPRIME_AGE_MS
      ) {
        liveFeedProcessedEvents.set(fingerprint, now);
        console.log(
          "Re-primed recovered feed event without replay:",
          candidate.eggName,
          "endpoint=" + (index + 1)
        );
        continue;
      }

      // Live feed events are already deduplicated by their event fingerprint
      // above. Do not apply the older same-egg/same-area window here because
      // legitimate rapid spawns can share the same egg and area.
      inFlightKeys.add(semanticKey);

      try {
        recordSpawnHistory(event, "Live Feed");

        const queued = enqueueAlert(
          event,
          ageMs >= 0 ? ageMs : null
        );

        if (queued.queued) {
          liveFeedEventsAccepted++;
          acceptedThisPoll++;

          console.log(
            "Queued Live feed event:",
            semanticKey,
            "latencyMs=" + (ageMs >= 0 ? ageMs : "unknown"),
            "sourceEndpoint=" + (index + 1),
            "queueDepth=" + alertQueueDepth()
          );
        } else if (queued.full) {
          liveFeedProcessedEvents.delete(fingerprint);
          seen.delete(semanticKey);
          console.warn(
            "Live alert queue full; candidate will be retried:",
            candidate.eggName
          );
        } else if (queued.duplicate) {
          console.log("Live feed duplicate suppressed:", semanticKey);
        }
      } catch (error) {
        liveFeedProcessedEvents.delete(fingerprint);
        seen.delete(semanticKey);
        liveFeedErrors++;
        console.error(
          "Live source alert forwarding failed:",
          candidate.eggName,
          error
        );
      } finally {
        inFlightKeys.delete(semanticKey);
      }
    }

    // Startup baseline: mark every currently visible event as seen without
    // sending a burst of historical alerts. Future polls deliver every new
    // candidate independently.
    // Advance the feed watermark only after every candidate in this
    // response has been evaluated. This prevents multi-spawn payloads from
    // losing events because a later candidate was compared against a mutated
    // watermark from an earlier candidate.
    const newestCandidate = [...candidates]
      .filter(item => Number.isFinite(Number(item?.eventTime)))
      .sort((a, b) => Number(b.eventTime) - Number(a.eventTime))[0];

    if (newestCandidate) {
      const newestTime = Number(newestCandidate.eventTime);
      const previousTime = previousLastEventAt
        ? Date.parse(previousLastEventAt)
        : NaN;

      if (!Number.isFinite(previousTime) || newestTime > previousTime) {
        liveFeedLastEventAt = new Date(newestTime).toISOString();
        liveFeedLastFingerprint = newestCandidate.fingerprint || null;
      }
    }

    if (!liveFeedPrimed) {
      liveFeedPrimed = true;

      scheduleStateSave();

      const newest = newestCandidate;
      if (newest) {
        console.log(
          "Live feed primed:",
          newest.candidate.rarity,
          newest.candidate.eggName,
          "area=" + newest.candidate.biome,
          "spawnedAt=" + newest.candidate.spawnedAt,
          "eventsInPayload=" + candidates.length,
          "endpoint=" + (newest.index + 1)
        );
      }

      return;
    }

    if (acceptedThisPoll > 1) {
      console.log(
        "Multi-egg announcement:",
        "sent=" + acceptedThisPoll,
        "candidates=" + candidates.length
      );
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

function recordSpawnHistory(event, source = "Live Feed") {
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
    spawnedAt: Number.isFinite(timestamp)
      ? new Date(timestamp).toISOString()
      : new Date().toISOString(),
    detectedAt: new Date().toISOString(),
    source,
    sourceEventId: event?.sourceEventId || event?.id || null,
    incidentId: event?.incidentId || null,
    confidence: Number.isFinite(Number(event?.confidence))
      ? Number(event.confidence)
      : null,
    eventState: event?.eventState || "DETECTED",
    evidence: Array.isArray(event?.evidence) ? event.evidence.slice(0, 8) : [],
    verificationCount: Number(event?.verificationCount || 0),
    suppressedReason: event?.suppressedReason || null
  };

  const same = spawnHistory.find(item => item.id === record.id);
  if (same) return same;

  spawnHistory.unshift(record);
  if (spawnHistory.length > MAX_HISTORY) spawnHistory.length = MAX_HISTORY;

  recordLastSeen(event);
  persistSpawnRecord(record).catch(error => {
    recordMonitorError("storage", error, "Supabase spawn persistence failed");
  });
  scheduleStateSave();
  return record;
}

function recordGameEvent(event) {
  const key = [
    event.type || "event",
    normalizeFeedKey(event.title),
    event.date || ""
  ].join("|");

  if (gameEventHistory.some(item => item.key === key)) return null;

  const record = {
    key,
    type: event.type || "event",
    title: String(event.title || "Game Event").slice(0, 200),
    description: String(event.description || "").slice(0, 800),
    date: event.date || null,
    source: event.source || (
      event.source === "Manual Test"
        ? "Manual Test"
        : PUBLIC_DISCOVERY_SOURCE_LABEL
    ),
    sourceEventId: event.sourceEventId || event.id || null,
    incidentId: event.incidentId || null,
    confidence: Number.isFinite(Number(event.confidence)) ? Number(event.confidence) : null,
    eventState: event.eventState || "DETECTED",
    evidence: Array.isArray(event.evidence) ? event.evidence.slice(0, 8) : [],
    verificationCount: Number(event.verificationCount || 0),
    suppressedReason: event.suppressedReason || null,
    detectedAt: new Date().toISOString()
  };

  gameEventHistory.unshift(record);
  if (gameEventHistory.length > MAX_EVENT_HISTORY) {
    gameEventHistory.length = MAX_EVENT_HISTORY;
  }

  persistGameEvent(record).catch(error => {
    recordMonitorError("storage", error, "Supabase game event persistence failed");
  });
  scheduleStateSave();
  return record;
}

function updateDiscoverySourceHealth(source, patch = {}) {
  const next = {
    key: source.key,
    name: source.name,
    url: source.url,
    status: "UNKNOWN",
    checkedAt: null,
    httpStatus: null,
    updateFound: false,
    eggCount: 0,
    eventCount: 0,
    error: null,
    ...autoDiscoverySourceHealth.get(source.key),
    ...patch
  };

  autoDiscoverySourceHealth.set(source.key, next);
  persistSourceHealth(next).catch(error => {
    recordMonitorError("storage", error, "Supabase discovery health persistence failed");
  });
}

function discoverySummary() {
  const ranked = rankSourceHealth([...autoDiscoverySourceHealth.values()]);

  return ranked.map((item, index) => ({
    id: "source-" + (index + 1),
    label: PUBLIC_DISCOVERY_SOURCE_LABEL + " #" + (index + 1),
    status: item.status,
    checkedAt: item.checkedAt,
    httpStatus: item.httpStatus,
    updateFound: item.updateFound,
    eggCount: item.eggCount,
    eventCount: item.eventCount,
    error: item.error ? "source_error" : null
  }));
}

async function sendGameUpdateAlert(_update, _newEggs = [], _changes = null) {
  // Auto Discovery is intentionally silent. It only receives source updates,
  // reconciles the catalog/areas/pets, and prepares assets internally.
  // No Discord notification is sent for a detected website/game update.
  return;
}


async function scanForGameUpdates() {
  if (!AUTO_DISCOVERY_ENABLED || autoDiscoveryInFlight) return null;
  autoDiscoveryInFlight = true;
  try {
    return await runAutoDiscoverySweep();
  } finally {
    autoDiscoveryInFlight = false;
  }
}

async function runAutoDiscoverySweep() {
  lastUpdateCheckAt = new Date().toISOString();

  const sourceRanks = {};
  const updateCandidates = [];
  const supportedEggs = [];
  const detectedEvents = [];
  const visitedUrls = new Set();
  const linkQueue = [];
  let successfulSources = 0;

  const orderedDiscoverySources = [...AUTO_DISCOVERY_SOURCES].sort((a, b) => {
    const left = autoDiscoverySourceHealth.get(a.key) || {};
    const right = autoDiscoverySourceHealth.get(b.key) || {};
    const activeScore = value =>
      String(value?.status || "").toUpperCase() === "ACTIVE" ? 0 : 1;
    return (
      activeScore(left) - activeScore(right) ||
      Number(left?.failures || left?.consecutiveFailures || 0) -
        Number(right?.failures || right?.consecutiveFailures || 0) ||
      Number(b.rank || 0) - Number(a.rank || 0)
    );
  });

  for (const source of orderedDiscoverySources) {
    sourceRanks[source.name] = source.rank;
    updateDiscoverySourceHealth(source);

    try {
      const { response, body } = await fetchLiveFeed(source.url);
      visitedUrls.add(source.url);

      if (!response.ok) {
        updateDiscoverySourceHealth(source, {
          status: "HTTP_ERROR",
          checkedAt: new Date().toISOString(),
          httpStatus: response.status,
          error: "HTTP " + response.status
        });
        continue;
      }

      successfulSources++;

      const sourceUpdate = source.parseUpdates
        ? extractUpdateSnapshot(body, source.name)
        : null;
      const sourceEggs = source.parseEggs
        ? extractSupportedEggsFromDiscovery(body)
        : [];
      const sourceEvents = source.parseEvents
        ? extractDiscoveryEvents(body, source.name)
        : [];

      if (sourceUpdate) {
        sourceUpdate.url = source.url;
        updateCandidates.push(sourceUpdate);
      }
      supportedEggs.push(...sourceEggs.map(item => ({
        ...item,
        sourceKey: source.key,
        source: source.name,
        sourceRank: source.rank
      })));
      detectedEvents.push(
        ...sourceEvents.map(event => ({
          ...event,
          url: source.url
        }))
      );

      if (source.followLinks) {
        linkQueue.push(
          ...extractRelevantLinks(body, source.url, AUTO_DISCOVERY_LINK_LIMIT)
            .map(item => ({ ...item, sourceName: source.name }))
        );
      }

      updateDiscoverySourceHealth(source, {
        status: "ACTIVE",
        checkedAt: new Date().toISOString(),
        httpStatus: response.status,
        updateFound: Boolean(sourceUpdate),
        eggCount: sourceEggs.length,
        eventCount: sourceEvents.length,
        error: null
      });
    } catch (error) {
      updateDiscoverySourceHealth(source, {
        status: "ERROR",
        checkedAt: new Date().toISOString(),
        error: String(error?.message || error).slice(0, 200)
      });
      recordMonitorError(
        "discovery",
        error,
        "Auto discovery source failed: " + source.key
      );
    }
  }

  // Follow only the most relevant update/event links, then merge their facts.
  const rankedLinks = [...linkQueue]
    .sort((a, b) => b.score - a.score)
    .filter(item => {
      if (visitedUrls.has(item.url)) return false;
      visitedUrls.add(item.url);
      return true;
    })
    .slice(0, AUTO_DISCOVERY_LINK_LIMIT);

  for (const link of rankedLinks) {
    try {
      const { response, body } = await fetchLiveFeed(link.url);
      if (!response.ok) continue;

      const pageSource = link.sourceName + " • linked";
      const pageUpdate = extractUpdateSnapshot(body, pageSource);
      if (pageUpdate) {
        pageUpdate.url = link.url;
        updateCandidates.push(pageUpdate);
      }

      supportedEggs.push(
        ...extractSupportedEggsFromDiscovery(body).map(item => ({
          ...item,
          sourceKey: link.sourceName,
          source: link.sourceName,
          sourceRank: 5
        }))
      );
      detectedEvents.push(
        ...extractDiscoveryEvents(body, pageSource).map(event => ({
          ...event,
          url: link.url
        }))
      );
    } catch (error) {
      recordMonitorError(
        "discovery",
        error,
        "Auto discovery linked-page fetch failed for source: " + link.sourceName
      );
    }
  }

  const mergedEggs = mergeEggObservations(supportedEggs);
  const uniqueEggs = new Map(mergedEggs.map(item => [item.key, item]));

  let added = 0;
  let metadataUpdated = 0;
  const newlyAdded = [];

  for (const item of uniqueEggs.values()) {
    const existing = findCatalogEgg(item.eggName);
    if (
      existing &&
      item.area &&
      item.area !== "Unknown" &&
      normalizeFeedKey(existing.biome) !== normalizeFeedKey(item.area)
    ) {
      existing.biome = item.area;
      metadataUpdated++;
    }
    const before = existing;
    const entry =
      Number(item.confidence || 0) >= 55
        ? ensureCatalogEgg(
            item.eggName,
            item.rarity,
            item.area || "Unknown"
          )
        : before;

    if (entry && !before && Number(item.confidence || 0) >= 55) {
      added++;
      autoDiscoveredCount++;
      newlyAdded.push(entry);

      // Immediately warm the newly discovered pet/egg artwork. The image
      // pipeline converts remote artwork to a transparent PNG before Discord
      // ever receives it, so newly discovered entries get the same image
      // treatment as the built-in catalogue.
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

  if (newlyAdded.length && (CHANNEL_ID || LAST_SEEN_CHANNEL_ID)) {
    setTimeout(() => {
      ensureEggCustomEmojis().catch(error => {
        console.warn("Dynamic custom emoji refresh failed:", error?.message || error);
      });
    }, 0);
  }

  const bestUpdate = chooseBestUpdate(updateCandidates, sourceRanks);

  const currentCatalogSnapshot = snapshotEggs(
    [...uniqueEggs.values()].map(item => ({
      ...item,
      sourceCount: item.sourceCount,
      confidence: item.confidence
    }))
  );

  const catalogChanges = detectCatalogChanges(
    discoveryCatalogSnapshot,
    currentCatalogSnapshot
  );

  const changedWithConfidence = catalogChanges.changed.filter(item =>
    Number(item.after?.confidence || 0) >= 60
  );
  const highConfidenceAdded = catalogChanges.added.filter(item =>
    Number(item.confidence || 0) >= 55
  );

  const confidence = calculateEvidenceConfidence(
    supportedEggs.map(item => ({
      sourceKey: item.sourceKey,
      source: item.source,
      sourceRank: item.sourceRank
    }))
  );

  discoveryScanSequence++;

  const scanRecord = {
    scan: discoveryScanSequence,
    at: new Date().toISOString(),
    confidence,
    successfulSources,
    totalSources: AUTO_DISCOVERY_SOURCES.length,
    added: highConfidenceAdded.length,
    removed: catalogChanges.removed.length,
    changed: changedWithConfidence.length,
    metadataUpdated,
    bestUpdate: bestUpdate?.title || null,
    bestUpdateConfidence: bestUpdate?.evidenceConfidence ?? null,
    bestUpdateSources: bestUpdate?.evidenceSourceCount ?? 0
  };

  discoveryLastDecision = scanRecord;

  if (catalogChanges.added.length || catalogChanges.removed.length || changedWithConfidence.length) {
    discoveryChangelog.unshift({
      ...scanRecord,
      changes: {
        added: highConfidenceAdded.slice(0, 20),
        removed: catalogChanges.removed.slice(0, 20),
        changed: changedWithConfidence.slice(0, 20)
      }
    });
    discoveryChangelog = discoveryChangelog.slice(0, MAX_DISCOVERY_CHANGELOG);

    if (catalogChanges.removed.length) {
      console.warn(
        "Auto Discovery possible removals detected; catalog entries are NOT deleted automatically:",
        catalogChanges.removed.map(item => item.eggName).join(", ")
      );
    }
  }

  // Persist the observed source snapshot after the comparison so the next sweep
  // can detect real additions/removals/metadata changes.
  discoveryCatalogSnapshot = currentCatalogSnapshot;

  const nextUpdateFingerprint = discoveryFingerprint(bestUpdate);

  if (bestUpdate?.title && nextUpdateFingerprint) {
    const previousFingerprint = lastUpdateFingerprint;

    if (!previousFingerprint) {
      // First successful scan establishes a baseline without sending a noisy startup alert.
      lastUpdateFingerprint = nextUpdateFingerprint;
      lastUpdateTitle = bestUpdate.title;

      recordGameEvent({
        type: "game_update",
        title: bestUpdate.title,
        description: bestUpdate.description,
        date: bestUpdate.date,
        source: bestUpdate.source
      });

      console.log(
        "Auto discovery primed:",
        bestUpdate.title,
        "evidenceSources=" + (bestUpdate.evidenceSourceCount || 1),
        "fingerprint=" + nextUpdateFingerprint
      );
    } else if (nextUpdateFingerprint !== previousFingerprint) {
      lastUpdateFingerprint = nextUpdateFingerprint;
      lastUpdateTitle = bestUpdate.title;

      const eventRecord = recordGameEvent({
        type: "game_update",
        title: bestUpdate.title,
        description: bestUpdate.description,
        date: bestUpdate.date,
        source: bestUpdate.source
      });

      if (eventRecord) {
        // Intentionally silent: ordinary game/version/bug-fix updates
        // must never generate a Discord notification.
        await sendGameUpdateAlert(
          {
            title: bestUpdate.title,
            description: bestUpdate.description,
            source: bestUpdate.source,
            url: bestUpdate.url || null,
            evidenceConfidence: bestUpdate.evidenceConfidence,
            evidenceSourceCount: bestUpdate.evidenceSourceCount
          },
          newlyAdded
        );

        console.log(
          "New game update detected:",
          bestUpdate.title,
          "source=" + bestUpdate.source,
          "fingerprint=" + nextUpdateFingerprint
        );
      }
    }
  }

  // Only use a catalog-change alert when the update itself did not already
  // produce the same notification, preventing noisy duplicate announcements.
  if (
    newlyAdded.length &&
    lastUpdateFingerprint &&
    nextUpdateFingerprint === lastUpdateFingerprint &&
    !bestUpdate?.title?.toLowerCase().includes("new rare eggs")
  ) {
    const catalogEvent = recordGameEvent({
      type: "catalog_change",
      title: "New rare eggs discovered",
      description:
        newlyAdded.map(item =>
          item.rarity + " • " + (item.petName || item.eggName)
        ).join(", ").slice(0, 800),
      source: "Auto Catalog Sync"
    });

    if (catalogEvent && successfulSources > 0) {
      await sendGameUpdateAlert(
        {
          title: "New rare eggs discovered",
          description: "The automatic catalog monitor found new Secret, Eternal, or Divine spawn entries.",
          source: "Auto Catalog Sync"
        },
        newlyAdded
      );
    }
  }

  for (const event of detectedEvents) {
    recordGameEvent(event);
  }

  const catalogFingerprint = [...uniqueEggs.values()]
    .map(item => String(item.rarity) + ":" + item.eggName)
    .sort()
    .join("|");

  if (catalogFingerprint && catalogFingerprint !== autoDiscoveryLastFingerprint) {
    autoDiscoveryLastFingerprint = catalogFingerprint;
  }

  autoDiscoveryLastSummary = {
    checkedAt: new Date().toISOString(),
    successfulSources,
    totalSources: AUTO_DISCOVERY_SOURCES.length,
    updateCandidates: updateCandidates.length,
    uniqueEggs: uniqueEggs.size,
    evidenceConfidence: confidence,
    catalogChanges: {
      added: highConfidenceAdded.length,
      removed: catalogChanges.removed.length,
      changed: changedWithConfidence.length
    },
    events: detectedEvents.length,
    newlyAdded: newlyAdded.length,
    metadataUpdated
  };

  scheduleStateSave();

  console.log(
    "Auto discovery sweep:",
    successfulSources + "/" + AUTO_DISCOVERY_SOURCES.length,
    "sources;",
    "updates=" + updateCandidates.length,
    "eggs=" + uniqueEggs.size,
    "new=" + added,
    "metadataUpdated=" + metadataUpdated,
    "events=" + detectedEvents.length
  );
}


function startAutoDiscovery() {
  if (!AUTO_DISCOVERY_ENABLED) return;

  for (const source of AUTO_DISCOVERY_SOURCES) {
    updateDiscoverySourceHealth(source);
  }

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

function startLiveFeedPoller() {
  if (!LIVE_FEED_ENABLED) {
    console.log("Live feed: disabled.");
    return;
  }

  console.log("Live feed enabled. Configured private endpoints:", LIVE_FEED_URLS.length);

  pollLiveFeed().catch(error => {
    liveFeedErrors++;
    console.error("Initial Live source poll failed:", error);
  });

  setInterval(() => {
    pollLiveFeed().catch(error => {
      liveFeedErrors++;
      console.error("Live source poll cycle failed:", error);
    });
  }, LIVE_FEED_POLL_MS);
}

function getRarityEmoji(rarity) {
  return ALERT_EMOJIS[String(rarity || "").toLowerCase()] || "🥚";
}


function getEggAlertEmoji(event) {
  const entry =
    findCatalogEgg(event?.eggName || event?.displayName) ||
    findCatalogPet(event?.displayName || event?.eggName);

  return getEggCustomEmoji(entry)?.toString() || getRarityEmoji(event?.rarity);
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
  const rarityKey = String(rarity || "").trim().toLowerCase();

  if (!["secret", "eternal", "divine"].includes(rarityKey)) return "";

  const cached = resolvedRoleCache.get(rarityKey);
  if (cached && Date.now() - cached.at < ROLE_CACHE_TTL_MS) {
    return cached.id;
  }

  if (!alertChannel?.guild) return "";

  const roleNames = {
    secret: "SECRET ALERT",
    eternal: "ETERNAL ALERT",
    divine: "DIVINE ALERT"
  };

  const roleColors = {
    secret: 0x7c3aed,
    eternal: 0xf59e0b,
    divine: 0xef4444
  };

  try {
    const roles = await alertChannel.guild.roles.fetch();
    let role = roles.find(candidate =>
      normalizeFeedKey(candidate?.name || "") === normalizeFeedKey(roleNames[rarityKey]) &&
      candidate.editable
    );

    if (role) {
      // These roles are strictly mention-only: zero permissions, no hoist.
      const needsPermissionsReset = role.permissions.bitfield !== 0n;
      const needsMentionable = !role.mentionable;

      if (needsPermissionsReset || needsMentionable || role.hoist) {
        await role.edit({
          permissions: [],
          mentionable: true,
          hoist: false,
          reason: "Steal An Egg rarity alert role • mention-only • zero permissions"
        });
        role = await alertChannel.guild.roles.fetch(role.id);
      }

      resolvedRoleCache.set(rarityKey, { id: role.id, at: Date.now() });
      console.log("Rarity alert role ready:", rarityKey, role.name);
      return role.id;
    }

    const blockedSameName = roles.find(candidate =>
      normalizeFeedKey(candidate?.name || "") === normalizeFeedKey(roleNames[rarityKey]) &&
      !candidate.editable
    );

    if (blockedSameName) {
      console.warn("Found non-editable role with alert name; creating a dedicated alert role instead:", rarityKey);
    }

    const autoCreateRoles =
      (process.env.ALERT_AUTO_CREATE_ROLES || "true").toLowerCase() === "true";

    if (!autoCreateRoles) {
      resolvedRoleCache.set(rarityKey, { id: "", at: Date.now() });
      return "";
    }

    if (!alertChannel.guild.members.me?.permissions?.has(PermissionFlagsBits.ManageRoles)) {
      console.warn("Cannot create rarity alert role; Manage Roles permission is missing:", rarityKey);
      resolvedRoleCache.set(rarityKey, { id: "", at: Date.now() });
      return "";
    }

    role = await alertChannel.guild.roles.create({
      name: roleNames[rarityKey],
      colors: {
        primaryColor: roleColors[rarityKey]
      },
      permissions: [],
      mentionable: true,
      hoist: false,
      reason: "Steal An Egg rarity alert role • mention-only • zero permissions"
    });

    resolvedRoleCache.set(rarityKey, { id: role.id, at: Date.now() });
    console.log("Created rarity alert role:", rarityKey, role.name, role.id);
    return role.id;
  } catch (error) {
    console.warn(
      "Rarity alert role setup failed for " + rarityKey + ":",
      error?.message || error
    );
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
        "Live feed is stale. Last successful response:",
        liveFeedLastSuccessAt || "never"
      );
    } else if (current === "ACTIVE") {
      console.log(
        "Live feed health:",
        "ACTIVE",
        "lastSuccessAt=" + liveFeedLastSuccessAt
      );
    }
  }

  return current;
}

let watchdogInFlight = false;
let watchdogLastRunAt = null;
let watchdogLastRecoveryAt = null;
let watchdogLastAction = null;
let watchdogRecoveryCount = 0;
let watchdogLastActionAt = 0;

function queueOldestAgeMs() {
  if (!alertQueueDepth()) return 0;

  const oldest = alertQueue.reduce(
    (value, job) => Math.min(value, Number(job?.enqueuedAt || Date.now())),
    Date.now()
  );

  return Math.max(0, Date.now() - oldest);
}

function watchdogStatus() {
  const activeFeedEndpoints = [...liveFeedEndpointHealth.values()]
    .filter(item => item.status === "ACTIVE").length;
  const discoveryActive = [...autoDiscoverySourceHealth.values()]
    .filter(item => item.status === "ACTIVE").length;

  return {
    discord: client.isReady() ? "ACTIVE" : "DOWN",
    liveFeed: liveFeedHealth(),
    liveFeedEndpoints: activeFeedEndpoints + "/" + LIVE_FEED_URLS.length,
    lastSeen: LAST_SEEN_CHANNEL_ID
      ? (lastSeenMessagesReady ? "ACTIVE" : "WAITING")
      : "DISABLED",
    discovery: AUTO_DISCOVERY_ENABLED
      ? discoveryActive + "/" + AUTO_DISCOVERY_SOURCES.length
      : "DISABLED",
    queue: alertQueueDepth() + "/" + ALERT_QUEUE_MAX,
    queueOldestAgeMs: queueOldestAgeMs(),
    pngCache: petPngBufferCache.size,
    state: STATE_PERSISTENCE_MODE
  };
}

async function runSystemWatchdog() {
  if (watchdogInFlight) return;
  watchdogInFlight = true;
  watchdogLastRunAt = new Date().toISOString();

  try {
    if (!client.isReady()) return;

    const now = Date.now();
    const canAct =
      now - watchdogLastActionAt >= WATCHDOG_RECOVERY_COOLDOWN_MS;

    if (CHANNEL_ID && !alertChannel && canAct) {
      await getAlertChannel();
      watchdogLastAction = "refreshed_alert_channel";
      watchdogLastRecoveryAt = new Date().toISOString();
      watchdogLastActionAt = now;
      watchdogRecoveryCount++;
      return;
    }

    if (LAST_SEEN_CHANNEL_ID && !lastSeenMessagesReady && canAct) {
      await ensureLastSeenMessages();
      watchdogLastAction = "repaired_last_seen";
      watchdogLastRecoveryAt = new Date().toISOString();
      watchdogLastActionAt = now;
      watchdogRecoveryCount++;
      return;
    }

    const feedState = liveFeedHealth();
    if (
      LIVE_FEED_ENABLED &&
      (feedState === "STALE" || (feedState === "WAITING" && process.uptime() > 60)) &&
      canAct
    ) {
      const activeEndpointCount = [...liveFeedEndpointHealth.values()]
        .filter(item => item.status === "ACTIVE").length;

      if (!activeEndpointCount) {
        for (const url of LIVE_FEED_URLS) {
          const key = LIVE_FEED_URLS.indexOf(url) + 1;
          const state = liveFeedEndpointHealth.get(key);
          if (state?.status !== "DEAD") {
            liveFeedEndpointCooldownUntil.delete(url);
          }
        }
      }

      await pollLiveFeed();
      watchdogLastAction = activeEndpointCount
        ? "refreshed_stale_live_feed"
        : "forced_live_feed_failover";
      watchdogLastRecoveryAt = new Date().toISOString();
      watchdogLastActionAt = now;
      watchdogRecoveryCount++;
      return;
    }

    if (
      AUTO_DISCOVERY_ENABLED &&
      lastUpdateCheckAt &&
      now - new Date(lastUpdateCheckAt).getTime() > AUTO_DISCOVERY_POLL_MS * 2 &&
      canAct
    ) {
      await scanForGameUpdates();
      watchdogLastAction = "restarted_stale_discovery";
      watchdogLastRecoveryAt = new Date().toISOString();
      watchdogLastActionAt = now;
      watchdogRecoveryCount++;
      return;
    }

    const oldestQueueAge = queueOldestAgeMs();
    if (oldestQueueAge >= ALERT_QUEUE_STALE_AFTER_MS) {
      pumpAlertQueue();
      watchdogLastAction = "accelerated_stale_alert_queue";
      watchdogLastRecoveryAt = new Date().toISOString();
      watchdogLastActionAt = now;
      watchdogRecoveryCount++;
    }
  } catch (error) {
    recordMonitorError("other", error, "System watchdog failed");
  } finally {
    watchdogInFlight = false;
  }
}

let dailySelfCheckTimer = null;
let lastDailySelfCheckAt = null;
let lastDailySelfCheckResult = null;
let recoverySelfTestResult = null;

function runInternalRecoverySelfTests() {
  const now = Date.now();
  const checks = {};

  try {
    checks.stateMachine =
      transitionEventState({
        occurredAt: now - 2 * 60_000,
        now,
        cycleMs: 30 * 60_000,
        activeMs: 5 * 60_000
      }) === "ACTIVE";
  } catch {
    checks.stateMachine = false;
  }

  const failed = Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);

  recoverySelfTestResult = {
    ok: failed.length === 0,
    checks,
    failed,
    at: new Date().toISOString()
  };
  return recoverySelfTestResult;
}

async function runDailySelfCheck() {
  if (persistenceStats().enabled) {
    try {
      await cleanupStorage(Number(process.env.EVENT_RETENTION_DAYS || 30));
    } catch (error) {
      recordMonitorError("storage", error, "Supabase retention cleanup failed");
    }
  }

  const recovery = runInternalRecoverySelfTests();

  const checks = {
    discord: client.isReady(),
    alertChannel: Boolean(CHANNEL_ID),
    liveFeed: !LIVE_FEED_ENABLED || liveFeedHealth() !== "STALE",
    queue: alertQueueDepth() < ALERT_QUEUE_MAX,
    lastSeen: !LAST_SEEN_CHANNEL_ID || lastSeenMessagesReady,
    discovery:
      !AUTO_DISCOVERY_ENABLED ||
      AUTO_DISCOVERY_SOURCES.length === 0 ||
      [...autoDiscoverySourceHealth.values()]
        .some(item => item.status === "ACTIVE"),
    png: eggImageCatalog.length === 0 ||
      eggImageCatalog
        .filter(isPetImageEligibleEntry)
        .every(entry =>
          petPngBufferCache.has(normalizeFeedKey(entry.petName)) &&
          petPngBufferCache.get(normalizeFeedKey(entry.petName))?.buffer
        ),
    circuit: discordCircuit.state !== "OPEN",
    recoverySelfTests: recovery.ok
  };

  const failed = Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);

  lastDailySelfCheckAt = new Date().toISOString();
  lastDailySelfCheckResult = {
    ok: failed.length === 0,
    checks,
    failed,
    at: lastDailySelfCheckAt
  };

  if (failed.length) {
    recordMonitorError(
      "other",
      null,
      "Daily self-check found issues: " + failed.join(", ")
    );
  } else {
    console.log("Daily self-check: all core systems healthy.");
  }

  return lastDailySelfCheckResult;
}

function scheduleDailySelfCheck() {
  const run = () => {
    runDailySelfCheck().catch(error => {
      recordMonitorError("other", error, "Daily self-check failed");
    });
  };

  setTimeout(run, 120_000);

  if (!dailySelfCheckTimer) {
    dailySelfCheckTimer = setInterval(run, 24 * 60 * 60 * 1000);
  }
}

function cleanupCaches(now = Date.now()) {
  for (const [key, timestamp] of seen) {
    if (now - timestamp > SEEN_TTL_MS) seen.delete(key);
  }

  for (const [key, timestamp] of alertedMessageIds) {
    if (now - timestamp > SEEN_TTL_MS) alertedMessageIds.delete(key);
  }

  for (const store of [apiRate, adminApiRate, imageProxyRate]) {
    for (const [key, timestamps] of store) {
      const fresh = timestamps.filter(timestamp => now - timestamp < 60_000);
      if (fresh.length) store.set(key, fresh);
      else store.delete(key);
    }
  }
}

function rateLimitKey(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length) {
    return forwarded.split(",")[0].trim();
  }
  return req.ip || "unknown";
}

function consumeWindowRateLimit(store, key, max, windowMs = 60_000) {
  const now = Date.now();
  const timestamps = (store.get(key) || []).filter(
    timestamp => now - timestamp < windowMs
  );

  if (timestamps.length >= max) {
    store.set(key, timestamps);
    return false;
  }

  timestamps.push(now);
  store.set(key, timestamps);
  return true;
}

function consumeApiRateLimit(key) {
  return consumeWindowRateLimit(apiRate, key, API_RATE_LIMIT_PER_MINUTE);
}

function consumeAdminApiRateLimit(key) {
  return consumeWindowRateLimit(
    adminApiRate,
    key,
    ADMIN_API_RATE_LIMIT_PER_MINUTE
  );
}

function consumeImageProxyRateLimit(key) {
  return consumeWindowRateLimit(
    imageProxyRate,
    key,
    IMAGE_PROXY_RATE_LIMIT_PER_MINUTE
  );
}

function setRetryAfter(res, seconds) {
  res.setHeader("Retry-After", String(Math.max(1, Math.ceil(Number(seconds) || 1))));
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

function verifyAdminToken(req) {
  const supplied = String(req.header("x-admin-token") || "");
  if (!ADMIN_API_TOKEN || !supplied) return false;

  const suppliedBuffer = Buffer.from(supplied, "utf8");
  const expectedBuffer = Buffer.from(ADMIN_API_TOKEN, "utf8");

  return suppliedBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(suppliedBuffer, expectedBuffer);
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

  if (!resolveAlertEntry(value)) return false;

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

function isLastSeenEligibleEntry(entry) {
  if (!entry || entry.active === false) return false;

  const eggKey = normalizeFeedKey(entry.eggName);
  const petKey = normalizeFeedKey(entry.petName);
  const areaKey = normalizeFeedKey(entry.biome);

  if (NON_NEST_SPAWN_EGGS.has(eggKey) || NON_NEST_SPAWN_PETS.has(petKey)) {
    return false;
  }

  if (areaKey === "event" || areaKey === "shop" || areaKey === "robux") {
    return false;
  }

  return true;
}

function isAlertEligibleEntry(entry) {
  return isLastSeenEligibleEntry(entry);
}

function isPetImageEligibleEntry(entry) {
  return Boolean(
    entry &&
    entry.active !== false &&
    String(entry.petName || "").trim()
  );
}

function resolveAlertEntry(event) {
  const name = event?.eggName || event?.displayName || "";
  if (!name) return null;

  const existing = findCatalogEgg(name);
  const entry =
    existing ||
    ensureCatalogEgg(name, event?.rarity || "", event?.biome || "Unknown");

  return isAlertEligibleEntry(entry) ? entry : null;
}

function getLastSeenEntries(rarity) {
  const map = lastSeenByRarity[rarity];
  if (!map) return [];

  const unique = new Map();

  for (const entry of eggImageCatalog) {
    if (
      !isLastSeenEligibleEntry(entry) ||
      entry?.rarity?.toLowerCase() !== rarity
    ) {
      continue;
    }

    const key = eggIdentityKey(entry.eggName);
    if (!key || unique.has(key)) continue;

    unique.set(key, {
      entry,
      record: map.get(key) || null
    });
  }

  return [...unique.values()];
}
function customEmojiNameForEgg(entry) {
  const raw = String(entry?.eggName || entry?.petName || "egg")
    .toLowerCase()
    .replace(/\s+egg$/i, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return ("egg_" + raw).slice(0, 32).replace(/_+$/g, "") || "egg_icon";
}

function getEggCustomEmoji(entry) {
  return eggCustomEmojiCache.get(normalizeFeedKey(entry?.eggName)) || null;
}

function buildEggLinePrefix(entry) {
  const emoji = getEggCustomEmoji(entry);
  return emoji ? emoji.toString() : "🥚";
}

async function fetchRemoteImageBufferForEmoji(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LIVE_FEED_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: {
        "accept": "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.9,*/*;q=0.8",
        "user-agent": "FSMM-SAB-Live-Notifier/6.0"
      },
      signal: controller.signal
    });

    if (!response.ok) return null;

    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength && contentLength > MAX_REMOTE_IMAGE_BYTES) return null;

    const input = Buffer.from(await response.arrayBuffer());
    if (input.length > MAX_REMOTE_IMAGE_BYTES) return null;

    return input;
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveEggCustomEmojiBuffer(entry) {
  if (!entry?.sourcePage) return null;

  try {
    const { response, body } = await fetchLiveFeed(entry.sourcePage);
    if (!response.ok) return null;

    const eggKey = normalizeFeedKey(entry.eggName);
    const petKey = normalizeFeedKey(entry.petName);
    const candidates = [];

    for (const match of String(body || "").matchAll(/<img\b[^>]*>/gi)) {
      const attrs = extractTagAttributes(match[0]);
      const src = attrs.src || attrs["data-src"] || attrs["data-lazy-src"] || "";
      if (!src) continue;

      const alt = String(attrs.alt || "").toLowerCase();
      const title = String(attrs.title || "").toLowerCase();
      let score = 0;

      if (normalizeFeedKey(alt).includes(eggKey)) score += 40;
      if (normalizeFeedKey(title).includes(eggKey)) score += 25;
      if (normalizeFeedKey(alt).includes(petKey)) score += 10;

      try {
        const resolved = new URL(src, entry.sourcePage).href;
        const pathname = new URL(resolved).pathname.toLowerCase();

        if (pathname.includes("egg")) score += 10;
        if (pathname.includes(slugify(entry.petName || ""))) score += 5;

        candidates.push({ url: resolved, score });
      } catch {}
    }

    candidates.sort((a, b) => b.score - a.score);

    for (const candidate of candidates.slice(0, 5)) {
      const input = await fetchRemoteImageBufferForEmoji(candidate.url);
      if (!input) continue;

      try {
        const output = await sharp(input, { failOn: "none" })
          .ensureAlpha()
          .resize({
            width: 128,
            height: 128,
            fit: "contain",
            background: { r: 0, g: 0, b: 0, alpha: 0 }
          })
          .png({ compressionLevel: 9 })
          .toBuffer();

        if (output.length <= 256 * 1024) return output;
      } catch {}
    }
  } catch (error) {
    console.warn(
      "Egg emoji image lookup failed for " + entry.eggName + ":",
      error?.message || error
    );
  }

  return null;
}

async function getEggEmojiGuild() {
  try {
    if (LAST_SEEN_CHANNEL_ID) {
      const channel = await getLastSeenChannel();
      if (channel?.guild) return channel.guild;
    }
  } catch {}

  if (alertChannel?.guild) return alertChannel.guild;

  if (CHANNEL_ID) {
    try {
      const channel = await client.channels.fetch(CHANNEL_ID);
      if (channel?.guild) {
        alertChannel = channel;
        return channel.guild;
      }
    } catch {}
  }

  return client.guilds.cache.first() || null;
}

async function ensureEggCustomEmojis() {
  if (eggCustomEmojiSetupState.running) return eggCustomEmojiSetupState.ready;

  const guild = await getEggEmojiGuild();
  if (!guild) {
    eggCustomEmojiSetupState.lastError = "No target guild available";
    return false;
  }

  eggCustomEmojiSetupState.running = true;

  try {
    const existing = await guild.emojis.fetch();

    for (const entry of eggImageCatalog.filter(isLastSeenEligibleEntry)) {
      const emojiName = customEmojiNameForEgg(entry);
      const current = existing.find(emoji => emoji.name === emojiName);

      if (current) {
        eggCustomEmojiCache.set(normalizeFeedKey(entry.eggName), current);
        continue;
      }

      const buffer = await resolveEggCustomEmojiBuffer(entry);
      if (!buffer) {
        console.warn("No egg artwork available for custom emoji:", entry.eggName);
        continue;
      }

      try {
        const created = await guild.emojis.create({
          attachment: buffer,
          name: emojiName,
          reason: "Steal An Egg Last Seen custom egg icon"
        });

        eggCustomEmojiCache.set(normalizeFeedKey(entry.eggName), created);
        console.log("Created custom egg emoji:", emojiName, created.id);
      } catch (error) {
        console.warn(
          "Custom emoji creation failed for " + entry.eggName + ":",
          error?.message || error
        );
      }
    }

    eggCustomEmojiSetupState.ready = true;
    eggCustomEmojiSetupState.lastError = null;

    console.log(
      "Custom egg emojis ready:",
      eggCustomEmojiCache.size + "/" +
      eggImageCatalog.filter(isLastSeenEligibleEntry).length
    );

    return true;
  } catch (error) {
    eggCustomEmojiSetupState.lastError = error?.message || String(error);
    console.warn("Custom egg emoji setup failed:", eggCustomEmojiSetupState.lastError);
    return false;
  } finally {
    eggCustomEmojiSetupState.running = false;
  }
}

function getEggVisuals(entry) {
  const petKey = normalizeFeedKey(entry?.petName || entry?.eggName);

  const icons = {
    "king snake": "🐍",
    "yeti": "❄️",
    "cerberus": "🐺",
    "kraken": "🦑",
    "t rex": "🦖",
    "tralaledon": "🦕",
    "cosmic skeleton boss": "☠️",
    "cosmic dragon": "🐉",
    "stag": "🦌",
    "mutant shark": "🦈",
    "gargoyle": "🗿",
    "razorfang": "🦷",
    "pure jellyfish": "🪼",
    "centaur": "🐎",
    "ice dragon": "❄️",
    "phoenix": "🔥",
    "lava dragon": "🌋",
    "el maja": "🦬",
    "mosasaurus": "🦖",
    "eternal lunar dragon": "🌙",
    "oni tiger": "🐯",
    "gorilla king": "🦍",
    "skeleton horse": "🐴",
    "pegasus": "🪽",
    "kitsune": "🦊",
    "unicorn": "🦄",
    "nightflame": "🌑",
    "world burner": "🌍",
    "archangel": "👼"
  };

  return {
    egg: buildEggLinePrefix(entry),
    pet: icons[petKey] || "✨"
  };
}

function lastSeenContentFingerprint(rarity) {
  return JSON.stringify(
    getLastSeenEntries(rarity).map(({ entry, record }) => ({
      egg: entry?.eggName || null,
      pet: entry?.petName || null,
      biome: entry?.biome || "Unknown",
      seen: record
        ? {
            area: record.area || "Unknown",
            spawnedAt: record.spawnedAt || null
          }
        : null
    }))
  );
}

function buildLastSeenEmbed(rarity) {
  const entries = getLastSeenEntries(rarity);
  const seenEntries = entries
    .filter(item => item.record)
    .sort((a, b) =>
      (Date.parse(b.record?.spawnedAt || "") || 0) -
      (Date.parse(a.record?.spawnedAt || "") || 0)
    );

  const neverEntries = [...entries]
    .filter(item => !item.record)
    .sort((a, b) =>
      String(a.entry.eggName || "").localeCompare(String(b.entry.eggName || ""))
    );

  const lines = [];
  const renderedEggs = new Set();

  for (const { entry, record } of seenEntries) {
    const timestamp = Date.parse(record.spawnedAt);
    const unix = Number.isFinite(timestamp)
      ? Math.floor(timestamp / 1000)
      : Math.floor(Date.now() / 1000);

    const displayArea =
      record.area && record.area !== "Unknown"
        ? record.area
        : entry.biome || "Unknown";

    const renderedKey = eggIdentityKey(entry.eggName || entry.petName);
    if (!renderedEggs.has(renderedKey)) {
      renderedEggs.add(renderedKey);
      lines.push(
        buildEggLinePrefix(entry) +
        " **" + (entry.eggName || (entry.petName + " Egg")) +
        "** — <t:" + unix + ":R> • 📍 " +
        String(displayArea).slice(0, 60)
      );
    }
  }

  if (neverEntries.length) {
    lines.push("", "**Not seen yet**");

    for (const { entry } of neverEntries) {
      const renderedKey = eggIdentityKey(entry.eggName || entry.petName);
      if (renderedEggs.has(renderedKey)) continue;

      renderedEggs.add(renderedKey);
      lines.push(
        buildEggLinePrefix(entry) +
        " **" + (entry.eggName || (entry.petName + " Egg")) +
        "** — Never"
      );
    }
  }

  if (!lines.length) lines.push("No eggs are configured for this rarity.");

  return new EmbedBuilder()
    .setColor(lastSeenColor(rarity))
    .setTitle("🕒 " + lastSeenLabel(rarity) + " • Last Seen")
    .setDescription(lines.join("\n").slice(0, 4090))
    .setFooter({
      text: "Powered by FSMM • Steal An Egg"
    })
    .setTimestamp();
}
async function getLastSeenChannel() {
  if (!LAST_SEEN_CHANNEL_ID) return null;
  if (lastSeenChannel?.isTextBased()) return lastSeenChannel;

  try {
    const channel = await client.channels.fetch(LAST_SEEN_CHANNEL_ID);
    if (channel?.isTextBased()) {
      lastSeenChannel = channel;
      return channel;
    }
  } catch {
    // The configured ID may be stale or inaccessible; recover by channel name.
  }

  const normalizedNames = new Set(["last-seen", "last seen", "last_seen"]);
  for (const guild of client.guilds.cache.values()) {
    const matches = [...guild.channels.cache.values()].filter(channel => {
      if (!channel?.isTextBased()) return false;
      const name = String(channel.name || "").trim().toLowerCase();
      return normalizedNames.has(name);
    });

    if (matches.length) {
      lastSeenChannel = matches[0];
      console.log("Last Seen channel recovered by name:", lastSeenChannel.id);
      return lastSeenChannel;
    }
  }

  return null;
}

async function findExistingLastSeenMessage(channel, rarity) {
  const expectedTitle = "🕒 " + lastSeenLabel(rarity) + " • Last Seen";

  const cached = lastSeenMessageCache.get(rarity);
  if (cached && cached.channelId === channel.id) {
    if (
      cached.author?.id === client.user?.id &&
      cached.embeds?.[0]?.title === expectedTitle
    ) {
      return cached;
    }
    lastSeenMessageCache.delete(rarity);
  }

  if (lastSeenMessageIds[rarity]) {
    try {
      const saved = await channel.messages.fetch(lastSeenMessageIds[rarity]);

      if (
        saved &&
        saved.author?.id === client.user?.id &&
        saved.embeds?.[0]?.title === expectedTitle
      ) {
        lastSeenMessageCache.set(rarity, saved);
        return saved;
      }
    } catch {
      // Saved message may have been deleted or become inaccessible.
    }

    lastSeenMessageIds[rarity] = null;
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

    // Keep one canonical message per rarity and remove older duplicates.
    const primary = matches[0];
    lastSeenMessageIds[rarity] = primary.id;
    lastSeenMessageCache.set(rarity, primary);

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
  if (lastSeenMessagesReady) return true;
  if (lastSeenMessagesInitInFlight) return lastSeenMessagesInitInFlight;

  lastSeenMessagesInitInFlight = (async () => {
    const channel = await getLastSeenChannel();
    if (!channel) return false;

    for (const rarity of LAST_SEEN_RARITIES) {
      const embed = buildLastSeenEmbed(rarity);
      const message = await findExistingLastSeenMessage(channel, rarity);

      if (message) {
        // Refresh once at startup so the canonical message matches current state.
        await message.edit({ embeds: [embed] });
        lastSeenMessageCache.set(rarity, message);
        lastSeenContentFingerprints.set(
          rarity,
          lastSeenContentFingerprint(rarity)
        );
        continue;
      }

      // A brand-new message is created only when no canonical message exists.
      const created = await channel.send({ embeds: [embed] });
      lastSeenMessageIds[rarity] = created.id;
      lastSeenMessageCache.set(rarity, created);
      lastSeenContentFingerprints.set(
        rarity,
        lastSeenContentFingerprint(rarity)
      );
      console.log("Created canonical Last Seen message:", rarity, created.id);
    }

    lastSeenMessagesReady = true;
    scheduleStateSave();
    return true;
  })();

  try {
    return await lastSeenMessagesInitInFlight;
  } finally {
    lastSeenMessagesInitInFlight = null;
  }
}

async function updateLastSeenMessage(rarity) {
  if (!LAST_SEEN_CHANNEL_ID || !LAST_SEEN_RARITIES.includes(rarity)) return;

  const existingPromise = lastSeenUpdateInFlight.get(rarity);
  if (existingPromise) {
    await existingPromise;
    return;
  }

  const promise = (async () => {
    // Resolve the canonical messages before any update can happen.
    const ready = await ensureLastSeenMessages();
    if (!ready) return;

    const channel = await getLastSeenChannel();
    const contentFingerprint = lastSeenContentFingerprint(rarity);

    if (lastSeenContentFingerprints.get(rarity) === contentFingerprint) {
      return;
    }

    const embed = buildLastSeenEmbed(rarity);
    const message = await findExistingLastSeenMessage(channel, rarity);

    if (!message) {
      // Only recreate if the canonical message was actually deleted.
      const created = await channel.send({ embeds: [embed] });
      lastSeenMessageIds[rarity] = created.id;
      lastSeenMessageCache.set(rarity, created);
      lastSeenContentFingerprints.set(rarity, contentFingerprint);
      console.warn("Canonical Last Seen message was missing; recreated:", rarity, created.id);
    } else {
      // Normal update path: EDIT the existing Discord message.
      await message.edit({ embeds: [embed] });
      lastSeenMessageCache.set(rarity, message);
    }

    lastSeenContentFingerprints.set(rarity, contentFingerprint);
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

  if (!isLastSeenEligibleEntry(entry)) return;

  const canonical = entry?.eggName || eggName;
  const petName = entry?.petName || event?.displayName || canonical.replace(/\\s+Egg$/i, "").trim();

  const eventArea =
    event?.biome && event.biome !== "Unknown"
      ? event.biome
      : entry?.biome || "Unknown";

  lastSeenByRarity[rarity].set(eggIdentityKey(canonical), {
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
    if (!isLastSeenEligibleEntry(entry)) continue;

    const mapKey = eggIdentityKey(entry.eggName);
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

async function ensureAlertRoles() {
  if (!alertChannel?.guild) return;

  for (const rarity of ["secret", "eternal", "divine"]) {
    try {
      await resolveAlertRoleId(rarity);
    } catch (error) {
      console.warn("Alert role setup failed for " + rarity + ":", error?.message || error);
    }
  }

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
        resolvedRoleCache.delete(rarity);
        continue;
      }

      if (!role.mentionable) {
        try {
          if (alertChannel.guild.members.me?.permissions?.has(PermissionFlagsBits.ManageRoles)) {
            await role.setMentionable(true, "Steal An Egg rarity alert role");
          }
        } catch (error) {
          console.warn("Could not make alert role mentionable:", rarity, error?.message || error);
        }
      }

      console.log("Alert role ready:", rarity, role.name);
    } catch (error) {
      console.error("Alert role validation failed for " + rarity + ":", error);
    }
  }
}

function buildAlertEmbed(event, _latencyMs = null, includeImage = true) {
  const rarity = String(event.rarity || "Unknown").trim();
  const rarityKey = rarity.toLowerCase();
  const emoji = getEggAlertEmoji(event);
  const eggName = String(event.eggName || "Unknown Egg").trim();
  const petName = String(event.displayName || event.eggName || "Unknown").trim();
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
        secret: 0x18181b,
        eternal: 0xec4899,
        divine: 0xfacc15
      }[rarityKey] || 0x5865f2
    )
    .setTitle(emoji + "  " + petName.slice(0, 200))
    .setDescription(
      "**" + rarity + " Egg** • " + eggName.slice(0, 200)
    )
    .addFields(fields)
    .setFooter({ text: "Powered by FSMM • Steal An Egg" })
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

async function enrichAlertEvent(event, entryOverride = null) {
  const entry = entryOverride || resolveAlertEntry(event);
  if (!entry) return null;

  event.eggName = entry.eggName;
  event.displayName = entry.petName || entry.displayName || entry.eggName;
  event.biome = event.biome || entry.biome || "Unknown";

  const imageKey = normalizeFeedKey(entry.petName);
  const cachedPng = petPngBufferCache.get(imageKey);

  if (cachedPng && Date.now() - cachedPng.at < PET_PNG_CACHE_TTL_MS) {
    event.imageBuffer = cachedPng.buffer;
  }

  // Live alerts are PNG-only. Never expose the original WebP/JPEG source
  // directly in a Discord embed. A warmed transparent PNG is attached to the
  // message, or generated immediately after delivery.
  event.imageUrl = null;

  // Never block a live alert on a cold image cache. A cached PNG is used
  // immediately; a missing PNG is prepared in the background and attached
  // after the alert has already been delivered.
  if (!cachedPng) {
    getPetPngBuffer(entry.petName)
      .then(buffer => {
        if (buffer) {
          console.log("Background pet PNG ready:", entry.petName);
        }
      })
      .catch(error => {
        console.warn(
          "Background pet image preparation failed for " + entry.petName + ":",
          error?.message || error
        );
      });
  }

  return event;
}

async function runAlertPipelineSelfTest() {
  if (!ALERT_PIPELINE_SELF_TEST_ONCE || alertPipelineSelfTestRunThisProcess || alertPipelineSelfTestInFlight) {
    return alertPipelineSelfTestResult;
  }

  if (!client.isReady() || !CHANNEL_ID) return null;

  alertPipelineSelfTestRunThisProcess = true;
  alertPipelineSelfTestInFlight = true;

  try {
    const entry =
      findCatalogEgg("Gargoyle") ||
      findCatalogEgg("King Snake") ||
      eggImageCatalog.find(item => isPetImageEligibleEntry(item));

    if (!entry) {
      throw new Error("self_test_catalog_entry_missing");
    }

    const testEvent = {
      live: true,
      eggName: entry.eggName,
      displayName: entry.petName,
      rarity: entry.rarity,
      biome: entry.biome || "Jungle",
      spawnedAt: new Date().toISOString(),
      source: "Test",
      selfTest: true
    };

    const sent = await sendAlert(testEvent);

    alertPipelineSelfTestAt = new Date().toISOString();
    alertPipelineSelfTestResult = {
      ok: Boolean(sent),
      sent: Boolean(sent),
      eggName: entry.eggName,
      petName: entry.petName,
      channelConfigured: Boolean(CHANNEL_ID),
      roleResolved: Boolean(await resolveAlertRoleId(entry.rarity)),
      at: alertPipelineSelfTestAt
    };

    scheduleStateSave();

    console.log(
      "Alert pipeline self-test:",
      sent ? "PASSED" : "FAILED",
      entry.rarity,
      entry.petName
    );

    return alertPipelineSelfTestResult;
  } catch (error) {
    alertPipelineSelfTestAt = new Date().toISOString();
    alertPipelineSelfTestResult = {
      ok: false,
      sent: false,
      at: alertPipelineSelfTestAt,
      error: String(error?.message || error).slice(0, 500)
    };

    scheduleStateSave();
    console.error("Alert pipeline self-test failed:", error);
    return alertPipelineSelfTestResult;
  } finally {
    alertPipelineSelfTestInFlight = false;
  }
}


async function findRecentMatchingAlertMessage(channel, event, entry) {
  if (!channel?.messages?.fetch || !client.user) return null;

  const targetName = normalizeFeedKey(
    entry?.petName || event?.displayName || event?.eggName || ""
  );
  const targetEgg = normalizeFeedKey(event?.eggName || entry?.eggName || "");
  const targetTimestamp = Date.parse(event?.spawnedAt || "");

  if (!targetName || !targetEgg || !Number.isFinite(targetTimestamp)) {
    return null;
  }

  try {
    const recent = await channel.messages.fetch({ limit: 25 });

    return [...recent.values()].find(message => {
      if (message.author?.id !== client.user.id) return false;

      const embed = message.embeds?.[0];
      if (!embed) return false;

      const footer = normalizeFeedKey(embed.footer?.text || "");
      if (!footer.includes("powered by fsmm")) return false;

      const title = normalizeFeedKey(embed.title || "");
      const description = normalizeFeedKey(embed.description || "");
      if (!title.includes(targetName)) return false;
      if (!description.includes(targetEgg.replace(/\begg\b/g, "").trim())) return false;

      const embedTimestamp = Date.parse(embed.timestamp || "");
      if (!Number.isFinite(embedTimestamp)) return false;

      return Math.abs(embedTimestamp - targetTimestamp) <= Math.max(10_000, ALERT_SEMANTIC_DEDUP_BUCKET_MS);
    }) || null;
  } catch (error) {
    console.warn(
      "Recent alert recovery check failed:",
      error?.message || error
    );
    return null;
  }
}

async function sendDiscordPayload(channel, payload) {
  if (!discordCircuitCanSend()) {
    const error = new Error("discord_circuit_open");
    error.status = 503;
    error.retryAfter = discordCircuitRetryAfterSeconds();
    throw error;
  }

  try {
    const message = await channel.send(payload);
    recordDiscordSendSuccess();
    return message;
  } catch (error) {
    recordDiscordSendFailure(error);
    throw error;
  }
}

async function sendAlert(event, latencyMs = null) {
  const entry = resolveAlertEntry(event);
  if (!entry) {
    console.warn(
      "Skipped ineligible egg alert:",
      event?.rarity || "Unknown",
      event?.eggName || event?.displayName || "Unknown"
    );
    return false;
  }

  const bypassDeliveryDedup = event?.source === "Test";
  const deliveryKeys = bypassDeliveryDedup ? [] : reserveAlertDelivery({
    ...event,
    eggName: entry.eggName,
    displayName: entry.petName || event.displayName,
    rarity: entry.rarity,
    biome: event.biome || entry.biome || "Unknown"
  });

  if (!bypassDeliveryDedup && !deliveryKeys) return false;

  const enriched = await enrichAlertEvent(event, entry);
  if (!enriched) {
    releaseAlertDelivery(deliveryKeys, false);
    return false;
  }

  const channel = await getAlertChannel();
  const rarity = String(event.rarity || "Unknown").trim();
  const rarityKey = rarity.toLowerCase();
  const roleId = await resolveAlertRoleId(rarity);
  const petName = String(event.displayName || event.eggName || "Unknown").trim();
  const area = String(event.biome || "Unknown").trim();
  const alertEggEmoji = getEggAlertEmoji(event);

  const alertText =
    alertEggEmoji +
    " **" +
    petName.slice(0, 120) +
    "** • **" +
    rarity +
    "**" +
    (area !== "Unknown" ? " • 📍 " + area.slice(0, 80) : "");

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
    sentMessage = await sendDiscordPayload(channel, payload);
  } catch (firstError) {
    console.error("Primary alert send failed:", firstError);
    alertMetrics.sendFailures++;
    alertMetrics.lastFailureAt = new Date().toISOString();
    alertChannel = null;

    try {
      // A timeout/connection failure can be ambiguous: Discord may have accepted
      // the message even if our request did not receive the response. Check the
      // channel first so recovery never creates an accidental duplicate.
      const recoveryChannel = await getAlertChannel();
      const recovered = await findRecentMatchingAlertMessage(
        recoveryChannel,
        event,
        entry
      );

      if (recovered) {
        sentMessage = recovered;
        console.warn(
          "Recovered existing alert after ambiguous send failure:",
          event?.rarity,
          event?.eggName,
          "message=" + recovered.id
        );
      } else {
        if (event.imageUrl || event.imageBuffer) {
          payload.embeds = [buildAlertEmbed(event, latencyMs, true)];
        }

        sentMessage = await sendDiscordPayload(recoveryChannel, payload);
      }
    } catch (retryError) {
      alertMetrics.sendFailures++;
      alertMetrics.lastFailureAt = new Date().toISOString();
      releaseAlertDelivery(deliveryKeys, false);
      throw retryError;
    }
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
          recordMonitorError(
            "image",
            error,
            "Post-send PNG attach failed"
          );
        });
    }
  }

  alertCount++;
  recordAlertMetric(event, area);
  recordLifecycle(event, "SENT", {
    detail: "discord_message_id=" + String(sentMessage?.id || "unknown")
  });
  recordLatency(latencyMs);
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

  try {
    await persistAlertDelivery(
      deliveryKeys.map(deliveryKey => ({
        deliveryKey,
        eventId: event?.eventId || event?.storedEventId || null,
        channelId: sentMessage?.channelId || CHANNEL_ID || null,
        discordMessageId: sentMessage?.id || null,
        status: "sent",
        attempts: 1,
        sentAt: new Date().toISOString(),
        incidentId: event?.incidentId || null,
        confidence: Number.isFinite(Number(event?.confidence)) ? Number(event.confidence) : null,
        evidence: Array.isArray(event?.evidence) ? event.evidence.slice(0, 8) : []
      }))
    );
  } catch (error) {
    // Discord delivery is already successful; storage must not turn a good
    // alert into a false failure. The failed persistence is still surfaced.
    recordMonitorError("storage", error, "Supabase alert delivery persistence failed");
  }

  releaseAlertDelivery(deliveryKeys, true);
  // Persist the claim immediately so a restart cannot replay a fresh alert.
  scheduleStateSave();
  return true;
}

async function runWeeklyReliabilityReport() {
  if (!WEEKLY_RELIABILITY_REPORT_ENABLED || !WEEKLY_RELIABILITY_REPORT_CHANNEL_ID) return;
  if (!shouldRunWeeklyReport()) return;

  const channel = await getAlertChannel();
  if (!channel) return;

  const summary = getOpsSummary();
  const content = buildWeeklyReportText(summary);

  try {
    if (!discordCircuitCanSend()) return;
    await sendDiscordPayload(channel, { content });
    markWeeklyReportSent(new Date().toISOString());
    scheduleStateSave();
    console.log("Weekly reliability report sent.");
  } catch (error) {
    recordMonitorError("discord", error, "Weekly reliability report failed");
  }
}

async function processSpawnMessage(message) {
  if (!MONITOR_ENABLED || !message) return;
  if (message.author?.id === client.user?.id) return;

  const messageData = extractMessageData(message);

  const rareSourceChannelAllowed =
    !SOURCE_CHANNEL_IDS.size || SOURCE_CHANNEL_IDS.has(message.channelId);
  const rareSourceBotAllowed =
    !SOURCE_BOT_IDS.size || SOURCE_BOT_IDS.has(message.author?.id);

  if (!rareSourceChannelAllowed || !rareSourceBotAllowed) {
    return;
  }

  lastSourceMessageAt = new Date(message.createdTimestamp || Date.now()).toISOString();
  lastSourceMessageId = message.id || null;

  const revengeSignal = detectRevengeEventSignal(messageData);
  if (revengeSignal) {
    safeRun(
      publishRevengeEventUpdate("source-signal", revengeSignal.type),
      "Revenge event signal"
    );
  }

  const event = parseSpawn(messageData, RARITIES);
  if (!event) return;

  if (!resolveAlertEntry(event)) {
    console.warn(
      "Ignored ineligible source spawn:",
      event.rarity,
      event.eggName,
      "area=" + event.biome
    );
    return;
  }

  event.spawnedAt = new Date(messageData.createdTimestamp || Date.now()).toISOString();
  if (messageData.imageUrl) event.imageUrl = messageData.imageUrl;
  if (messageData.messageUrl) event.messageUrl = messageData.messageUrl;
  event.sourceEventId = message.id || null;

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

  const queued = enqueueAlert(event, latencyMs);

  if (!queued.queued && queued.full) {
    alertedMessageIds.delete(message.id);
    seen.delete(semanticKey);
    console.warn(
      "Discord alert queue full; source message will be retried:",
      message.id
    );
  } else if (queued.queued) {
    console.log(
      "Queued live egg spawn:",
      semanticKey,
      "priority=" + rarityPriority(event.rarity),
      "latencyMs=" + (latencyMs ?? "unknown"),
      "queueDepth=" + alertQueueDepth()
    );
  } else if (queued.duplicate) {
    console.log("Live source duplicate suppressed:", semanticKey);
  }

  inFlightKeys.delete(semanticKey);
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

function dashboardHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Steal An Egg Tracker</title>
<style>
body{font-family:Inter,system-ui,sans-serif;margin:0;padding:28px;background:#0b1020;color:#eef2ff}
h1{margin:0 0 6px}.sub{opacity:.7;margin-bottom:22px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:14px}
.card{background:#11182d;border:1px solid #25304e;border-radius:14px;padding:16px}
.label{opacity:.65;font-size:12px;text-transform:uppercase;letter-spacing:.08em}
.value{font-size:28px;font-weight:700;margin-top:8px}
.ok{color:#6ee7b7}.warn{color:#fbbf24}.bad{color:#fb7185}
#updated{margin-top:18px;opacity:.65;font-size:13px}
</style>
</head>
<body>
<h1>Steal An Egg Tracker</h1>
<div class="sub">Live system health, reliability, source failover and transparent pet-image readiness.</div>
<div id="grid" class="grid"></div>
<div id="updated">Loading…</div>
<script>
const esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function card(name,value,cls=""){return '<div class="card"><div class="label">'+esc(name)+'</div><div class="value '+cls+'">'+esc(value)+'</div></div>'}
function render(h){
  const live=h.liveFeedHealth||"UNKNOWN";
  const png=String(h.transparentPetImagesReady??0)+"/"+String(h.petImageCatalogSize??0);
  const rel=h.reliability||{};
  const queue=h.alertDelivery?.alertQueueDepth??0;
  const html=[
    card("Bot",h.botReady?"ONLINE":"OFFLINE",h.botReady?"ok":"bad"),
    card("Live Feed",live,live==="ACTIVE"?"ok":live==="STALE"?"bad":"warn"),
    card("Queue",queue,queue>0?"warn":"ok"),
    card("Reliability Tracked",rel.trackedIncidents??0),
    card("Corroborated",rel.corroboratedEvents??0,"ok"),
    card("Anomaly Flags",rel.anomalyFlags??0,rel.anomalyFlags?"warn":"ok"),
    card("Transparent Pet PNG",png,png.split("/")[0]===png.split("/")[1]?"ok":"warn"),
    card("Persistence",h.persistence?.enabled?"ENABLED":"OFFLINE",h.persistence?.enabled?"ok":"warn"),
    card("Discord Circuit",h.discordCircuit?.state||"UNKNOWN",h.discordCircuit?.state==="CLOSED"?"ok":"warn"),
    card("Revenge Event",h.revengeEvent?.phase||"UNKNOWN",h.revengeEvent?.phase==="LIVE"?"ok":h.revengeEvent?.phase==="ENDED"?"warn":"warn")
  ].join("");
  document.getElementById("grid").innerHTML=html;
  document.getElementById("updated").textContent="Updated "+new Date().toLocaleTimeString();
}
async function refresh(){
  try{
    const res=await fetch("/health",{cache:"no-store"});
    const data=await res.json();
    render(data);
  }catch(e){
    document.getElementById("updated").textContent="Health request failed";
  }
}
refresh();setInterval(refresh,5000);
</script>
</body>
</html>`;
}

app.get("/dashboard", (_req, res) => {
  res.setHeader("content-type","text/html; charset=utf-8");
  res.setHeader("cache-control","no-store");
  res.send(dashboardHtml());
});

app.get("/api/images/status", (_req, res) => {
  const items = eggImageCatalog
    .filter(isPetImageEligibleEntry)
    .map(entry => {
      const key = normalizeFeedKey(entry.petName);
      const cached = petPngBufferCache.get(key);
      return {
        petName: entry.petName,
        rarity: entry.rarity,
        ready: Boolean(cached?.buffer),
        format: cached?.buffer ? "image/png" : null,
        transparent: Boolean(cached?.transparent)
      };
    });

  res.json({
    total: items.length,
    ready: items.filter(item => item.ready).length,
    transparentPngOnly: true,
    items
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
    detectedCount,
    alertCount,
    lastSpawnAt,
    lastAlertLatencyMs,
    averageAlertLatencyMs: latencySamples
      ? Math.round(totalLatencyMs / latencySamples)
      : null,
    alertDelivery: {
      duplicateSuppressed: alertMetrics.duplicateSuppressed,
      sendFailures: alertMetrics.sendFailures,
      lastSuccessAt: alertMetrics.lastSuccessAt,
      lastFailureAt: alertMetrics.lastFailureAt,
      byRarity: alertMetrics.byRarity,
      topAreas: [...alertMetrics.byArea.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([area, count]) => ({ area, count })),
      trackedDeliveryKeys: deliveredAlertKeys.size,
      alertQueueDepth: alertQueueDepth(),
      alertQueueActive: alertQueueActive,
      alertQueueMax: ALERT_QUEUE_MAX,
      alertQueueWorkers: ALERT_QUEUE_WORKERS,
      alertQueueRejected: alertMetrics.queueRejected,
      alertQueueRetried: alertMetrics.queueRetried,
      alertQueueReservedLiveSlots: ALERT_QUEUE_RESERVED_LIVE_SLOTS,
      alertQueueStaleAfterMs: ALERT_QUEUE_STALE_AFTER_MS,
      queueStalePromoted: alertMetrics.queueStalePromoted,
      alertQueueOldestAgeMs: queueOldestAgeMs()
    },
    ingestGlobalPerSecond: INGEST_GLOBAL_PER_SECOND,
    monitorErrors,
    errorMetrics,
    lastErrorCategory,
    lastErrorAt,
    cacheSize: seen.size,
    recentSpawns: recentSpawns.length,
    liveFeedEnabled: LIVE_FEED_ENABLED,
    liveFeedEndpointCount: LIVE_FEED_URLS.length,
    liveFeedLastPollAt,
    liveFeedLastEventAt,
    liveFeedLastSuccessAt,
    liveFeedHealth: liveFeedHealth(),
    liveFeedConsecutiveFailures,
    liveFeedRecoveryCount,
    liveFeedEndpointHealth: [...liveFeedEndpointHealth.values()],
    liveFeedFailoverOrder: [...rankSourceHealth(
      [...liveFeedEndpointHealth.values()]
    )],
    liveFeedEventsReceived,
    liveFeedEventsAccepted,
    liveFeedErrors,
    publicPngProxy: Boolean(PUBLIC_BASE_URL),
    sourceImageAlphaOnly: SOURCE_IMAGE_ALPHA_ONLY,
    persistence: persistenceStats(),
    alertPipelineSelfTest: {
      enabled: ALERT_PIPELINE_SELF_TEST_ONCE,
      at: alertPipelineSelfTestAt,
      result: alertPipelineSelfTestResult
    },
    reliability: reliabilitySummary(),
    ops: getOpsSummary(),
    alertsPaused,
    recoverySelfTests: recoverySelfTestResult,
    autoDiscoveryEnabled: AUTO_DISCOVERY_ENABLED,
    autoDiscoveredCount,
    lastUpdateCheckAt,
    autoDiscoverySources: discoverySummary(),
    autoDiscoverySummary: autoDiscoveryLastSummary,
    lastUpdateTitle,
    revengeEvent: getRevengeEventHealth(),
    spawnHistoryCount: spawnHistory.length,
    gameEventHistoryCount: gameEventHistory.length,
    memoryRssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    memorySoftLimitMb: MEMORY_SOFT_LIMIT_MB,
    memoryHardLimitMb: MEMORY_HARD_LIMIT_MB,
    statePersistence: {
      path: STATE_FILE,
      mode: STATE_PERSISTENCE_MODE,
      durableVolumeConfigured: DURABLE_VOLUME_CONFIGURED,
      backupFileEnabled: true,
      lastSeenFeedRestore: true
    },
    watchdog: {
      enabled: true,
      intervalMs: WATCHDOG_INTERVAL_MS,
      lastRunAt: watchdogLastRunAt,
      lastRecoveryAt: watchdogLastRecoveryAt,
      recoveryCount: watchdogRecoveryCount,
      lastAction: watchdogLastAction,
      inFlight: watchdogInFlight,
      status: watchdogStatus()
    },
    dailySelfCheck: {
      lastAt: lastDailySelfCheckAt,
      result: lastDailySelfCheckResult
    },
    discordCircuit: {
      state: discordCircuit.state,
      failures: discordCircuit.failures,
      openedAt: discordCircuit.openedAt || null,
      lastFailureAt: discordCircuit.lastFailureAt,
      lastSuccessAt: discordCircuit.lastSuccessAt
    },
    ops: getOpsSummary(),
    queueSplit: {
      live: alertQueueDepth("live"),
      source: alertQueueDepth("source"),
      api: alertQueueDepth("api"),
      total: alertQueueDepth()
    },
    lastSeenMessagesReady,
    customEggEmojisReady: eggCustomEmojiSetupState.ready,
    customEggEmojiCount: eggCustomEmojiCache.size,
    cachedPetImages: [...petPngBufferCache.keys()].length,
    transparentPetImagesReady: eggImageCatalog
      .filter(isPetImageEligibleEntry)
      .filter(entry => petPngBufferCache.has(normalizeFeedKey(entry.petName)))
      .length,
    petImageCatalogSize: eggImageCatalog.filter(isPetImageEligibleEntry).length
  });
});

app.get("/api/persistence", (_req, res) => {
  res.json(persistenceStats());
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
    autoDiscovery: {
      enabled: AUTO_DISCOVERY_ENABLED,
      pollMs: AUTO_DISCOVERY_POLL_MS,
      summary: autoDiscoveryLastSummary,
      sources: discoverySummary()
    },
    items: gameEventHistory.slice(0, 20)
  });
});

app.get("/join", (req, res) => {
  const jobId = String(req.query.jobId || "").trim();
  if (!/^[0-9a-fA-F-]{32,64}$/.test(jobId)) {
    return res.status(400).type("text").send("Invalid Roblox server id.");
  }

  const encodedJobId = encodeURIComponent(jobId);
  const robloxDeepLink = "roblox://experiences/start?placeId=" + SERVER_FINDER_PLACE_ID + "&gameInstanceId=" + encodedJobId;
  const robloxWebLink = "https://www.roblox.com/games/start?placeId=" + SERVER_FINDER_PLACE_ID + "&gameInstanceId=" + encodedJobId;

  const html = [
    "<!doctype html><html><head><meta charset=\"utf-8\">",
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">",
    "<title>Opening Roblox…</title>",
    "<style>body{font-family:Arial,sans-serif;background:#111827;color:#fff;display:grid;place-items:center;min-height:100vh;margin:0}main{text-align:center;max-width:420px;padding:32px}a{color:#111827;background:#fff;padding:12px 18px;border-radius:10px;text-decoration:none;font-weight:700;display:inline-block}p{color:#cbd5e1;line-height:1.5}</style>",
    "</head><body><main><h1>Opening Roblox…</h1><p>Trying to open the selected Steal An Egg server.</p>",
    "<a href=\"" + robloxDeepLink + "\">Open Roblox</a>",
    "<p><a href=\"" + robloxWebLink + "\">Use Roblox web fallback</a></p></main>",
    "<script>setTimeout(function(){window.location.href=" + JSON.stringify(robloxDeepLink) + ";},150);</script>",
    "</body></html>"
  ].join("");

  res.set("Cache-Control", "no-store");
  return res.type("html").send(html);
});

app.get("/api/discovery", (_req, res) => {
  res.json({
    enabled: AUTO_DISCOVERY_ENABLED,
    pollMs: AUTO_DISCOVERY_POLL_MS,
    sourceCount: AUTO_DISCOVERY_SOURCES.length,
    sources: discoverySummary(),
    summary: autoDiscoveryLastSummary,
    lastDecision: discoveryLastDecision,
    catalogSnapshot: discoveryCatalogSnapshot,
    changelog: discoveryChangelog.slice(0, 20)
  });
});

app.post("/api/discovery/scan", async (req, res) => {
  if (!AUTO_DISCOVERY_ENABLED) {
    return res.status(503).json({ error: "discovery_disabled" });
  }

  if (!verifyAdminToken(req)) {
    return res.status(401).json({ error: "invalid_admin_token" });
  }

  const key = rateLimitKey(req);
  if (!consumeAdminApiRateLimit(key)) {
    setRetryAfter(res, 60);
    return res.status(429).json({
      error: "admin_rate_limited",
      retryable: true
    });
  }

  if (autoDiscoveryInFlight) {
    setRetryAfter(res, 5);
    return res.status(409).json({
      error: "scan_in_progress",
      retryable: true
    });
  }

  try {
    await scanForGameUpdates();
    return res.json({
      ok: true,
      scan: discoveryLastDecision,
      summary: autoDiscoveryLastSummary
    });
  } catch (error) {
    recordMonitorError("discovery", error, "Manual discovery scan failed");
    return res.status(500).json({
      error: "discovery_scan_failed",
      detail: "scan_failed"
    });
  }
});

app.post("/api/notify-egg", async (req, res) => {
  const key = rateLimitKey(req);
  cleanupCaches();

  if (!consumeGlobalIngestRate()) {
    setRetryAfter(res, 1);
    return res.status(429).json({
      error: "global_rate_limited",
      retryable: true
    });
  }

  if (!verifyRequest(req)) {
    return res.status(401).json({ error: "invalid_signature" });
  }

  if (!consumeApiRateLimit(key)) {
    setRetryAfter(res, 60);
    return res.status(429).json({
      error: "rate_limited",
      retryable: true
    });
  }

  if (!isLiveEvent(req.body)) {
    return res.status(400).json({ error: "invalid_live_event" });
  }

  try {
    recordSpawnHistory(req.body, "Signed API");

    const queued = enqueueAlert(req.body, null);

    if (queued.full) {
      setRetryAfter(res, 1);
      return res.status(429).json({
        error: "alert_queue_full",
        retryable: true
      });
    }

    if (queued.duplicate) {
      return res.json({
        accepted: true,
        duplicate: true,
        queued: false
      });
    }

    return res.status(202).json({
      accepted: true,
      queued: true
    });
  } catch (error) {
    monitorErrors++;
    console.error("API alert queueing failed:", error);
    return res.status(500).json({ error: "alert_queue_failed" });
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
  console.log("Dr. Scramble’s Revenge tracker:", "enabled");

  if (!revengeEventTrackerTimer) {
    safeRun(checkRevengeEventTracker(), "Revenge event tracker startup");
    revengeEventTrackerTimer = setInterval(() => {
      safeRun(checkRevengeEventTracker(), "Revenge event tracker poll");
    }, REVENGE_EVENT_POLL_MS);
  }

  if (CHANNEL_ID) {
    try {
      alertChannel = await client.channels.fetch(CHANNEL_ID);
      console.log("Alert channel cached.");
      await ensureAlertRoles();
      await validateAlertRoles();
    } catch (error) {
      console.error("Alert channel preload failed:", error);
    }
  }

  await rebuildLastSeenFromHistory();

  if (CHANNEL_ID || LAST_SEEN_CHANNEL_ID) {
    try {
      await ensureEggCustomEmojis();
      console.log("Custom alert emojis ready for configured guild.");
    } catch (error) {
      monitorErrors++;
      console.error("Custom egg emoji initialization failed:", error);
    }
  }

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
  cleanupAdminCommandUsage();
}, 60_000);

setInterval(() => {
  runSystemWatchdog().catch(error => {
    recordMonitorError("other", error, "Watchdog interval failed");
  });
}, WATCHDOG_INTERVAL_MS);

startLiveFeedPoller();
startAutoDiscovery();
scheduleDailySelfCheck();

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
    "liveFeed=" + liveFeedHealth(),
    "detected=" + detectedCount,
    "alerts=" + alertCount,
    "errors=" + monitorErrors,
    "duplicates=" + alertMetrics.duplicateSuppressed,
    "feedFailures=" + liveFeedConsecutiveFailures,
    "feedEndpoints=" + [...liveFeedEndpointHealth.values()].filter(item => item.status === "ACTIVE").length + "/" + LIVE_FEED_URLS.length,
    "autoDiscovery=" + (AUTO_DISCOVERY_ENABLED ? "active" : "disabled") + ":" + [...autoDiscoverySourceHealth.values()].filter(item => item.status === "ACTIVE").length + "/" + AUTO_DISCOVERY_SOURCES.length,
    "avgLatencyMs=" + (latencySamples
      ? Math.round(totalLatencyMs / latencySamples)
      : "N/A"),
    "queue=" + alertQueueDepth() + "/" + ALERT_QUEUE_MAX,
    "workers=" + alertQueueActive + "/" + ALERT_QUEUE_WORKERS,
    "watchdog=" + (watchdogLastAction || "monitoring")
  );
}, 60_000);

client.on("interactionCreate", async interaction => {
  if (interaction.isButton()) {
    if (!interaction.customId.startsWith("serverfind:")) return;

    const state = serverFinderMessageStates.get(interaction.message?.id);
    if (!state) {
      return await interaction.reply({
        content: "⚠️ This Server Finder session expired. Run **/server-find** again.",
        flags: MessageFlags.Ephemeral
      });
    }

    await interaction.deferUpdate();

    if (interaction.customId === "serverfind:prev") {
      state.page = Math.max(0, state.page - 1);
    } else if (interaction.customId === "serverfind:next") {
      const totalPages = Math.max(
        1,
        Math.ceil(state.servers.length / SERVER_FINDER_PAGE_SIZE)
      );
      state.page = Math.min(totalPages - 1, state.page + 1);
    } else if (interaction.customId === "serverfind:refresh") {
      try {
        const publicBaseUrl = String(process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
        const result = await findLowPlayerServers({
          maxPlayers: state.maxPlayers,
          maxResults: SERVER_FINDER_MAX_PAGES * SERVER_FINDER_PAGE_SIZE,
          joinBaseUrl: publicBaseUrl
        });
        state.servers = result.servers;
        state.pagesScanned = result.pagesScanned;
        state.page = Math.min(
          state.page,
          Math.max(0, Math.ceil(state.servers.length / SERVER_FINDER_PAGE_SIZE) - 1)
        );
        state.createdAt = Date.now();
      } catch (error) {
        console.error("Server finder refresh failed:", error);
        return await interaction.editReply({
          content: "❌ **Refresh failed.** Roblox server data could not be fetched right now.",
          embeds: [],
          components: []
        });
      }
    }

    return await interaction.editReply(
      state.buildFinderPayload(state)
    );
  }

  if (!interaction.isChatInputCommand()) return;

  if (
    ADMIN_COMMANDS.has(interaction.commandName) &&
    (
      !interaction.inGuild() ||
      !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)
    )
  ) {
    return await interaction.reply({
      content: "⛔ You need the **Manage Server** permission to use this command.",
      flags: MessageFlags.Ephemeral
    });
  }

  if (
    ADMIN_COMMANDS.has(interaction.commandName) &&
    !consumeAdminCommandRateLimit(interaction.user?.id, interaction.commandName)
  ) {
    return await interaction.reply({
      content: "⏳ Too many admin requests. Please wait a few seconds before trying this command again.",
      flags: MessageFlags.Ephemeral
    });
  }

  try {

    if (interaction.commandName === "spawn-stats") {
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      const recent = spawnHistory.filter(item => {
        const ts = Date.parse(item?.spawnedAt || item?.detectedAt || "");
        return Number.isFinite(ts) && ts >= cutoff;
      });

      const rarityCounts = { secret: 0, eternal: 0, divine: 0 };
      const areaCounts = new Map();
      const eggCounts = new Map();

      for (const item of recent) {
        const rarityKey = normalizeFeedKey(item?.rarity);
        if (Object.prototype.hasOwnProperty.call(rarityCounts, rarityKey)) {
          rarityCounts[rarityKey]++;
        }

        const area = String(item?.area || item?.biome || "Unknown").trim() || "Unknown";
        areaCounts.set(area, (areaCounts.get(area) || 0) + 1);

        const egg = String(item?.eggName || item?.displayName || "Unknown Egg").trim();
        eggCounts.set(egg, (eggCounts.get(egg) || 0) + 1);
      }

      const top = map => [...map.entries()]
        .sort((a,b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 5)
        .map(([name,count]) => name + " (" + count + ")");

      const ops = getOpsSummary();
      return await interaction.reply({
        content: [
          "**📊 Spawn Statistics — Last 24h**",
          "Tracked spawns: **" + recent.length + "**",
          "Secret: **" + rarityCounts.secret + "** • Eternal: **" + rarityCounts.eternal + "** • Divine: **" + rarityCounts.divine + "**",
          "Top areas: " + (top(areaCounts).join(", ") || "N/A"),
          "Top eggs: " + (top(eggCounts).join(", ") || "N/A"),
          "Delivery tracking is active"
        ].join("\n"),
        flags: MessageFlags.Ephemeral
      });
    }


    if (interaction.commandName === "server-find") {
      const userId = String(interaction.user?.id || "");
      const now = Date.now();
      const lastUsed = Number(serverFinderUserCooldowns.get(userId) || 0);

      if (lastUsed && now - lastUsed < SERVER_FINDER_COOLDOWN_MS) {
        const retryAfter = Math.ceil((SERVER_FINDER_COOLDOWN_MS - (now - lastUsed)) / 1000);
        return await interaction.reply({
          content: "⏳ Server Finder is cooling down. Try again in **" + retryAfter + "s**.",
          flags: MessageFlags.Ephemeral
        });
      }

      serverFinderUserCooldowns.set(userId, now);
      for (const [id, timestamp] of serverFinderUserCooldowns) {
        if (now - timestamp > SERVER_FINDER_COOLDOWN_MS * 6) {
          serverFinderUserCooldowns.delete(id);
        }
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const requestedMax = interaction.options.getInteger("max");
      const maxPlayers = Number.isInteger(requestedMax)
        ? Math.min(2, Math.max(0, requestedMax))
        : SERVER_FINDER_MAX_PLAYERS;

      try {
        const publicBaseUrl = String(process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
        const result = await findLowPlayerServers({
          maxPlayers,
          maxResults: SERVER_FINDER_MAX_PAGES * SERVER_FINDER_PAGE_SIZE,
          joinBaseUrl: publicBaseUrl
        });

        const totalPages = Math.max(
          1,
          Math.ceil(result.servers.length / SERVER_FINDER_PAGE_SIZE)
        );

        const state = {
          servers: result.servers,
          maxPlayers,
          page: 0,
          pagesScanned: result.pagesScanned,
          createdAt: now
        };

        for (const [messageId, saved] of serverFinderMessageStates) {
          if (now - saved.createdAt > 10 * 60_000) {
            serverFinderMessageStates.delete(messageId);
          }
        }

        const buildFinderPayload = currentState => {
          const currentPage = Math.min(
            Math.max(0, currentState.page),
            Math.max(0, Math.ceil(currentState.servers.length / SERVER_FINDER_PAGE_SIZE) - 1)
          );
          currentState.page = currentPage;

          const total = currentState.servers.length;
          const pages = Math.max(1, Math.ceil(total / SERVER_FINDER_PAGE_SIZE));
          const pageServers = currentState.servers.slice(
            currentPage * SERVER_FINDER_PAGE_SIZE,
            (currentPage + 1) * SERVER_FINDER_PAGE_SIZE
          );

          const embed = new EmbedBuilder()
            .setColor(0x5865f2)
            .setTitle("🥚  Steal An Egg • Server Finder")
            .setDescription([
              "🔎 **Low-population public servers** for quick server hopping.",
              "",
              "👥 Showing **0–" + currentState.maxPlayers + " players**",
              "📄 Page **" + (currentPage + 1) + " / " + pages + "** • " + total + " servers found",
              "🛰️ Scanned **" + currentState.pagesScanned + "** Roblox server pages"
            ].join("\n"))
            .setFooter({
              text: "Player counts are live snapshots • Steal An Egg"
            })
            .setTimestamp();

          for (let i = 0; i < pageServers.length; i++) {
            const server = pageServers[i];
            const number = currentPage * SERVER_FINDER_PAGE_SIZE + i + 1;
            const playerIcon = server.playing === 0 ? "🟢" : "🟡";

            embed.addFields({
              name: playerIcon + "  #" + number + " • " + server.playing + "/" + server.maxPlayers + " players",
              value:
                "🆔 Server: `" + server.jobId.slice(0, 10) + "…`\n" +
                "🔗 [**Join this server**](" + server.joinUrl + ")",
              inline: true
            });
          }

          const controls = new ActionRowBuilder()
            .addComponents(
              new ButtonBuilder()
                .setCustomId("serverfind:prev")
                .setLabel("Back")
                .setEmoji("◀️")
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(currentPage === 0),
              new ButtonBuilder()
                .setCustomId("serverfind:refresh")
                .setLabel("Refresh")
                .setEmoji("🔄")
                .setStyle(ButtonStyle.Primary),
              new ButtonBuilder()
                .setCustomId("serverfind:next")
                .setLabel("Next")
                .setEmoji("▶️")
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(currentPage >= pages - 1)
            );

          return {
            embeds: [embed],
            components: [controls]
          };
        };

        const payload = buildFinderPayload(state);
        const message = await interaction.editReply(payload);
        serverFinderMessageStates.set(message.id, {
          ...state,
          buildFinderPayload
        });

        return;
      } catch (error) {
        console.error("Server finder command failed:", error);
        return await interaction.editReply({
          content: "❌ **Server Finder is temporarily unavailable.** Roblox server data could not be fetched right now.",
          embeds: [],
          components: []
        });
      }
    }

    if (interaction.commandName === "alerts-pause") {
      alertsPaused = true;
      saveRuntimeState();
      return await interaction.reply({
        content: "⏸️ Rare-egg public alerts are now **paused**. Detection and Last Seen continue normally.",
        flags: MessageFlags.Ephemeral
      });
    }

    if (interaction.commandName === "alerts-resume") {
      alertsPaused = false;
      saveRuntimeState();
      return await interaction.reply({
        content: "▶️ Rare-egg public alerts are now **resumed**.",
        flags: MessageFlags.Ephemeral
      });
    }

    if (interaction.commandName === "bot-status") {
      const uptimeSeconds = Math.floor(process.uptime());
      const days = Math.floor(uptimeSeconds / 86400);
      const hours = Math.floor((uptimeSeconds % 86400) / 3600);
      const minutes = Math.floor((uptimeSeconds % 3600) / 60);
      const activeFeed = [...liveFeedEndpointHealth.values()]
        .filter(item => item.status === "ACTIVE").length;
      const discoveryActive = [...autoDiscoverySourceHealth.values()]
        .filter(item => item.status === "ACTIVE").length;
      const sources = [...liveFeedEndpointHealth.values()]
        .map(item => item.endpoint + ":" + item.status)
        .join(" • ") || "none";

      const status = [
        "🤖 **Bot:** " + (client.isReady() ? "🟢 Online" : "🔴 Offline"),
        "🌐 **Live Feed:** " + liveFeedHealth() + " • " + activeFeed + "/" + LIVE_FEED_URLS.length,
        "🔌 **Sources:** " + sources,
        "🥚 **Alerts:** " + alertCount + " • queue " + alertQueueDepth() + "/" + ALERT_QUEUE_MAX,
        "🕒 **Last Seen:** " +
          (LAST_SEEN_CHANNEL_ID
            ? (lastSeenMessagesReady ? "🟢 Ready" : "🟡 Starting")
            : "⚪ Off"),
        "🔎 **Discovery:** " +
          (AUTO_DISCOVERY_ENABLED
            ? discoveryActive + "/" + AUTO_DISCOVERY_SOURCES.length + " active"
            : "⚪ Off"),
        "🖼️ **PNG cache:** " + petPngBufferCache.size,
        "💾 **State:** " + STATE_PERSISTENCE_MODE +
          (DURABLE_VOLUME_CONFIGURED ? " • durable" : " • no volume detected"),
        "🔧 **Watchdog:** " + (watchdogLastAction || "monitoring") +
          " • recoveries " + watchdogRecoveryCount,
        "🛡️ **Discord guard:** " + discordCircuit.state +
          " • failures " + discordCircuit.failures,
        "📦 **Queues:** live " + alertQueueDepth("live") +
          " • source " + alertQueueDepth("source") +
          " • API " + alertQueueDepth("api"),
        "🩺 **Self-check:** " + (lastDailySelfCheckResult?.ok ? "🟢 Healthy" : lastDailySelfCheckAt ? "🟠 Issues found" : "🟡 Pending"),
        "🛡️ **Errors:** " + monitorErrors,
        "⏱️ **Uptime:** " + days + "d " + hours + "h " + minutes + "m"
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
        getEggAlertEmoji(item) +
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
    if (interaction.commandName === "find") {
      const requested = interaction.options.getString("egg", true);
      const wanted = normalizeFeedKey(requested);

      const matches = [];
      for (const rarity of LAST_SEEN_RARITIES) {
        const record = lastSeenByRarity[rarity].get(eggIdentityKey(wanted));
        if (record) {
          matches.push({ rarity, ...record });
          continue;
        }

        for (const item of lastSeenByRarity[rarity].values()) {
          const names = [
            item?.eggName,
            item?.petName,
            item?.eggName ? item.eggName + " Egg" : ""
          ].filter(Boolean);

          if (names.some(name =>
            eggIdentityKey(name) === eggIdentityKey(wanted) ||
            normalizeFeedKey(name) === wanted
          )) {
            matches.push({ rarity, ...item });
            break;
          }
        }
      }

      if (!matches.length) {
        const entry = findCatalogEgg(requested) || findCatalogPet(requested);
        return await interaction.reply({
          content: entry
            ? "📭 **" + (entry.petName || entry.eggName) + "** has not been seen yet."
            : "❌ I couldn't find that egg in the tracked catalog.",
          flags: MessageFlags.Ephemeral
        });
      }

      matches.sort((a, b) =>
        Date.parse(b.spawnedAt || b.detectedAt || 0) -
        Date.parse(a.spawnedAt || a.detectedAt || 0)
      );

      const latest = matches[0];
      const ts = Date.parse(latest.spawnedAt || latest.detectedAt || "");
      const when = Number.isFinite(ts)
        ? "<t:" + Math.floor(ts / 1000) + ":R>"
        : "Unknown";

      return await interaction.reply({
        content: [
          getEggAlertEmoji(latest),
          " **" + (latest.petName || latest.eggName) + "**",
          "",
          "Rarity: **" + String(latest.rarity || "").replace(/^./, c => c.toUpperCase()) + "**",
          "Location: **" + String(latest.area || "Unknown") + "**",
          "Last seen: " + when
        ].join("\n"),
        flags: MessageFlags.Ephemeral
      });
    }


    if (interaction.commandName === "bot-reload") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      seen.clear();
      alertedMessageIds.clear();
      inFlightKeys.clear();
      alertChannel = null;
      lastSeenMessagesReady = false;
      lastSeenMessageCache.clear();
      lastSeenContentFingerprints.clear();
      lastSeenMessagesInitInFlight = null;
      petPageCache.clear();
      petPngBufferCache.clear();
      imageFallbackCache.clear();
      resolvedRoleCache.clear();
      eventRoleCache.clear();

      if (CHANNEL_ID) {
        await getAlertChannel();
        await ensureAlertRoles();
        await validateAlertRoles();
      }

      if (CHANNEL_ID || LAST_SEEN_CHANNEL_ID) {
        await ensureEggCustomEmojis();
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

      const sent = await sendAlert(testEvent);

      alertCount = beforeAlerts;
      lastSpawnAt = beforeLastSpawn;
      if (recentSpawns.length > beforeRecentLength) {
        recentSpawns.splice(beforeRecentLength);
      }

      if (!sent) {
        return await interaction.editReply({
          content:
            "⚠️ No test alert was sent because **" +
            entry.petName +
            "** is not eligible for the normal live-spawn alert pipeline."
        });
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

setInterval(() => {
  runWeeklyReliabilityReport().catch(error => {
    recordMonitorError("discord", error, "Weekly reliability report scheduler failed");
  });
}, 6 * 60 * 60 * 1000);

setTimeout(() => {
  runWeeklyReliabilityReport().catch(error => {
    recordMonitorError("discord", error, "Initial weekly reliability report check failed");
  });
}, 30_000);

client.on("shardReconnecting", shardId => {
  alertChannel = null;
  lastSeenMessagesReady = false;
  lastSeenMessageCache.clear();
  lastSeenContentFingerprints.clear();
  lastSeenMessagesInitInFlight = null;
  resolvedRoleCache.clear();
  eventRoleCache.clear();
  console.warn("Discord shard reconnecting:", shardId);
});

client.on("shardReady", shardId => {
  console.log("Discord shard ready:", shardId);

  if (ALERT_PIPELINE_SELF_TEST_ONCE && !alertPipelineSelfTestRunThisProcess) {
    setTimeout(() => {
      runAlertPipelineSelfTest().catch(error => {
        console.error("Alert pipeline self-test scheduling failed:", error);
      });
    }, 2500);
  }
});

client.on("shardDisconnect", (event, shardId) => {
  alertChannel = null;
  lastSeenMessagesReady = false;
  lastSeenMessageCache.clear();
  lastSeenContentFingerprints.clear();
  lastSeenMessagesInitInFlight = null;
  resolvedRoleCache.clear();
  eventRoleCache.clear();
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

  if (experimentScheduleTimer) {
    clearTimeout(experimentScheduleTimer);
    clearInterval(experimentScheduleTimer);
    experimentScheduleTimer = null;
  }

  if (dailySelfCheckTimer) {
    clearTimeout(dailySelfCheckTimer);
    clearInterval(dailySelfCheckTimer);
    dailySelfCheckTimer = null;
  }

  client.destroy();
  process.exit(0);
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));

await hydrateRuntimeStateFile();
loadRuntimeState();

if (!process.env.DISCORD_BOT_TOKEN) {
  console.error("DISCORD_BOT_TOKEN is missing.");
} else {
  client.login(process.env.DISCORD_BOT_TOKEN).catch(error => {
    console.error("Discord login failed:", error);
    saveRuntimeState();
    process.exit(1);
  });
}

app.listen(PORT, () => console.log("HTTP server listening on " + PORT));