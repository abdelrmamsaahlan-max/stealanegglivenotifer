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

test("extracts rare pets from current table-style discovery rows", () => {
  const html = `
    <table>
      <tr><th>Pet</th><th>Rarity</th><th>Biome</th><th>Income</th></tr>
      <tr><td>Image: King SnakeKing Snake</td><td>Secret</td><td>Jungle</td><td>$3.5M/s</td></tr>
      <tr><td>Yeti</td><td>Secret</td><td>Snow</td><td>$5M/s</td></tr>
      <tr><td>Nightflame</td><td>Divine</td><td>Titan Temple</td><td>$3B/s</td></tr>
    </table>
  `;

  const eggs = extractSupportedEggsFromDiscovery(html);

  assert.deepEqual(
    eggs.map(item => [item.rarity, item.eggName, item.area]),
    [
      ["Secret", "King Snake Egg", "Jungle"],
      ["Secret", "Yeti Egg", "Snow"],
      ["Divine", "Nightflame Egg", "Titan Temple"]
    ]
  );
});

test("rejects update/version headings as discovered pets", () => {
  const html = `
    Update 1 · September 1, 2026 | Divine | Titan Temple | details
    Version 2 · September 2, 2026 | Divine | Titan Temple | details
    Nightflame | Divine | Titan Temple | $3B/s
  `;

  const eggs = extractSupportedEggsFromDiscovery(html);

  assert.deepEqual(
    eggs.map(item => item.eggName),
    ["Nightflame Egg"]
  );
});

test("extracts rare pets from pipe-delimited rendered rows", () => {
  const html = `
    Image: CerberusCerberus | Secret | Volcano | $8M/s | calc
    Image: Gorilla KingGorilla King | Eternal | Titan Temple | $880M/s | calc
  `;

  const eggs = extractSupportedEggsFromDiscovery(html);

  assert.deepEqual(
    eggs.map(item => [item.rarity, item.eggName, item.area]),
    [
      ["Secret", "Cerberus Egg", "Volcano"],
      ["Eternal", "Gorilla King Egg", "Titan Temple"]
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

test("only follows configured discovery hosts", () => {
  process.env.DISCOVERY_ALLOWED_HOSTS =
    "secondary.example,tertiary.example";

  const html = `
    <a href="https://secondary.example/updates">Secondary</a>
    <a href="https://tertiary.example/events">Tertiary</a>
    <a href="https://blocked.example/update">Blocked</a>
    <a href="/events/current">Local Event</a>
  `;

  const links = extractRelevantLinks(
    html,
    "https://primary.example/",
    10
  );

  assert.ok(links.some(item => item.url.startsWith("https://secondary.example/")));
  assert.ok(links.some(item => item.url.startsWith("https://tertiary.example/")));
  assert.ok(links.some(item => item.url.startsWith("https://primary.example/")));
  assert.ok(!links.some(item => item.url.includes("blocked.example")));
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
