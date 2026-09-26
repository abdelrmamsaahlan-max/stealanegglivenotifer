import test from "node:test";
import assert from "node:assert/strict";
import {
  addEvidence,
  anomalyGuard,
  calculateEventConfidence,
  createIncidentId,
  eventFingerprint,
  rankSourceHealth,
  timestampGuard,
  transitionEventState
} from "../src/reliability.js";

test("incident ids are stable-shaped and unique enough for alert tracing", () => {
  const a = createIncidentId();
  const b = createIncidentId();
  assert.match(a, /^SAE-\d{14}-[A-F0-9]{6}$/);
  assert.notEqual(a, b);
});

test("multi-source evidence increases confidence without exceeding cap", () => {
  const one = addEvidence([], {
    source: "Live Feed",
    sourceKey: "feed-a",
    parser: "egg"
  });
  const two = addEvidence(one, {
    source: "Discord Source",
    sourceKey: "discord-b",
    parser: "egg"
  });
  const observedAt = new Date(Date.now() - 10 * 60_000).toISOString();
  const single = calculateEventConfidence({
    source: "Live Feed",
    sourceRank: 8,
    parserConfidence: 0.75,
    evidence: one,
    occurredAt: observedAt
  });
  const corroborated = calculateEventConfidence({
    source: "Live Feed",
    sourceRank: 8,
    parserConfidence: 0.75,
    evidence: two,
    occurredAt: observedAt
  });

  assert.ok(corroborated > single);
  assert.ok(corroborated <= 0.99);
});

test("timestamp guard blocks stale and future data", () => {
  const now = Date.now();
  assert.equal(timestampGuard(new Date(now - 5 * 60_000).toISOString(), { now }).ok, true);
  assert.equal(timestampGuard(new Date(now - 3 * 60 * 60_000).toISOString(), { now }).reason, "timestamp_too_old");
  assert.equal(timestampGuard(new Date(now + 5 * 60_000).toISOString(), { now }).reason, "timestamp_in_future");
});

test("anomaly guard flags bursty duplicate storms", () => {
  const now = Date.now();
  const result = anomalyGuard({
    event: { occurredAt: new Date(now).toISOString() },
    now,
    occurrenceTimes: Array.from({ length: 8 }, () => now - 1000)
  });
  assert.equal(result.anomaly, true);
  assert.equal(result.reason, "burst_frequency");
});

test("event state progresses through the cycle", () => {
  const now = Date.now();
  const occurredAt = now - 2 * 60_000;
  assert.equal(
    transitionEventState({ occurredAt, now, cycleMs: 30 * 60_000, activeMs: 5 * 60_000 }),
    "ACTIVE"
  );
  assert.equal(
    transitionEventState({ occurredAt: now - 10 * 60_000, now, cycleMs: 30 * 60_000, activeMs: 5 * 60_000 }),
    "ENDED"
  );
  assert.equal(
    transitionEventState({ occurredAt: now - 31 * 60_000, now, cycleMs: 30 * 60_000, activeMs: 5 * 60_000 }),
    "NEXT_CYCLE"
  );
});

test("source ranking prefers active low-failure sources", () => {
  const ranked = rankSourceHealth([
    { key: "dead", status: "DEAD", failures: 5, latencyMs: 20 },
    { key: "slow", status: "ACTIVE", failures: 1, latencyMs: 500 },
    { key: "fast", status: "ACTIVE", failures: 0, latencyMs: 100 }
  ]);
  assert.deepEqual(ranked.map(item => item.key), ["fast", "slow", "dead"]);
});

test("fingerprint separates source evidence while keeping event fields deterministic", () => {
  const a = eventFingerprint({
    source: "Live Feed",
    rarity: "Divine",
    eggName: "Kitsune Egg",
    biome: "Cherry Blossom",
    sourceEventId: "1"
  });
  const b = eventFingerprint({
    source: "Discord Source",
    rarity: "Divine",
    eggName: "Kitsune Egg",
    biome: "Cherry Blossom",
    sourceEventId: "2"
  });
  assert.notEqual(a, b);
});
