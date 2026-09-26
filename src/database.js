import fs from "node:fs";
import path from "node:path";

const ENABLED =
  (process.env.SUPABASE_PERSISTENCE_ENABLED || "false").toLowerCase() === "true";
const STORAGE_URL = String(process.env.TRACKER_STORAGE_URL || "").trim();
const STORAGE_SECRET = String(process.env.TRACKER_STORAGE_SECRET || "").trim();
const STATE_FILE = path.resolve(
  process.env.RUNTIME_STATE_FILE || path.join(process.cwd(), "data/runtime-state.json")
);

const REQUEST_TIMEOUT_MS =
  Math.max(1500, Number(process.env.TRACKER_STORAGE_TIMEOUT_MS || 5000));

const MAX_RETRIES =
  Math.max(0, Math.min(4, Number(process.env.TRACKER_STORAGE_RETRIES || 2)));

let consecutiveFailures = 0;
let lastSuccessAt = null;
let lastFailureAt = null;
let lastError = null;
let totalCalls = 0;
let successfulCalls = 0;
let failedCalls = 0;
let circuitOpenUntil = 0;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
\nfunction mergeStructuredRowsIntoState(state, result) {
  const next = state && typeof state === "object" ? state : {};

  const existingSpawnKeys = new Set(
    Array.isArray(next.spawnHistory)
      ? next.spawnHistory.map(item => [
          item?.source || "",
          item?.sourceEventId || item?.id || "",
          item?.spawnedAt || ""
        ].join("|"))
      : []
  );

  const existingEventKeys = new Set(
    Array.isArray(next.gameEventHistory)
      ? next.gameEventHistory.map(item => [
          item?.source || "",
          item?.sourceEventId || item?.id || "",
          item?.title || "",
          item?.date || item?.occurredAt || ""
        ].join("|"))
      : []
  );

  const existingRiftKeys = new Set(
    Array.isArray(next.riftHistory)
      ? next.riftHistory.map(item => [
          item?.source || "",
          item?.sourceEventId || item?.id || "",
          item?.type || "",
          item?.bannerKey || item?.bossName || "",
          item?.createdTimestamp || ""
        ].join("|"))
      : []
  );

  for (const row of Array.isArray(result?.events) ? result.events : []) {
    const raw = row?.raw_payload && typeof row.raw_payload === "object"
      ? row.raw_payload
      : {};

    if (row?.event_type === "egg_spawn") {
      const record = {
        ...raw,
        id: raw.id || row.id || null,
        source: raw.source || row.source || "unknown",
        sourceEventId: raw.sourceEventId || row.source_event_id || row.id || null,
        rarity: raw.rarity || row.rarity || "Unknown",
        eggName: raw.eggName || row.egg_name || "Unknown Egg",
        petName: raw.petName || row.title || row.egg_name || "Unknown",
        area: raw.area || row.area || "Unknown",
        spawnedAt: raw.spawnedAt || row.occurred_at || row.created_at || new Date().toISOString(),
        detectedAt: raw.detectedAt || row.first_seen_at || row.created_at || new Date().toISOString(),
        confidence: raw.confidence ?? row.confidence ?? null,
        incidentId: raw.incidentId || row.incident_id || null,
        eventState: raw.eventState || row.event_state || null
      };

      const key = [
        record.source,
        record.sourceEventId || record.id || "",
        record.spawnedAt || ""
      ].join("|");

      if (!existingSpawnKeys.has(key)) {
        next.spawnHistory = [record, ...(Array.isArray(next.spawnHistory) ? next.spawnHistory : [])];
        existingSpawnKeys.add(key);
      }
      continue;
    }

    if (String(row?.event_type || "").startsWith("rift_")) {
      const record = {
        ...raw,
        id: raw.id || row.id || null,
        source: raw.source || row.source || "unknown",
        sourceEventId: raw.sourceEventId || row.source_event_id || row.id || null,
        type: raw.type || String(row.event_type).replace(/^rift_/, ""),
        bannerKey: raw.bannerKey || null,
        bannerName: raw.bannerName || row.title || null,
        bossName: raw.bossName || row.title || null,
        rotationChance: raw.rotationChance || null,
        changedLabel: raw.changedLabel || row.description || null,
        nextChangeLabel: raw.nextChangeLabel || null,
        createdTimestamp: Number(raw.createdTimestamp || Date.parse(row.occurred_at) || Date.now()),
        confidence: raw.confidence ?? row.confidence ?? null,
        incidentId: raw.incidentId || row.incident_id || null,
        eventState: raw.eventState || row.event_state || null
      };
      const key = [
        record.source,
        record.sourceEventId || record.id || "",
        record.type,
        record.bannerKey || record.bossName || "",
        record.createdTimestamp
      ].join("|");

      if (!existingRiftKeys.has(key)) {
        next.riftHistory = [record, ...(Array.isArray(next.riftHistory) ? next.riftHistory : [])];
        existingRiftKeys.add(key);
      }
      continue;
    }

    const record = {
      ...raw,
      id: raw.id || row.id || null,
      source: raw.source || row.source || "Auto Discovery",
      sourceEventId: raw.sourceEventId || row.source_event_id || row.id || null,
      type: raw.type || row.event_type || "event",
      title: raw.title || row.title || "Game Event",
      description: raw.description || row.description || "",
      date: raw.date || row.occurred_at || row.created_at || null,
      confidence: raw.confidence ?? row.confidence ?? null,
      incidentId: raw.incidentId || row.incident_id || null,
      eventState: raw.eventState || row.event_state || null,
      evidence: Array.isArray(raw.evidence) ? raw.evidence : (Array.isArray(row.evidence) ? row.evidence : [])
    };

    const key = [
      record.source,
      record.sourceEventId || record.id || "",
      record.title,
      record.date || ""
    ].join("|");

    if (!existingEventKeys.has(key)) {
      next.gameEventHistory = [record, ...(Array.isArray(next.gameEventHistory) ? next.gameEventHistory : [])];
      existingEventKeys.add(key);
    }
  }

  next.spawnHistory = (Array.isArray(next.spawnHistory) ? next.spawnHistory : []).slice(0, 100);
  next.gameEventHistory = (Array.isArray(next.gameEventHistory) ? next.gameEventHistory : []).slice(0, 30);
  next.riftHistory = (Array.isArray(next.riftHistory) ? next.riftHistory : []).slice(0, 30);

  const currentLastSeen = next.lastSeenByRarity && typeof next.lastSeenByRarity === "object"
    ? next.lastSeenByRarity
    : {};

  for (const row of Array.isArray(result?.lastSeen) ? result.lastSeen : []) {
    const rarity = String(row?.rarity || "").toLowerCase();
    if (!["secret", "eternal", "divine"].includes(rarity)) continue;
    currentLastSeen[rarity] = currentLastSeen[rarity] || {};

    const raw = row?.raw_payload && typeof row.raw_payload === "object"
      ? row.raw_payload
      : {};

    currentLastSeen[rarity][String(row.identity_key || raw.identityKey || row.egg_name || "").toLowerCase()] = {
      eggName: row.egg_name || raw.eggName || "Unknown Egg",
      petName: raw.petName || row.egg_name || "Unknown",
      area: row.area || raw.area || "Unknown",
      spawnedAt: raw.spawnedAt || row.last_seen_at || row.first_seen_at || new Date().toISOString(),
      detectedAt: raw.detectedAt || row.first_seen_at || row.last_seen_at || new Date().toISOString()
    };
  }
  next.lastSeenByRarity = currentLastSeen;

  const existingCatalog = Array.isArray(next.dynamicEggs) ? next.dynamicEggs : [];
  const seenCatalog = new Set(existingCatalog.map(item => String(item?.eggName || "").toLowerCase()));
  for (const row of Array.isArray(result?.catalog) ? result.catalog : []) {
    if (row?.source !== "Auto Discovery" || !row?.egg_name || seenCatalog.has(String(row.egg_name).toLowerCase())) continue;
    existingCatalog.push({
      eggName: row.egg_name,
      displayName: row.display_name || row.egg_name,
      petName: row.pet_name || String(row.egg_name).replace(/\s+Egg$/i, ""),
      rarity: row.rarity,
      biome: row.biome || "Unknown",
      aliases: Array.isArray(row.aliases) ? row.aliases : [],
      active: row.active !== false,
      source: row.source,
      sourcePage: row.source_page || null,
      discoveredAt: row.discovered_at || null
    });
    seenCatalog.add(String(row.egg_name).toLowerCase());
  }
  next.dynamicEggs = existingCatalog.slice(0, 50);

  return next;
}


