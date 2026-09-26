import fs from "node:fs";
import path from "node:path";

const ENABLED =
  (process.env.SUPABASE_PERSISTENCE_ENABLED || "false").toLowerCase() === "true";
const STORAGE_URL = String(process.env.TRACKER_STORAGE_URL || "").trim();
const STORAGE_SECRET = String(process.env.TRACKER_STORAGE_SECRET || "").trim();
const STATE_FILE = path.resolve(
  process.env.RUNTIME_STATE_FILE || path.join(process.cwd(), "data/runtime-state.json")
);

export function persistenceEnabled() {
  return ENABLED && Boolean(STORAGE_URL && STORAGE_SECRET);
}

async function callStorage(action, payload = {}) {
  if (!persistenceEnabled()) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);

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
      throw new Error("Tracker storage " + response.status + ": " + text.slice(0, 300));
    }

    return text ? JSON.parse(text) : null;
  } finally {
    clearTimeout(timer);
  }
}

export async function persistRuntimeState(state) {
  return callStorage("snapshot", { state });
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

    console.log("Supabase runtime state restored.");
    return true;
  } catch (error) {
    console.warn("Supabase runtime state restore skipped:", error?.message || error);
    return false;
  }
}
