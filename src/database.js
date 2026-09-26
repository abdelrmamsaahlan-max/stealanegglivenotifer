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
    const state = result?.state;

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