export function persistenceEnabled() {
  return ENABLED && Boolean(STORAGE_URL && STORAGE_SECRET);
}

export function persistenceStats() {
  return {
    enabled: persistenceEnabled(),
    endpointConfigured: Boolean(STORAGE_URL),
    consecutiveFailures,
    totalCalls,
    successfulCalls,
    failedCalls,
    lastSuccessAt,
    lastFailureAt,
    lastError,
    circuitOpen: Date.now() < circuitOpenUntil
  };
}

async function callStorage(action, payload = {}) {
  if (!persistenceEnabled()) return null;

  const now = Date.now();
  if (now < circuitOpenUntil) {
    throw new Error("tracker_storage_circuit_open");
  }

  totalCalls++;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(STORAGE_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-tracker-secret": STORAGE_SECRET
        },
        body: JSON.stringify({ action, ...payload }),
        signal: controller.signal
      });

      const text = await response.text();
      if (!response.ok) {
        throw new Error(
          "Tracker storage " + response.status + ": " + text.slice(0, 300)
        );
      }

      const result = text ? JSON.parse(text) : null;
      consecutiveFailures = 0;
      successfulCalls++;
      lastSuccessAt = new Date().toISOString();
      lastError = null;
      circuitOpenUntil = 0;
      return result;
    } catch (error) {
      lastError = error?.message || String(error);
      lastFailureAt = new Date().toISOString();

      if (attempt >= MAX_RETRIES) {
        consecutiveFailures++;
        failedCalls++;

        if (consecutiveFailures >= 3) {
          circuitOpenUntil = Date.now() + 30_000;
        }

        throw error;
      }

      await sleep(250 * (2 ** attempt));
    } finally {
      clearTimeout(timer);
    }
  }

  return null;
}

