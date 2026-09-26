import test from "node:test";
import assert from "node:assert/strict";

import {
  chooseBestUpdate,
  discoveryFingerprint,
  extractDiscoveryEvents,
  extractRelevantLinks,
  extractSupportedEggsFromDiscovery,
  extractUpdateSnapshot
} from "../src/discovery.js";

const updatesHtml = `
  <h2>Updates and events</h2>
  <h3>Update 5 · September 19, 2026</h3>
  <h4>Dr. Scramble (Sammy is Coming)</h4>
  <p>Every 30 minutes, Dr. Scramble's drones invade the map.</p>
  <a href="/updates/dr-scramble/">Read update</a>
`;

test("extracts update number, date, title and description", () => {
  const result = extractUpdateSnapshot(updatesHtml, "Eggipedia Updates");

  assert.equal(result.updateNumber, 5);
  assert.equal(result.date, "2026-09-19");
  assert.match(result.title, /Dr\. Scramble/i);
  assert.match(result.description, /30 minutes/i);
});

test("extracts supported rare eggs from structured rarity sections", () => {
  const html = `
    <h3>Secret</h3>
    <div>King Snake Egg Jungle</div>
    <div>Yeti Egg Snow</div>
    <h3>Eternal</h3>
    <div>Ice Dragon Egg Snow</div>
    <h3>Divine</h3>
    <div>Kitsune Egg Cherry Blossom</div>
  `;

  const eggs = extractSupportedEggsFromDiscovery(html);

  assert.deepEqual(
    eggs.map(item => [item.rarity, item.eggName]),
    [
      ["Secret", "King Snake Egg"],
      ["Secret", "Yeti Egg"],
      ["Eternal", "Ice Dragon Egg"],
      ["Divine", "Kitsune Egg"]
    ]
  );
});

test("extracts high-value event signals", () => {
  const html = `
    <p>Dr. Scramble's Revenge is scheduled for September 26.</p>
    <p>Rifts open every 30 minutes and the Overlord appears.</p>
  `;

  const events = extractDiscoveryEvents(html, "Official Roblox Game");

  assert.ok(events.some(item => /Dr\. Scramble/i.test(item.title)));
  assert.ok(events.some(item => /Rifts?/i.test(item.title)));
});

test("only follows allowlisted discovery hosts", () => {
  const html = `
    <a href="https://eggipedia.com/updates">Eggipedia</a>
    <a href="https://www.roblox.com/games/107778070777162/Steal-An-Egg">Roblox</a>
    <a href="https://example.com/update">External</a>
    <a href="/events/current">Local Event</a>
  `;

  const links = extractRelevantLinks(
    html,
    "https://robloxstealanegg.wiki/",
    10
  );

  assert.ok(links.some(item => item.url.startsWith("https://eggipedia.com/")));
  assert.ok(links.some(item => item.url.startsWith("https://www.roblox.com/")));
  assert.ok(links.some(item => item.url.startsWith("https://robloxstealanegg.wiki/")));
  assert.ok(!links.some(item => item.url.includes("example.com")));
});

test("chooses the newest numbered update before relying on source rank", () => {
  const best = chooseBestUpdate(
    [
      {
        title: "Older Update",
        updateNumber: 4,
        date: "2026-09-12",
        source: "High Confidence Source"
      },
      {
        title: "Dr. Scramble",
        updateNumber: 5,
        date: "2026-09-19",
        source: "Lower Confidence Source"
      }
    ],
    {
      "High Confidence Source": 10,
      "Lower Confidence Source": 1
    }
  );

  assert.equal(best.title, "Dr. Scramble");
  assert.equal(discoveryFingerprint(best), "u5|2026-09-19|dr scramble");
});
