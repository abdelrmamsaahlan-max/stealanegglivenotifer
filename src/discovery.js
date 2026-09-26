const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
};

function cleanText(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function htmlToLines(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>|<\/div>|<\/section>|<\/li>|<\/h[1-6]>/gi, "\n")
    .replace(/<[^>]+>/g, "\n")
    .split(/\n+/)
    .map(cleanText)
    .filter(Boolean);
}

function parseDateText(value) {
  const raw = cleanText(value);

  const long = raw.match(
    /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?[,]?\s+(20\d{2})\b/i
  );

  if (long) {
    const month = MONTHS[long[1].slice(0, 3).toLowerCase()];
    const date = new Date(Date.UTC(
      Number(long[3]),
      month,
      Number(long[2])
    ));
    return Number.isFinite(date.getTime())
      ? date.toISOString().slice(0, 10)
      : null;
  }

  const slash = raw.match(/\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/);
  if (slash) {
    const date = new Date(Date.UTC(
      Number(slash[3]),
      Number(slash[1]) - 1,
      Number(slash[2])
    ));
    return Number.isFinite(date.getTime())
      ? date.toISOString().slice(0, 10)
      : null;
  }

  const iso = raw.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  return iso ? iso[1] : null;
}

function extractUpdateNumber(text) {
  const match = cleanText(text).match(
    /\b(?:update|version)\s*#?\s*(\d{1,3})\b/i
  );
  return match ? Number(match[1]) : null;
}

const DISCOVERY_AREAS = [
  "Jungle",
  "Snow",
  "Volcano",
  "Abyss Ocean",
  "Prehistoric",
  "Cosmic",
  "Cherry Blossom",
  "Titan Temple",
  "Angels and Demons",
  "Area not listed"
];

function cleanDiscoveryName(value) {
  let name = cleanText(value)
    .replace(/^image\s*:\s*/i, "")
    .replace(/\s+Egg$/i, "")
    .trim();

  if (
    !name ||
    name.length > 90 ||
    /^(?:update|version)\s*\d+/i.test(name)
  ) return "";

  const normalized = name.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (normalized.length >= 6 && normalized.length % 2 === 0) {
    const midpoint = normalized.length / 2;
    if (normalized.slice(0, midpoint) === normalized.slice(midpoint)) {
      const rawHalf = name.slice(0, Math.floor(name.length / 2)).trim();
      if (rawHalf) name = rawHalf;
    }
  }

  return name;
}

function pushDiscoveredEgg(found, name, rarity, area) {
  const cleanName = cleanDiscoveryName(name);
  if (!cleanName) return;

  const cleanRarity = cleanText(rarity);
  const cleanArea = cleanText(area);

  if (
    !/^(Secret|Eternal|Divine)$/i.test(cleanRarity) ||
    !DISCOVERY_AREAS.some(candidate =>
      candidate.toLowerCase() === cleanArea.toLowerCase()
    )
  ) {
    return;
  }

  found.push({
    eggName: cleanName + " Egg",
    rarity:
      cleanRarity[0].toUpperCase() + cleanRarity.slice(1).toLowerCase(),
    area: DISCOVERY_AREAS.find(candidate =>
      candidate.toLowerCase() === cleanArea.toLowerCase()
    ) || cleanArea
  });
}

function extractDiscoveryTableEggs(html, found) {
  for (const rowMatch of String(html || "").matchAll(
    /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi
  )) {
    const cells = [...rowMatch[1].matchAll(
      /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi
    )].map(match =>
      cleanText(match[1].replace(/<[^>]+>/g, " "))
    );

    if (cells.length < 3) continue;

    const rarityIndex = cells.findIndex(cell =>
      /^(Secret|Eternal|Divine)$/i.test(cell)
    );
    const areaIndex = cells.findIndex(cell =>
      DISCOVERY_AREAS.some(area =>
        area.toLowerCase() === cell.toLowerCase()
      )
    );

    if (rarityIndex < 0 || areaIndex < 0 || rarityIndex === areaIndex) {
      continue;
    }

    const nameIndex = Math.min(rarityIndex, areaIndex) - 1;
    const name = nameIndex >= 0
      ? cells[nameIndex]
      : cells.find((cell, index) =>
          index !== rarityIndex &&
          index !== areaIndex &&
          cell.length >= 2
        );

    pushDiscoveredEgg(found, name, cells[rarityIndex], cells[areaIndex]);
  }
}

