import test from "node:test";
import assert from "node:assert/strict";
import { shouldProcessLiveFeedCandidate } from "../src/live-feed-gate.js";

test("startup prime suppresses the initial baseline", () => {
  const result = shouldProcessLiveFeedCandidate({
    eventTime: 1000,
    fingerprint: "a",
    primed: false,
    startupBaselineAt: null,
    processedEvents: new Map()
  });
  assert.equal(result.process, false);
  assert.equal(result.reason, "startup_prime");
});

test("persisted restart baseline suppresses old feed events", () => {
  const result = shouldProcessLiveFeedCandidate({
    eventTime: 1000,
    fingerprint: "old",
    primed: true,
    startupBaselineAt: 2000,
    processedEvents: new Map()
  });
  assert.equal(result.process, false);
  assert.equal(result.reason, "before_restart_baseline");
});

test("new event after persisted baseline is accepted", () => {
  const result = shouldProcessLiveFeedCandidate({
    eventTime: 3000,
    fingerprint: "new",
    primed: true,
    startupBaselineAt: 2000,
    processedEvents: new Map()
  });
  assert.equal(result.process, true);
});

test("processed fingerprint stays deduplicated after restart", () => {
  const seen = new Map([["same", Date.now()]]);
  const result = shouldProcessLiveFeedCandidate({
    eventTime: Date.now(),
    fingerprint: "same",
    primed: true,
    startupBaselineAt: Date.now() - 60_000,
    processedEvents: seen
  });
  assert.equal(result.process, false);
  assert.equal(result.reason, "already_processed");
});


test("merges the same spawn observed by alternate feed endpoints", async () => {
  const { mergeNearDuplicateFeedCandidates } = await import("../src/live-feed-gate.js");
  const base = Date.parse("2026-09-26T17:15:00.000Z");
  const candidates = [
    {
      eventTime: base,
      index: 0,
      candidate: {
        rarity: "Secret",
        eggName: "Cerberus Egg",
        biome: "Volcano",
        score: 90,
        sourceEventId: "feed-a"
      }
    },
    {
      eventTime: base + 1800,
      index: 1,
      candidate: {
        rarity: "Secret",
        eggName: "Cerberus Egg",
        biome: "Volcano",
        score: 95,
        sourceEventId: "feed-b"
      }
    }
  ];
  assert.equal(mergeNearDuplicateFeedCandidates(candidates).length, 1);
});

test("keeps separate same-egg spawns from the same endpoint", async () => {
  const { mergeNearDuplicateFeedCandidates } = await import("../src/live-feed-gate.js");
  const base = Date.parse("2026-09-26T17:15:00.000Z");
  const candidates = [
    {
      eventTime: base,
      index: 0,
      candidate: {
        rarity: "Divine",
        eggName: "Kitsune Egg",
        biome: "Cherry Blossom",
        score: 90,
        sourceEventId: null
      }
    },
    {
      eventTime: base + 10_000,
      index: 0,
      candidate: {
        rarity: "Divine",
        eggName: "Kitsune Egg",
        biome: "Cherry Blossom",
        score: 90,
        sourceEventId: null
      }
    }
  ];
  assert.equal(mergeNearDuplicateFeedCandidates(candidates).length, 2);
});
