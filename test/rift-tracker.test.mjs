import test from "node:test";
import assert from "node:assert/strict";
import { getRiftData, parseRiftChange } from "../src/rift-tracker.js";

test("parses a SenZ-style Riftborn rotation message", () => {
  const event = parseRiftChange({
    text:
      "The Rift shifted — Riftborn is now active!\n\n" +
      "Riftborn is Active!\n" +
      "Changed: 6:00 AM (25 minutes ago) Next Change: 9:00 AM (in 3 hours) " +
      "Join Game: Click Here\n\n" +
      "Possible Pets\n" +
      "Rift Eye 45% $11K/s\n" +
      "Voidmaw 36% $50K/s\n" +
      "Ventinal 15% $585K/s\n" +
      "Wendigo 4% $15M/s\n" +
      "World Eater 0.5% $500M/s",
    fields: [],
    linkUrls: [
      "https://www.roblox.com/games/start?placeId=107778070777162&gameId=test"
    ],
    createdTimestamp: Date.parse("2026-09-26T03:00:00.000Z"),
    messageUrl: "https://discord.com/channels/test"
  });

  assert.ok(event);
  assert.equal(event.type, "banner");
  assert.equal(event.bannerKey, "riftborn");
  assert.equal(event.bannerName, "Riftborn");
  assert.equal(event.changedLabel, "6:00 AM (25 minutes ago)");
  assert.equal(event.nextChangeLabel, "9:00 AM (in 3 hours)");
  assert.equal(event.joinUrl.includes("roblox.com/games/start"), true);
  assert.equal(
    event.possiblePets.find(p => p.name === "World Eater")?.chance,
    "0.5%"
  );
  assert.equal(
    event.possiblePets.find(p => p.name === "World Eater")?.income,
    "$500M/s"
  );
});

test("keeps the static Rift pool available when pet rows are absent", () => {
  const data = getRiftData("shattered rift");
  assert.ok(data);
  assert.equal(data.rotationChance, "20%");
  assert.equal(data.pets.length, 5);
  assert.equal(data.pets[4].name, "Shattered Colossus");
});


test("detects the separate Abyss Overlord Rift boss event", () => {
  const event = parseRiftChange({
    text: "The Rift has been opened. Abyss Overlord is now active! Join Game: Click Here",
    fields: [],
    linkUrls: [
      "https://www.roblox.com/games/start?placeId=107778070777162&gameId=boss"
    ],
    createdTimestamp: 0
  });

  assert.ok(event);
  assert.equal(event.type, "boss");
  assert.equal(event.bossName, "Abyss Overlord");
  assert.equal(event.joinUrl.includes("roblox.com/games/start"), true);
});

test("does not turn a normal Rift mention into a rotation alert", () => {
  const event = parseRiftChange({
    text: "Riftborn Egg is available in the Rift shop.",
    fields: [],
    linkUrls: []
  });

  assert.equal(event, null);
});