export function extractSupportedEggsFromDiscovery(html) {
  const found = [];

  // First handle normal HTML tables used by current wiki/tier-list pages.
  extractDiscoveryTableEggs(html, found);

  const lines = htmlToLines(html);
  let rarity = "";

  for (const line of lines) {
    const pipeCells = line
      .split("|")
      .map(cleanText)
      .filter(Boolean);

    if (pipeCells.length >= 3) {
      const rarityIndex = pipeCells.findIndex(cell =>
        /^(Secret|Eternal|Divine)$/i.test(cell)
      );
      const areaIndex = pipeCells.findIndex(cell =>
        DISCOVERY_AREAS.some(area =>
          area.toLowerCase() === cell.toLowerCase()
        )
      );

      if (rarityIndex >= 0 && areaIndex >= 0 && rarityIndex !== areaIndex) {
        const nameIndex = Math.min(rarityIndex, areaIndex) - 1;
        const name = nameIndex >= 0
          ? pipeCells[nameIndex]
          : pipeCells.find((cell, index) =>
              index !== rarityIndex &&
              index !== areaIndex &&
              cell.length >= 2
            );

        pushDiscoveredEgg(
          found,
          name,
          pipeCells[rarityIndex],
          pipeCells[areaIndex]
        );
        continue;
      }
    }

    if (/^Secret$/i.test(line)) {
      rarity = "Secret";
      continue;
    }
    if (/^Eternal$/i.test(line)) {
      rarity = "Eternal";
      continue;
    }
    if (/^Divine$/i.test(line)) {
      rarity = "Divine";
      continue;
    }
    if (!rarity) continue;

    const match = line.match(
      /^(.+?)\s+(Jungle|Snow|Volcano|Abyss Ocean|Prehistoric|Cosmic|Cherry Blossom|Titan Temple|Angels and Demons|Area not listed)$/i
    );

    if (!match) continue;

    pushDiscoveredEgg(found, match[1], rarity, match[2]);
  }

  return dedupeEggs(found);
}

function dedupeEggs(items) {
  const map = new Map();

  for (const item of items || []) {
    if (!item?.eggName || !item?.rarity) continue;

    const key = [
      cleanText(item.rarity).toLowerCase(),
      cleanText(item.eggName).toLowerCase(),
      cleanText(item.area || "Unknown").toLowerCase()
    ].join("|");

    if (!map.has(key)) {
      map.set(key, item);
    }
  }

  return [...map.values()];
}

