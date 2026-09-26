import test from "node:test";
import assert from "node:assert/strict";
import {
  addDeadLetterAlert,
  buildWeeklyReportText,
  getOpsSummary,
  markWeeklyReportSent,
  noteSourceObservation,
  percentile,
  recordLatency,
  recordLifecycle,
  restoreOpsState,
  shouldRunWeeklyReport,
  snapshotOpsState
} from "../src/ops.js";

test("percentile calculation is deterministic", () => {
  assert.equal(percentile([10, 20, 30, 40], 50), 25);
  assert.equal(percentile([10, 20, 30, 40], 95), 39);
});

test("lifecycle and latency metrics are retained", () => {
  restoreOpsState({});
  recordLatency(100);
  recordLatency(300);
  recordLatency(500);
  recordLifecycle({ incidentId: "EGG-1", source: "Live Feed" }, "DETECTED");
  recordLifecycle({ incidentId: "EGG-1", source: "Live Feed" }, "QUEUED");
  recordLifecycle({ incidentId: "EGG-1", source: "Live Feed" }, "SENT");

  const summary = getOpsSummary();
  assert.equal(summary.latency.p50Ms, 300);
  assert.equal(summary.latency.p95Ms, 480);
  assert.equal(summary.lifecycle.sent, 1);
});

test("dead-letter entries are bounded and traceable", () => {
  restoreOpsState({});
  const item = addDeadLetterAlert(
    { incidentId: "EGG-2", rarity: "Divine", eggName: "Kitsune Egg" },
    new Error("discord timeout"),
    3
  );
  assert.equal(item.incidentId, "EGG-2");
  assert.equal(getOpsSummary().deadLetter.count, 1);
});

test("source disagreements are recorded instead of silently selecting one", () => {
  restoreOpsState({});
  const time = new Date("2026-09-26T18:00:00.000Z").toISOString();
  assert.equal(
    noteSourceObservation({
      rarity: "Divine",
      eggName: "Kitsune Egg",
      biome: "Cherry Blossom",
      source: "Live Feed",
      spawnedAt: time
    }),
    null
  );
  const conflict = noteSourceObservation({
    rarity: "Divine",
    eggName: "Other Egg",
    biome: "Volcano",
    source: "Discord Source",
    spawnedAt: time
  });
  assert.ok(conflict);
  assert.deepEqual(conflict.sources.sort(), ["discord source", "live feed"]);
});

test("weekly report gating is restart-safe", () => {
  restoreOpsState({});
  assert.equal(shouldRunWeeklyReport({ now: 1_000 }), true);
  markWeeklyReportSent(new Date(1_000).toISOString());
  assert.equal(shouldRunWeeklyReport({ now: 1_000 + 6 * 24 * 60 * 60_000 }), false);
  assert.equal(shouldRunWeeklyReport({ now: 1_000 + 7 * 24 * 60 * 60_000 }), true);
  assert.ok(buildWeeklyReportText(getOpsSummary()).includes("Weekly Reliability Report"));
  assert.equal(snapshotOpsState().version, 1);
});
