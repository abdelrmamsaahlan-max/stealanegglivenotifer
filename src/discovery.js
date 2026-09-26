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

  const long = raw.match(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?[,]?\s+(20\d{2})\b/i);
  if (long) {
    const month = MONTHS[long[1].slice(0, 3).toLowerCase()];
    const date = new Date(Date.UTC(Number(long[3]), month, Number(long[2])));
    return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
  }

  const slash = raw.match(/\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/);
  if (slash) {
    const date = new Date(Date.UTC(Number(slash[3]), Number(slash[1]) - 1, Number(slash[2])));
    return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
  }

  const iso = raw.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  return iso ? iso[1] : null;
}

function extractUpdateNumber(text) {
  const match = cleanText(text).match(/\b(?:update|version)\s*#?\s*(\d{1,3})\b/i);
  return match ? Number(match[1]) : null;
}

export function extractSupportedEggsFromDiscovery(html) {
  const lines = htmlToLines(html);
  const found = [];
  let rarity = "";

  for (const line of lines) {
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

    const name = cleanText(match[1]).replace(/\s+Egg$/i, "").trim();
    if (!name || name.length > 90) continue;

    found.push({
      eggName: name + " Egg",
      rarity,
      area: match[2]
    });
  }

  return dedupeEggs(found);
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
  return Math.min(99, Math.round(35 + rank * 4 + Math.min(3, count - 1) * 10));
}

export function calculateEvidenceConfidence(observations = []) {
  const valid = observations.filter(item => item?.name || item?.source);
  if (!valid.length) return 0;

  const uniqueSources = new Map();
  for (const item of valid) {
    const key = item.sourceKey || item.source || "unknown";
    const current = uniqueSources.get(key);
    const rank = Number(item.sourceRank || 0);
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

  for (const item of observations) {
    if (!item?.eggName || !item?.rarity) continue;

    const key =
      cleanText(item.rarity).toLowerCase() +
      "|" +
      normalizeDiscoveryEggName(item.eggName);

    if (!groups.has(key)) groups.set(key, []);
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

  for (const item of items) {
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

function dedupeEggs(items) {

  for (const item of items || []) {
    if (!item?.eggName || !item?.rarity) continue;

    const key = [
      cleanText(item.rarity).toLowerCase(),
      cleanText(item.eggName).toLowerCase()
    ].join("|");

    if (!map.has(key)) map.set(key, item);
  }

  return [...map.values()];
}

export function extractUpdateSnapshot(html, source = "Auto Discovery") {
  const lines = htmlToLines(html);
  const rawText = lines.join("\n");
  if (!lines.length) return null;

  let index = lines.findIndex(line =>
    /^(?:latest update|game update|what's new|whats new)$/i.test(line)
  );

  let title = null;
  let description = "";
  let updateNumber = null;
  let date = null;

  const updateHeaderIndex = lines.findIndex(line => /\b(?:update|version)\s*#?\s*\d{1,3}\b/i.test(line));

  if (updateHeaderIndex >= 0) {
    const header = lines[updateHeaderIndex];
    updateNumber = extractUpdateNumber(header);
    date = parseDateText(header);

    const candidates = lines.slice(updateHeaderIndex + 1, updateHeaderIndex + 5)
      .filter(line =>
        !/^dr\.?.*$/i.test(line) ||
        /scramble/i.test(line)
      )
      .filter(line =>
        !/^\d{1,2}[:.]\d{2}/.test(line) &&
        !/^update\b/i.test(line)
      );

    title =
      candidates.find(line =>
        /dr\.?.*scramble|angels?.*demons?|rifts?|cherry blossom|titan temple|sammy|event/i.test(line)
      ) ||
      candidates[0] ||
      header;
  }

  if (!title && index >= 0) {
    const window = lines.slice(index, index + 20);
    const titleIndex = window.findIndex((line, offset) =>
      offset > 0 &&
      /(?:update|scramble|angels|demons|rift|event|egg|sammy)/i.test(line)
    );

    if (titleIndex >= 0) {
      title = window[titleIndex];
      updateNumber = extractUpdateNumber(window.join(" "));
      date = parseDateText(window.join(" "));
    }
  }

  if (!title) {
    const fallback = lines.find(line =>
      /^update\s*#?\d+/i.test(line) ||
      /^(?:dr\.?\s*scramble|angels?\s*(?:vs|and)\s*demons?|the rifts?)$/i.test(line)
    );

    if (fallback) {
      title = fallback;
      updateNumber = extractUpdateNumber(fallback);
      date = parseDateText(fallback);
    }
  }

  if (!title || title.length < 2) return null;

  const titleIndex = lines.indexOf(title);
  const nearby = lines.slice(Math.max(0, titleIndex), Math.max(0, titleIndex) + 8);

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
  const found = [];

  const patterns = [
    {
      type: "official_event",
      re: /\bDr\.?\s*Scramble['’]s\s+Revenge\b[^\n]{0,260}/i
    },
    {
      type: "experiment_event",
      re: /\b(?:Dr\.?\s*Scramble|Forbidden\s+Experiment|Experiment\s+Shop|Samples)\b[^\n]{0,260}/i
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

  const text = lines.join("\n");

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

    if (!map.has(key)) map.set(key, item);
  }

  return [...map.values()];
}

const ALLOWED_DISCOVERY_HOSTS = new Set([
  "roblox.com",
  "www.roblox.com",
  "robloxstealanegg.wiki",
  "eggwatcher.com",
  "eggipedia.com",
  "stealanegg.store"
]);

export function extractRelevantLinks(html, baseUrl, maxLinks = 4) {
  const found = [];
  const seen = new Set();

  for (const match of String(html || "").matchAll(
    /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
  )) {
    const href = cleanText(match[1]);
    const label = cleanText(match[2].replace(/<[^>]+>/g, " "));
    if (!href) continue;

    try {
      const url = new URL(href, baseUrl).href;
      const parsed = new URL(url);
      if (!/^https?:$/i.test(parsed.protocol)) continue;
      if (!ALLOWED_DISCOVERY_HOSTS.has(parsed.hostname.toLowerCase())) continue;

      const lower = (url + " " + label).toLowerCase();
      if (!/(update|event|scramble|rift|darkness|angel|demon|news)/i.test(lower)) continue;
      if (seen.has(url)) continue;

      seen.add(url);
      found.push({
        url,
        label: label.slice(0, 160),
        score:
          (/(update|news)/i.test(lower) ? 4 : 0) +
          (/(event|scramble|rift)/i.test(lower) ? 2 : 0)
      });
    } catch {
      // Ignore malformed links.
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
  const title = cleanText(snapshot.title).toLowerCase()
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
    const number = Number.isFinite(item.updateNumber) ? item.updateNumber : -1;
    const title = cleanText(item.title).toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const key = [number, title].join("|");

    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  const candidates = [...groups.values()].map(items => {
    const sources = new Set(
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

    return {
      item: [...items].sort((a, b) =>
        Number(sourceRanks[b.source] || 0) - Number(sourceRanks[a.source] || 0)
      )[0],
      sourceCount: sources.size,
      maxRank,
      confidence: sourceConfidenceScore(maxRank, sources.size),
      newestDate
    };
  });

  candidates.sort((a, b) => {
    const aNumber = Number.isFinite(a.item.updateNumber) ? a.item.updateNumber : -1;
    const bNumber = Number.isFinite(b.item.updateNumber) ? b.item.updateNumber : -1;

    if (bNumber !== aNumber) return bNumber - aNumber;
    if (b.sourceCount !== a.sourceCount) return b.sourceCount - a.sourceCount;
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    if (b.maxRank !== a.maxRank) return b.maxRank - a.maxRank;
    return b.newestDate.localeCompare(a.newestDate);
  });

  const best = candidates[0]?.item || null;
  if (!best) return null;

  return {
    ...best,
    evidenceSourceCount: candidates[0].sourceCount,
    evidenceConfidence: candidates[0].confidence
  };
}