export function normalizeDiscoveryEggName(value) {
  return cleanText(value)
    .replace(/\s+egg$/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function sourceConfidenceScore(sourceRank, sourceCount = 1) {
  const rank = Math.max(0, Math.min(10, Number(sourceRank || 0)));
  const count = Math.max(1, Number(sourceCount || 1));
  return Math.min(
    99,
    Math.round(35 + rank * 4 + Math.min(3, count - 1) * 10)
  );
}

export function calculateEvidenceConfidence(observations = []) {
  const valid = observations.filter(
    item => item?.name || item?.source || item?.sourceKey
  );

  if (!valid.length) return 0;

  const uniqueSources = new Map();

  for (const item of valid) {
    const key = item.sourceKey || item.source || "unknown";
    const rank = Number(item.sourceRank || 0);
    const current = uniqueSources.get(key);

    if (!current || rank > current.rank) {
      uniqueSources.set(key, { rank });
    }
  }

  const ranks = [...uniqueSources.values()].map(item => item.rank);
  const maxRank = Math.max(...ranks, 0);

  return sourceConfidenceScore(maxRank, uniqueSources.size);
}

export function mergeEggObservations(observations = []) {
  const groups = new Map();

  for (const item of observations || []) {
    if (!item?.eggName || !item?.rarity) continue;

    const key =
      cleanText(item.rarity).toLowerCase() +
      "|" +
      normalizeDiscoveryEggName(item.eggName);

    if (!groups.has(key)) {
      groups.set(key, []);
    }

    groups.get(key).push(item);
  }

  return [...groups.entries()].map(([key, items]) => {
    const sorted = [...items].sort(
      (a, b) => Number(b.sourceRank || 0) - Number(a.sourceRank || 0)
    );

    const best = sorted[0];
    const sources = [...new Map(
      items.map(item => [
        item.sourceKey || item.source || "unknown",
        {
          key: item.sourceKey || item.source || "unknown",
          name: item.source || item.sourceKey || "Unknown source",
          rank: Number(item.sourceRank || 0)
        }
      ])
    ).values()];

    return {
      key,
      eggName: best.eggName,
      rarity: best.rarity,
      area: best.area || "Unknown",
      sources,
      sourceCount: sources.length,
      confidence: sourceConfidenceScore(
        Math.max(...sources.map(item => item.rank), 0),
        sources.length
      )
    };
  });
}

export function snapshotEggs(items = []) {
  const snapshot = {};

  for (const item of items || []) {
    if (!item?.key) continue;

    snapshot[item.key] = {
      eggName: item.eggName,
      rarity: item.rarity,
      area: item.area || "Unknown",
      sourceCount: Number(item.sourceCount || 1),
      confidence: Number(item.confidence || 0)
    };
  }

  return snapshot;
}

export function detectCatalogChanges(previous = {}, current = {}) {
  const added = [];
  const removed = [];
  const changed = [];

  for (const [key, now] of Object.entries(current)) {
    if (!previous[key]) {
      added.push({ key, ...now });
      continue;
    }

    const before = previous[key];
    if (
      before.eggName !== now.eggName ||
      before.rarity !== now.rarity ||
      before.area !== now.area
    ) {
      changed.push({
        key,
        before,
        after: now
      });
    }
  }

  for (const [key, before] of Object.entries(previous)) {
    if (!current[key]) {
      removed.push({ key, ...before });
    }
  }

  return { added, removed, changed };
}

export function extractUpdateSnapshot(html, source = "Auto Discovery") {
  const lines = htmlToLines(html);
  if (!lines.length) return null;

  const headerIndex = lines.findIndex(line =>
    /^(?:latest update|game update|what's new|whats new)$/i.test(line)
  );

  const updateIndex = lines.findIndex(line =>
    /\b(?:update|version)\s*#?\s*\d{1,3}\b/i.test(line)
  );

  let title = null;
  let updateNumber = null;
  let date = null;
  let contextStart = -1;

  if (updateIndex >= 0) {
    const header = lines[updateIndex];
    updateNumber = extractUpdateNumber(header);
    date = parseDateText(header);
    contextStart = updateIndex;

    const candidates = lines.slice(updateIndex + 1, updateIndex + 7);

    title =
      candidates.find(line =>
        /dr\.?\s*scramble|angels?.*demons?|rifts?|event|sammy|darkness|titan|cherry/i.test(line)
      ) ||
      candidates.find(line =>
        line.length >= 4 &&
        !/^update\b/i.test(line) &&
        !/^\d{1,2}[:.]\d{2}/.test(line)
      ) ||
      header;
  } else if (headerIndex >= 0) {
    const window = lines.slice(headerIndex, headerIndex + 20);
    const titleIndex = window.findIndex((line, offset) =>
      offset > 0 &&
      /(?:update|scramble|angels|demons|rift|event|egg|sammy)/i.test(line)
    );

    if (titleIndex >= 0) {
      title = window[titleIndex];
      contextStart = headerIndex + titleIndex;
      updateNumber = extractUpdateNumber(window.join(" "));
      date = parseDateText(window.join(" "));
    }
  }

  if (!title) {
    const fallback = lines.find(line =>
      /^update\s*#?\d+/i.test(line)
    );

    if (fallback) {
      title = fallback;
      updateNumber = extractUpdateNumber(fallback);
      date = parseDateText(fallback);
      contextStart = lines.indexOf(fallback);
    }
  }

  if (!title) return null;

  const nearby = lines.slice(
    Math.max(0, contextStart),
    Math.max(0, contextStart) + 8
  );

  return {
    title: cleanText(title).slice(0, 200),
    description: cleanText(nearby.join(" ")).slice(0, 1000),
    updateNumber,
    date,
    source: String(source || "Auto Discovery").slice(0, 120)
  };
}

export function extractDiscoveryEvents(html, source = "Auto Discovery") {
  const lines = htmlToLines(html);
  const text = lines.join("\n");
  const patterns = [
    // Known high-signal events.
    {
      type: "official_event",
      re: /\bDr\.?\s*Scramble['’]s\s+Revenge\b[^\n]{0,360}/i
    },
    {
      type: "official_event",
      re: /\bDr\.?\s*Scramble\b[^\n]{0,260}\b(?:final\s+showdown|much\s+bigger|targets?\s+Ben)\b[^\n]{0,260}/i
    },
    {
      type: "experiment_event",
      re: /\b(?:Forbidden\s+Experiment|Experiment\s+Shop|Samples)\b[^\n]{0,260}/i
    },
    {
      type: "limited_event",
      re: /\bSAMMY\s+IS\s+COMING\b[^\n]{0,220}/i
    },
    {
      type: "limited_event",
      re: /\bAngels?\s*(?:vs|and)\s*Demons?\b[^\n]{0,220}/i
    },
    {
      type: "rift_event",
      re: /\bRifts?\b[^\n]{0,180}(?:every\s+30|Overlord|Boss\s+Tokens?)[^\n]{0,180}/i
    },
    {
      type: "game_update",
      re: /\bUpdate\s*#?\s*\d+\b[^\n]{0,220}/i
    }
  ];

  const found = [];

  // Generic event discovery: catch genuinely new event names without treating
  // normal updates, patches, bug fixes, or changelog headings as events.
  const ignoredEventWords =
    /\b(?:update|version|patch|hotfix|bug\s*fix|bugfix|changelog|release\s*notes?|fixes?|improvements?|performance|maintenance)\b/i;
  const genericEventLine =
    /\b(?:event|festival|invasion|hunt|celebration|parade|takeover|showdown|war|vs\.?|season)\b/i;

  for (const line of lines) {
    const candidate = cleanText(line);
    if (
      !candidate ||
      candidate.length < 5 ||
      candidate.length > 180 ||
      ignoredEventWords.test(candidate) ||
      !genericEventLine.test(candidate) ||
      /^https?:\/\//i.test(candidate)
    ) {
      continue;
    }

    const title = candidate
      .replace(/^[•\-*–—:|\s]+/, "")
      .replace(/[|:]+$/, "")
      .trim();

    if (!title || /^event$/i.test(title) || /^events$/i.test(title)) continue;

    found.push({
      type: "generic_event_hint",
      title: title.slice(0, 200),
      description: title.slice(0, 800),
      date: parseDateText(title),
      source: String(source || "Auto Discovery").slice(0, 120)
    });
  }

  for (const pattern of patterns) {
    const match = text.match(pattern.re);
    if (!match?.[0]) continue;

    const snippet = cleanText(match[0]);

    found.push({
      type: pattern.type,
      title: snippet.slice(0, 200),
      description: snippet.slice(0, 800),
      date: parseDateText(snippet),
      source: String(source || "Auto Discovery").slice(0, 120)
    });
  }

  return dedupeEvents(found);
}

function dedupeEvents(items) {
  const map = new Map();

  for (const item of items || []) {
    if (!item?.title) continue;

    const key = [
      cleanText(item.type || "event").toLowerCase(),
      cleanText(item.title).toLowerCase(),
      item.date || ""
    ].join("|");

    if (!map.has(key)) {
      map.set(key, item);
    }
  }

  return [...map.values()];
}

function allowedDiscoveryHosts(baseUrl) {
  const hosts = new Set();

  try {
    hosts.add(new URL(baseUrl).hostname.toLowerCase());
  } catch {}

  for (const host of String(process.env.DISCOVERY_ALLOWED_HOSTS || "")
    .split(",")
    .map(value => value.trim().toLowerCase())
    .filter(Boolean)) {
    hosts.add(host);
  }

  return hosts;
}

export function extractRelevantLinks(html, baseUrl, maxLinks = 4) {
  const found = [];
  const seen = new Set();

  for (const match of String(html || "").matchAll(
    /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
  )) {
    const href = cleanText(match[1]);
    const label = cleanText(
      match[2].replace(/<[^>]+>/g, " ")
    );

    if (!href) continue;

    try {
      const url = new URL(href, baseUrl).href;
      const parsed = new URL(url);

      if (!/^https?:$/i.test(parsed.protocol)) continue;
      if (!allowedDiscoveryHosts(baseUrl).has(parsed.hostname.toLowerCase())) continue;

      const lower = (url + " " + label).toLowerCase();

      if (!/(update|event|scramble|rift|darkness|angel|demon|news|experiment)/i.test(lower)) {
        continue;
      }

      if (seen.has(url)) continue;

      seen.add(url);

      found.push({
        url,
        label: label.slice(0, 160),
        score:
          (/(update|news)/i.test(lower) ? 4 : 0) +
          (/(event|scramble|rift|experiment)/i.test(lower) ? 2 : 0)
      });
    } catch {
      // Ignore malformed URLs.
    }

    if (found.length >= maxLinks * 3) break;
  }

  return found
    .sort((a, b) => b.score - a.score)
    .slice(0, maxLinks);
}

export function discoveryFingerprint(snapshot) {
  if (!snapshot) return "";

  const number = Number.isFinite(snapshot.updateNumber)
    ? "u" + snapshot.updateNumber
    : "";

  const date = snapshot.date || "";
  const title = cleanText(snapshot.title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return [number, date, title].filter(Boolean).join("|");
}

export function chooseBestUpdate(snapshots, sourceRanks = {}) {
  const valid = (snapshots || []).filter(item => item?.title);
  if (!valid.length) return null;

  const groups = new Map();

  for (const item of valid) {
    const number = Number.isFinite(item.updateNumber)
      ? item.updateNumber
      : -1;

    const title = cleanText(item.title)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    const key = [number, title].join("|");

    if (!groups.has(key)) {
      groups.set(key, []);
    }

    groups.get(key).push(item);
  }

  const candidates = [...groups.values()].map(items => {
    const sourceSet = new Set(
      items.map(item => item.source || "unknown")
    );

    const maxRank = Math.max(
      ...items.map(item => Number(sourceRanks[item.source] || 0)),
      0
    );

    const newestDate = items
      .map(item => item.date || "")
      .sort()
      .pop() || "";

    const selected = [...items].sort(
      (a, b) =>
        Number(sourceRanks[b.source] || 0) -
        Number(sourceRanks[a.source] || 0)
    )[0];

    return {
      item: selected,
      sourceCount: sourceSet.size,
      confidence: sourceConfidenceScore(maxRank, sourceSet.size),
      maxRank,
      newestDate
    };
  });

  candidates.sort((a, b) => {
    const aNumber = Number.isFinite(a.item.updateNumber)
      ? a.item.updateNumber
      : -1;
    const bNumber = Number.isFinite(b.item.updateNumber)
      ? b.item.updateNumber
      : -1;

    if (bNumber !== aNumber) return bNumber - aNumber;
    if (b.sourceCount !== a.sourceCount) return b.sourceCount - a.sourceCount;
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    if (b.maxRank !== a.maxRank) return b.maxRank - a.maxRank;

    return b.newestDate.localeCompare(a.newestDate);
  });

  const best = candidates[0]?.item;
  if (!best) return null;

  return {
    ...best,
    evidenceSourceCount: candidates[0].sourceCount,
    evidenceConfidence: candidates[0].confidence
  };
}
