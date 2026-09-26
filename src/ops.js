const MAX_LATENCY_SAMPLES = 1000;
const MAX_LIFECYCLE_ENTRIES = 500;
const MAX_DEAD_LETTER_ENTRIES = 100;

const latencySamples = [];
const lifecycleCounts = new Map();
const lifecycleRecent = [];
const deadLetterAlerts = [];
const sourceConflictRecent = [];

let weeklyReportLastAt = null;

function safeDateMs(value) {
  if (value == null) return NaN;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : Number(value);
}

function normalize(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function recordLatency(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms < 0 || ms > 24 * 60 * 60 * 1000) return;
  latencySamples.push(ms);
  if (latencySamples.length > MAX_LATENCY_SAMPLES) latencySamples.shift();
}

export function percentile(values, percentileValue) {
  const sorted = (Array.isArray(values) ? values : [])
    .map(Number)
    .filter(value => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);
  if (!sorted.length) return null;
  const p = Math.min(100, Math.max(0, Number(percentileValue)));
  const index = (sorted.length - 1) * (p / 100);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return Math.round(sorted[lower]);
  return Math.round(
    sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower)
  );
}

export function recordLifecycle(eventOrId, state, details = {}) {
  const event = eventOrId && typeof eventOrId === "object" ? eventOrId : {};
  const incidentId = String(
    event.incidentId || (typeof eventOrId === "string" ? eventOrId : "") || "unknown"
  ).slice(0, 120);
  const normalizedState = String(state || "UNKNOWN").toUpperCase().slice(0, 40);
  lifecycleCounts.set(
    normalizedState,
    (lifecycleCounts.get(normalizedState) || 0) + 1
  );
  lifecycleRecent.unshift({
    incidentId,
    state: normalizedState,
    at: new Date().toISOString(),
    source: String(event.source || "unknown").slice(0, 80),
    rarity: String(event.rarity || "").slice(0, 40),
    eggName: String(event.eggName || event.displayName || "").slice(0, 100),
    detail: String(details?.detail || "").slice(0, 200)
  });
  if (lifecycleRecent.length > MAX_LIFECYCLE_ENTRIES) {
    lifecycleRecent.length = MAX_LIFECYCLE_ENTRIES;
  }
}

export function addDeadLetterAlert(event, error, attempts = 0) {
  const item = {
    incidentId: event?.incidentId || null,
    sourceEventId: event?.sourceEventId || null,
    source: event?.source || "unknown",
    rarity: event?.rarity || "Unknown",
    eggName: event?.eggName || event?.displayName || "Unknown Egg",
    area: event?.biome || "Unknown",
    occurredAt: event?.spawnedAt || event?.occurredAt || event?.date || null,
    failedAt: new Date().toISOString(),
    attempts: Number(attempts || 0),
    error: String(error?.message || error || "unknown_error").slice(0, 500)
  };
  deadLetterAlerts.unshift(item);
  if (deadLetterAlerts.length > MAX_DEAD_LETTER_ENTRIES) {
    deadLetterAlerts.length = MAX_DEAD_LETTER_ENTRIES;
  }
  recordLifecycle(event, "DEAD_LETTER", { detail: item.error });
  return item;
}

export function restoreOpsState(raw = {}) {
  latencySamples.length = 0;
  for (const value of Array.isArray(raw?.latencySamples) ? raw.latencySamples : []) {
    const ms = Number(value);
    if (Number.isFinite(ms) && ms >= 0 && ms <= 24 * 60 * 60 * 1000) latencySamples.push(ms);
  }
  latencySamples.splice(0, Math.max(0, latencySamples.length - MAX_LATENCY_SAMPLES));

  lifecycleCounts.clear();
  for (const [key, value] of Object.entries(raw?.lifecycleCounts || {})) {
    const count = Number(value);
    if (Number.isFinite(count) && count > 0) lifecycleCounts.set(String(key), count);
  }

  lifecycleRecent.length = 0;
  lifecycleRecent.push(
    ...(Array.isArray(raw?.lifecycleRecent) ? raw.lifecycleRecent.slice(0, MAX_LIFECYCLE_ENTRIES) : [])
  );

  deadLetterAlerts.length = 0;
  deadLetterAlerts.push(
    ...(Array.isArray(raw?.deadLetterAlerts) ? raw.deadLetterAlerts.slice(0, MAX_DEAD_LETTER_ENTRIES) : [])
  );

  sourceConflictRecent.length = 0;
  sourceConflictRecent.push(
    ...(Array.isArray(raw?.sourceConflictRecent) ? raw.sourceConflictRecent.slice(0, 100) : [])
  );

  weeklyReportLastAt = raw?.weeklyReportLastAt || null;
}

