import test from "node:test";
import assert from "node:assert/strict";
import { parseSpawn } from "../src/parser.js";

const rarities = new Set(["secret", "eternal", "divine"]);

test("parseSpawn reads a structured rare egg alert", () => {
  const event = parseSpawn({
    text: "Secret egg alert",
    fields: [
      { name: "Egg", value: "Cerberus Egg" },
      { name: "Location", value: "Volcano" },
      { name: "Income", value: "$8M/s" }
    ]
  }, rarities);

  assert.ok(event);
  assert.equal(event.eggName, "Cerberus Egg");
  assert.equal(event.rarity, "Secret");
  assert.equal(event.biome, "Volcano");
  assert.equal(event.income, "$8M/s");
  assert.equal(event.live, true);
});

test("parseSpawn handles natural-language spawn messages", () => {
  const event = parseSpawn({
    text: "ETERNAL egg Ice Dragon spawned in Snow!"
  }, rarities);

  assert.ok(event);
  assert.equal(event.eggName, "Ice Dragon");
  assert.equal(event.rarity, "Eternal");
  assert.equal(event.biome, "Snow");
});

test("parseSpawn ignores unrelated rarity mentions", () => {
  const event = parseSpawn({
    text: "Trade chat: I want Secret and Divine eggs."
  }, rarities);

  assert.equal(event, null);
});

test("parseSpawn respects the configured rarity allowlist", () => {
  const event = parseSpawn({
    text: "Common egg spawned in Jungle."
  }, new Set(["secret"]));

  assert.equal(event, null);
});


test("parses a Secret egg when the same message also announces a Forbidden Experiment", () => {
  const event = parseSpawn({
    text:
      "<:Scramble_Experiment:1550937506013253724> A Forbidden Experiment Has Appeared!",
    fields: [
      { name: "Rarity", value: "Secret" },
      { name: "Egg", value: "Nightflame Egg" },
      { name: "Location", value: "Titan Temple" }
    ]
  }, rarities);

  assert.ok(event);
  assert.equal(event.eggName, "Nightflame Egg");
  assert.equal(event.rarity, "Secret");
  assert.equal(event.biome, "Titan Temple");
});


test("parses a text-only rare egg announcement combined with Forbidden Experiment", () => {
  const event = parseSpawn({
    text: "A Forbidden Experiment Has Appeared!\nKitsune Egg • Divine • 📍 Cherry Blossom"
  }, rarities);

  assert.ok(event);
  assert.equal(event.eggName, "Kitsune Egg");
  assert.equal(event.rarity, "Divine");
  assert.equal(event.biome, "Unknown");
});


test("prioritizes the structured rarity when event text contains another rarity mention", () => {
  const event = parseSpawn({
    text:
      "Forbidden Experiment appeared. Divine rewards are possible.",
    fields: [
      { name: "Rarity", value: "Secret" },
      { name: "Egg", value: "Nightflame Egg" },
      { name: "Location", value: "Titan Temple" }
    ]
  }, rarities);

  assert.ok(event);
  assert.equal(event.eggName, "Nightflame Egg");
  assert.equal(event.rarity, "Secret");
});