export async function persistRuntimeState(state) {
  return callStorage("snapshot", { state });
}

export async function persistSpawnRecord(record) {
  return callStorage("spawn", {
    record: {
      ...record,
      identityKey:
        record?.identityKey ||
        [record?.rarity, record?.eggName].map(value =>
          String(value || "").trim().toLowerCase()
        ).join("|")
    }
  });
}

export async function persistGameEvent(event) {
  return callStorage("game_event", { event });
}

export async function persistRiftEvent(event) {
  return callStorage("rift", { event });
}

export async function persistCatalog(items) {
  return callStorage("catalog", {
    items: Array.isArray(items) ? items.slice(0, 300) : []
  });
}

export async function persistAlertDelivery(deliveries) {
  return callStorage("alert_delivery", {
    deliveries: Array.isArray(deliveries) ? deliveries : [deliveries]
  });
}

export async function persistSourceHealth(source) {
  return callStorage("health", {
    key: source?.key || "unknown",
    url: source?.url || null,
    status: source?.status || "unknown",
    lastSuccessAt: source?.lastSuccessAt || null,
    lastEventAt: source?.lastEventAt || null,
    lastErrorAt: source?.lastErrorAt || null,
    latencyMs: source?.latencyMs ?? null,
    consecutiveFailures: source?.consecutiveFailures || 0,
    value: source || {}
  });
}

export async function cleanupStorage(retentionDays = 30) {
  const days = Math.max(7, Math.min(3650, Number(retentionDays || 30)));
  return callStorage("cleanup", { retentionDays: days });
}

export async function hydrateRuntimeStateFile() {
  if (!persistenceEnabled()) return false;

  try {
    const result = await callStorage("load");
    const state = mergeStructuredRowsIntoState(result?.state || {}, result);

    if (!state || typeof state !== "object") {
      return false;
    }

    const stateDir = path.dirname(STATE_FILE);
    fs.mkdirSync(stateDir, { recursive: true });

    const tempFile = STATE_FILE + ".remote.tmp";
    fs.writeFileSync(tempFile, JSON.stringify(state), "utf8");
    fs.renameSync(tempFile, STATE_FILE);

    console.log(
      "Supabase runtime state restored:",
      "events=" + (Array.isArray(result?.events) ? result.events.length : 0),
      "lastSeen=" + (Array.isArray(result?.lastSeen) ? result.lastSeen.length : 0),
      "catalog=" + (Array.isArray(result?.catalog) ? result.catalog.length : 0)
    );

    return true;
  } catch (error) {
    console.warn("Supabase runtime state restore skipped:", error?.message || error);
    return false;
  }
}
