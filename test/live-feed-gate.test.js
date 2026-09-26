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
