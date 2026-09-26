import test from "node:test";
import assert from "node:assert/strict";
import { getRiftData, parseRiftChange } from "../src/rift-tracker.js";

test("parseRiftChange prefers observed rotation chance from the source", () => {
  const event = parseRiftChange({
    text: "Riftborn is now active",
    fields: [
      { name: "Rotation Chance", value: "47%" },
      { name: "Changed", value: "Just now" },
      { name: "Next Change", value: "2h 59m" }
    ],
    linkUrls: ["https://www.roblox.com/games/start?placeId=107778070777162"]
  });

  assert.ok(event);
  assert.equal(event.type, "banner");
  assert.equal(event.bannerKey, "riftborn");
  assert.equal(event.rotationChance, "47%");
  assert.equal(event.changedLabel, "Just now");
  assert.equal(event.nextChangeLabel, "2h 59m");
});

test("parseRiftChange recognizes the Abyss Overlord boss alert", () => {
  const event = parseRiftChange({
    text: "Abyss Overlord spawned! The boss fight is active. Next boss fight: 30 minutes"
  });

  assert.ok(event);
  assert.equal(event.type, "boss");
  assert.equal(event.bossName, "Abyss Overlord");
});

test("getRiftData exposes the three tracked Rift banners", () => {
  for (const name of ["Riftborn", "Riftbeasts", "Shattered Rift"]) {
    const data = getRiftData(name);
    assert.ok(data);
    assert.equal(data.pets.length, 5);
  }
});


test("parseRiftChange recognizes flexible current-rift embed wording", () => {
  const event = parseRiftChange({
    text: "Current Rift: Riftbeasts",
    fields: [
      { name: "Status", value: "Active now" },
      { name: "Next Change", value: "in 2h 30m" }
    ]
  });

  assert.ok(event);
  assert.equal(event.bannerKey, "riftbeasts");
  assert.equal(event.nextChangeLabel, "in 2h 30m");
});

test("parseRiftChange recognizes a bare Abyss Overlord active signal", () => {
  const event = parseRiftChange({
    text: "⚔️ Abyss Overlord — LIVE",
    fields: []
  });

  assert.ok(event);
  assert.equal(event.type, "boss");
  assert.equal(event.bossName, "Abyss Overlord");
});
