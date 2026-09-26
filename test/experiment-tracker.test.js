import test from "node:test";
import assert from "node:assert/strict";
import {
  EXPERIMENT_ACTIVE_MINUTES,
  EXPERIMENT_CYCLE_MINUTES,
  experimentEventKey,
  parseExperimentAlert
} from "../src/experiment-tracker.js";

test("detects a Forbidden Experiment announcement and extracts the next timer", () => {
  const createdTimestamp = Date.UTC(2026, 8, 26, 7, 51, 0);

  const event = parseExperimentAlert({
    text:
      "<:Scramble_Experiment:1550937506013253724>" +
      " **A Forbidden Experiment Has Appeared**\n" +
      "**Dr. Scramble Experiment** has appeared!\n" +
      "<:Roblox:1545747766649684068> **Join Game:** " +
      "[Click Here](https://www.roblox.com/games/start?placeId=107778070777162\\&gameId=test) " +
      "<:loading:1484180832498487407> **Next experiment in:** " +
      "8:00 AM (in 9 minutes)",
    createdTimestamp
  });

  assert.ok(event);
  assert.equal(event.experimentName, "Dr. Scramble Experiment");
  assert.equal(event.activeMinutes, EXPERIMENT_ACTIVE_MINUTES);
  assert.equal(event.cycleMinutes, EXPERIMENT_CYCLE_MINUTES);
  assert.equal(event.joinUrl.includes("roblox.com/games/start"), true);
  assert.equal(event.nextExperimentAt, createdTimestamp + 9 * 60_000);
  assert.equal(event.customEmojis.length, 3);
});

test("falls back to the 30-minute cycle when no countdown is present", () => {
  const createdTimestamp = Date.UTC(2026, 8, 26, 7, 30, 0);

  const event = parseExperimentAlert({
    text: "A Forbidden Experiment Has Appeared!",
    createdTimestamp
  });

  assert.ok(event);
  assert.equal(
    event.nextExperimentAt,
    createdTimestamp + EXPERIMENT_CYCLE_MINUTES * 60_000
  );
});

test("ignores unrelated messages", () => {
  const event = parseExperimentAlert({
    text: "Dr. Scramble update: collect Samples before the next experiment."
  });

  assert.equal(event, null);
});

test("event keys stay stable for the same minute", () => {
  const first = parseExperimentAlert({
    text: "A Forbidden Experiment Has Appeared!",
    createdTimestamp: Date.UTC(2026, 8, 26, 7, 30, 1)
  });

  const second = parseExperimentAlert({
    text: "A Forbidden Experiment Has Appeared!",
    createdTimestamp: Date.UTC(2026, 8, 26, 7, 30, 59)
  });

  assert.ok(first && second);
  assert.equal(experimentEventKey(first), experimentEventKey(second));
});


test("detects flexible Dr. Scramble active wording", () => {
  const event = parseExperimentAlert({
    text: "Dr. Scramble is active! Next experiment in: (in 12 minutes)",
    createdTimestamp: Date.UTC(2026, 8, 26, 8, 10, 0)
  });

  assert.ok(event);
  assert.equal(event.experimentName, "Dr. Scramble Experiment");
  assert.equal(event.nextExperimentAt, Date.UTC(2026, 8, 26, 8, 22, 0));
});

test("detects a short forbidden experiment spawn message", () => {
  const event = parseExperimentAlert({
    text: "Forbidden Experiment spawned"
  });

  assert.ok(event);
});