export function snapshotOpsState() {
  return {
    version: 1,
    latencySamples: latencySamples.slice(-MAX_LATENCY_SAMPLES),
    lifecycleCounts: Object.fromEntries(lifecycleCounts),
    lifecycleRecent: lifecycleRecent.slice(0, MAX_LIFECYCLE_ENTRIES),
    deadLetterAlerts: deadLetterAlerts.slice(0, MAX_DEAD_LETTER_ENTRIES),
    sourceConflictRecent: sourceConflictRecent.slice(0, 100),
    weeklyReportLastAt
  };
}

export function getOpsSummary({ now = Date.now() } = {}) {
  const recentLatency = latencySamples.slice(-MAX_LATENCY_SAMPLES);
  const sent = lifecycleCounts.get("SENT") || 0;
  const failed = lifecycleCounts.get("FAILED") || 0;
  const suppressed = lifecycleCounts.get("SUPPRESSED") || 0;
  const deadLetters = deadLetterAlerts.length;

  return {
    latency: {
      samples: recentLatency.length,
      p50Ms: percentile(recentLatency, 50),
      p95Ms: percentile(recentLatency, 95),
      p99Ms: percentile(recentLatency, 99),
      averageMs: recentLatency.length
        ? Math.round(recentLatency.reduce((a, b) => a + b, 0) / recentLatency.length)
        : null
    },
    lifecycle: {
      detected: lifecycleCounts.get("DETECTED") || 0,
      verified: lifecycleCounts.get("VERIFIED") || 0,
      queued: lifecycleCounts.get("QUEUED") || 0,
      sending: lifecycleCounts.get("SENDING") || 0,
      sent,
      failed,
      suppressed,
      deadLetter: deadLetters
    },
    reliability: {
      deliverySuccessRate:
        sent + failed > 0 ? Number((sent / (sent + failed) * 100).toFixed(2)) : null,
      suppressionRate:
        sent + suppressed > 0 ? Number((suppressed / (sent + suppressed) * 100).toFixed(2)) : null
    },
    deadLetter: {
      count: deadLetters,
      latest: deadLetterAlerts[0] || null
    },
    sourceConflicts: sourceConflictRecent.slice(0, 20),
    weeklyReportLastAt,
    generatedAt: new Date(now).toISOString()
  };
}

export function noteSourceObservation(event = {}) {
  const timestamp = safeDateMs(
    event.spawnedAt || event.occurredAt || event.appearedAt || event.createdTimestamp || event.date
  );
  if (!Number.isFinite(timestamp)) return null;

  const bucket = Math.floor(timestamp / 20_000);
  const rarity = normalize(event.rarity);
  const source = normalize(event.source || event.sourceName || "unknown");
  const egg = normalize(event.eggName || event.displayName);
  const area = normalize(event.biome || event.area || "unknown");
  const key = rarity + "|" + bucket;

  const recent = sourceConflictRecent.filter(item =>
    Date.now() - Number(item.at || 0) < 120_000
  );

  let conflict = null;
  for (const item of recent) {
    if (item.key !== key || item.source === source) continue;
    if (item.egg !== egg || item.area !== area) {
      conflict = {
        key,
        at: Date.now(),
        sources: [item.source, source],
        first: { egg: item.egg, area: item.area },
        second: { egg, area },
        rarity
      };
      break;
    }
  }

  sourceConflictRecent.length = 0;
  sourceConflictRecent.push(...recent.slice(0, 99));
  sourceConflictRecent.unshift({
    key,
    at: Date.now(),
    source,
    egg,
    area
  });
  sourceConflictRecent.splice(100);

  return conflict;
}

export function shouldRunWeeklyReport({ now = Date.now(), intervalMs = 7 * 24 * 60 * 60_000 } = {}) {
  if (!weeklyReportLastAt) return true;
  const previous = safeDateMs(weeklyReportLastAt);
  return !Number.isFinite(previous) || Number(now) - previous >= intervalMs;
}

export function markWeeklyReportSent(at = new Date().toISOString()) {
  weeklyReportLastAt = at;
}

export function buildWeeklyReportText(summary = getOpsSummary()) {
  const latency = summary.latency || {};
  const life = summary.lifecycle || {};
  const rel = summary.reliability || {};
  const dead = summary.deadLetter || {};

  return [
    "**📊 Steal An Egg Weekly Reliability Report**",
    "• Alerts sent: **" + (life.sent || 0) + "**",
    "• Suppressed: **" + (life.suppressed || 0) + "**",
    "• Failed: **" + (life.failed || 0) + "**",
    "• Dead-lettered: **" + (dead.count || 0) + "**",
    "• Delivery success: **" + (rel.deliverySuccessRate == null ? "N/A" : rel.deliverySuccessRate + "%") + "**",
    "• Latency P50: **" + (latency.p50Ms == null ? "N/A" : latency.p50Ms + "ms") + "**",
    "• Latency P95: **" + (latency.p95Ms == null ? "N/A" : latency.p95Ms + "ms") + "**",
    "• Last report: **" + (summary.weeklyReportLastAt || "First report") + "**"
  ].join("\n");
}
