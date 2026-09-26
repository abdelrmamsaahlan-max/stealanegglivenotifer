import test from "node:test";
import assert from "node:assert/strict";
import { parseSpawn } from "../src/parser.js";

const allRarities = new Set(["secret", "eternal", "divine"]);

test("parses a normal text spawn", () => {
  const result = parseSpawn({
    text: "🚨 Secret Egg Spawned: Crystal Egg in Volcano",
    fields: []
  }, allRarities);

  assert.equal(result?.rarity, "Secret");
  assert.equal(result?.eggName, "Crystal Egg");
  assert.equal(result?.biome, "Volcano");
});

test("parses structured fields and optional spawn data", () => {
  const result = parseSpawn({
    text: "New Eternal spawn detected!",
    fields: [
      { name: "Egg Name", value: "Ancient Egg" },
      { name: "Location", value: "Ice Cave" },
      { name: "Chance", value: "0.5%" },
      { name: "Value", value: "$5M" }
    ]
  }, allRarities);

  assert.equal(result?.rarity, "Eternal");
  assert.equal(result?.eggName, "Ancient Egg");
  assert.equal(result?.biome, "Ice Cave");
  assert.equal(result?.chance, "0.5%");
  assert.equal(result?.value, "$5M");
});

test("ignores a rarity-only announcement", () => {
  const result = parseSpawn({
    text: "Secret eggs are getting a balance change next update.",
    fields: []
  }, allRarities);

  assert.equal(result, null);
});

test("parses an explicit rarity egg label", () => {
  const result = parseSpawn({
    text: "Eternal Egg: Dragon Egg in Castle",
    fields: []
  }, allRarities);

  assert.equal(result?.rarity, "Eternal");
  assert.equal(result?.eggName, "Dragon Egg");
  assert.equal(result?.biome, "Castle");
});

test("respects the configured rarity allow-list", () => {
  const result = parseSpawn({
    text: "Divine Egg Spawned: Omega Egg in Castle",
    fields: []
  }, new Set(["secret", "eternal"]));

  assert.equal(result, null);
});
