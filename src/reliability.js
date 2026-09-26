import crypto from "node:crypto";

const SOURCE_BASE_CONFIDENCE = {
  "Live Feed": 0.90,
  "Signed API": 0.88,
  "Discord Source": 0.84,
  "Auto Discovery": 0.74,
  "Manual Test": 1,
  "Test": 1
};

const MAX_EVIDENCE = 8;

export function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

export function createIncidentId(prefix = "SAE") {
  const stamp = new Date().toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14);
  const suffix = crypto.randomBytes(3).toString("hex").toUpperCase();
  return prefix + "-" + stamp + "-" + suffix;
}

export function eventFingerprint(event = {}) {
  return [
    String(event.source || "unknown").trim().toLowerCase(),
    String(event.rarity || event.type || "event").trim().toLowerCase(),
    String(event.eggName || event.bannerKey || event.bossName || event.title || "").trim().toLowerCase(),
    String(event.biome || event.area || "unknown").trim().toLowerCase(),
    String(event.sourceEventId || "").trim()
  ].join("|");
}

export function addEvidence(existing = [], evidence = {}) {
  const normalized = {
    source: String(evidence.source || "unknown").slice(0, 120),
    sourceKey: String(evidence.sourceKey || evidence.source || "unknown").slice(0, 120),
    sourceEventId: evidence.sourceEventId ? String(evidence.sourceEventId).slice(0, 200) : null,
    observedAt: evidence.observedAt || new Date().toISOString(),
    parser: String(evidence.parser || "unknown").slice(0, 80)
  };

  const map = new Map();
  for (const item of Array.isArray(existing) ? existing : []) {
    const key = [
      item?.sourceKey || item?.source || "unknown",
      item?.sourceEventId || "",
      item?.parser || ""
    ].join("|");
    map.set(key, item);
  }

  const key = [
    normalized.sourceKey,
    normalized.sourceEventId || "",
    normalized.parser
  ].join("|");
  map.set(key, normalized);

  return [...map.values()]
    .sort((a, b) => Date.parse(b.observedAt || 0) - Date.parse(a.observedAt || 0))
    .slice(0, MAX_EVIDENCE);
}

export function calculateEventConfidence({
  source = "unknown",
  sourceRank = 0,
  parserConfidence = 0.75,
  evidence = [],
  occurredAt = null,
  now = Date.now()
} = {}) {
  const base = SOURCE_BASE_CONFIDENCE[source] ??
    clamp(0.60 + Math.min(10, Math.max(0, Number(sourceRank || 0))) * 0.03, 0, 0.90);

  const rankBonus = Math.min(0.08, Math.max(0, Number(sourceRank || 0)) * 0.008);
  const parserBonus = (clamp(parserConfidence) - 0.75) * 0.20;
  const distinctSources = new Set(
    (Array.isArray(evidence) ? evidence : [])
      .map(item => item?.sourceKey || item?.source)
      .filter(Boolean)
  ).size;
  const corroboration = Math.min(0.14, Math.max(0, distinctSources - 1) * 0.07);

  let freshness = 0;
  const ts = occurredAt ? new Date(occurredAt).getTime() : NaN;
  if (Number.isFinite(ts)) {
    const ageMs = Math.abs(Number(now) - ts);
    if (ageMs <= 15_000) freshness = 0.06;
    else if (ageMs <= 60_000) freshness = 0.04;
    else if (ageMs <= 5 * 60_000) freshness = 0.02;
    else if (ageMs > 60 * 60_000) freshness = -0.20;
  }

  return clamp(base + rankBonus + parserBonus + corroboration + freshness, 0, 0.99);
}

export function timestampGuard(value, {
  now = Date.now(),
  maxPastMs = 2 * 60 * 60_000,
  maxFutureMs = 60_000
} = {}) {
  const ts = new Date(value).getTime();
  if (!Number.isFinite(ts)) {
    return { ok: false, reason: "invalid_timestamp", timestamp: null, ageMs: null };
  }

  const ageMs = Number(now) - ts;
  if (ageMs > maxPastMs) {
    return { ok: false, reason: "timestamp_too_old", timestamp: ts, ageMs };
  }

  if (ageMs < -maxFutureMs) {
    return { ok: false, reason: "timestamp_in_future", timestamp: ts, ageMs };
  }

  return { ok: true, reason: null, timestamp: ts, ageMs };
}

export function anomalyGuard({
  event = {},
  now = Date.now(),
  occurrenceTimes = [],
  burstWindowMs = 30_000,
  burstLimit = 8
} = {}) {
  const timestamp = event.spawnedAt || event.occurredAt || event.appearedAt ||
    event.createdTimestamp || event.date || null;
  const timeCheck = timestampGuard(timestamp, { now });

  if (!timeCheck.ok) {
    return { anomaly: true, reason: timeCheck.reason, timestamp: timeCheck.timestamp };
  }

  const burstCount = (Array.isArray(occurrenceTimes) ? occurrenceTimes : [])
    .filter(at => Number(now) - Number(at) >= 0 && Number(now) - Number(at) <= burstWindowMs)
    .length;

  if (burstCount >= burstLimit) {
    return { anomaly: true, reason: "burst_frequency", timestamp: timeCheck.timestamp };
  }

  return { anomaly: false, reason: null, timestamp: timeCheck.timestamp };
}

export function transitionEventState({
  current = "WAITING",
  occurredAt = Date.now(),
  now = Date.now(),
  cycleMs = 30 * 60_000,
  activeMs = 5 * 60_000
} = {}) {
  const ts = Number(new Date(occurredAt).getTime());
  if (!Number.isFinite(ts)) return current;

  const age = Number(now) - ts;
  if (age < 0) return "DETECTED";
  if (age < activeMs) return "ACTIVE";
  if (age < cycleMs) return "ENDED";
  return "NEXT_CYCLE";
}

export function rankSourceHealth(sources = []) {
  return [...(Array.isArray(sources) ? sources : [])]
    .map((source, index) => ({
      ...source,
      _order: index,
      _failures: Number(source?.failures || source?.consecutiveFailures || 0),
      _latency: Number.isFinite(Number(source?.latencyMs)) ? Number(source.latencyMs) : 999999
    }))
    .sort((a, b) =>
      (String(a.status).toUpperCase() === "ACTIVE" ? 0 : 1) -
      (String(b.status).toUpperCase() === "ACTIVE" ? 0 : 1) ||
      a._failures - b._failures ||
      a._latency - b._latency ||
      a._order - b._order
    )
    .map(({ _order, _failures, _latency, ...source }) => source);
}
