const DEFAULT_PLACE_ID = 107778070777162;
const DEFAULT_MAX_PLAYERS = 1;
const DEFAULT_MAX_RESULTS = 50;
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 1;
const DEFAULT_DEEP_MAX_PAGES = 3;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_CACHE_TTL_MS = 15000;

export const SERVER_FINDER_PLACE_ID =
  Number(process.env.SERVER_FINDER_PLACE_ID || DEFAULT_PLACE_ID);

export const SERVER_FINDER_MAX_PLAYERS =
  Math.min(
    2,
    Math.max(0, Number(process.env.SERVER_FINDER_MAX_PLAYERS || DEFAULT_MAX_PLAYERS))
  );

const SERVER_API_BASE = "https://games.roblox.com/v1/games/";
const cache = new Map();
const inFlight = new Map();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeServer(item) {
  const jobId = String(item?.id || "").trim();
  const playing = Number(item?.playing);
  const maxPlayers = Number(item?.maxPlayers);

  if (!jobId) return null;
  if (!Number.isInteger(playing) || playing < 0) return null;
  if (!Number.isInteger(maxPlayers) || maxPlayers <= 0) return null;

  return { jobId, playing, maxPlayers };
}

function shuffle(items) {
  const copy = [...items];

  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }

  return copy;
}

function rankServers(items) {
  const ordered = [...items].sort((a, b) => {
    if (a.playing !== b.playing) return a.playing - b.playing;
    return a.jobId.localeCompare(b.jobId);
  });

  const zeroPlayer = ordered.filter(server => server.playing === 0);
  const oneOrMore = ordered.filter(server => server.playing > 0);

  return shuffle(zeroPlayer).concat(shuffle(oneOrMore));
}

async function fetchServerPage(url, timeoutMs = DEFAULT_TIMEOUT_MS) {
  let lastError = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "User-Agent": "StealAnEggServerFinder/1.1"
        },
        signal: controller.signal
      });

      if (response.ok) {
        const body = await response.json();

        if (!body || !Array.isArray(body.data)) {
          throw new Error("Invalid Roblox server list response");
        }

        return body;
      }

      if ((response.status === 429 || response.status >= 500) && attempt === 0) {
        const retryAfter = Number(response.headers.get("retry-after") || 0);

        await sleep(
          Math.min(
            2500,
            Math.max(250, retryAfter * 1000 || 500)
          )
        );

        lastError = new Error(
          "Roblox server API returned HTTP " + response.status
        );
        continue;
      }

      throw new Error("Roblox server API returned HTTP " + response.status);
    } catch (error) {
      lastError = error;

      if (attempt === 0) {
        await sleep(400);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError || new Error("Roblox server request failed");
}

function buildJoinUrl(jobId, joinBaseUrl = "") {
  const encoded = encodeURIComponent(jobId);

  if (joinBaseUrl) {
    return joinBaseUrl.replace(/\/+$/, "") + "/join?jobId=" + encoded;
  }

  return (
    "https://www.roblox.com/games/start?placeId=" +
    SERVER_FINDER_PLACE_ID +
    "&gameInstanceId=" +
    encoded
  );
}

async function scanLowPlayerServers({
  maxPlayers = SERVER_FINDER_MAX_PLAYERS,
  maxResults = DEFAULT_MAX_RESULTS,
  pageSize = DEFAULT_PAGE_SIZE,
  maxPages = DEFAULT_MAX_PAGES,
  excludeJobIds = new Set(),
  joinBaseUrl = ""
} = {}) {
  const safeMaxPlayers = Math.min(2, Math.max(0, Number(maxPlayers) || 0));
  const safeMaxResults = Math.min(
    50,
    Math.max(1, Number(maxResults) || DEFAULT_MAX_RESULTS)
  );
  const safePageSize = Math.min(
    100,
    Math.max(10, Number(pageSize) || DEFAULT_PAGE_SIZE)
  );
  const safeMaxPages = Math.min(
    12,
    Math.max(1, Number(maxPages) || DEFAULT_MAX_PAGES)
  );

  const exclusions = new Set(
    [...(excludeJobIds || [])]
      .map(value => String(value || "").trim())
      .filter(Boolean)
  );

  const found = new Map();
  let cursor = "";
  let pagesScanned = 0;

  for (
    let page = 0;
    page < safeMaxPages && found.size < safeMaxResults;
    page++
  ) {
    const params = new URLSearchParams({
      sortOrder: "Asc",
      excludeFullGames: "true",
      limit: String(safePageSize)
    });

    if (cursor) {
      params.set("cursor", cursor);
    }

    const url =
      SERVER_API_BASE +
      SERVER_FINDER_PLACE_ID +
      "/servers/Public?" +
      params.toString();

    const payload = await fetchServerPage(url);
    pagesScanned++;

    for (const raw of payload.data) {
      const server = normalizeServer(raw);

      if (!server) continue;
      if (server.playing > safeMaxPlayers) continue;
      if (server.playing >= server.maxPlayers) continue;
      if (exclusions.has(server.jobId)) continue;

      found.set(server.jobId, {
        ...server,
        joinUrl: buildJoinUrl(server.jobId, joinBaseUrl)
      });
    }

    cursor = String(payload.nextPageCursor || "");

    if (!cursor) break;
  }

  return {
    servers: rankServers([...found.values()]).slice(0, safeMaxResults),
    pagesScanned
  };
}

function mergeServerLists(primary, fallback, maxResults) {
  const byJobId = new Map();

  for (const server of [...primary, ...fallback]) {
    if (!server?.jobId || byJobId.has(server.jobId)) continue;
    byJobId.set(server.jobId, server);
  }

  return rankServers([...byJobId.values()]).slice(0, maxResults);
}

export async function findLowPlayerServers(options = {}) {
  const maxPlayers = Math.min(
    2,
    Math.max(0, Number(options.maxPlayers ?? SERVER_FINDER_MAX_PLAYERS))
  );
  const maxResults = Math.min(
    50,
    Math.max(1, Number(options.maxResults ?? DEFAULT_MAX_RESULTS))
  );
  const joinBaseUrl = String(options.joinBaseUrl || "").trim();
  const forceFresh = options.forceFresh === true;
  const excludeJobIds = new Set(
    [...(options.excludeJobIds || [])]
      .map(value => String(value || "").trim())
      .filter(Boolean)
  );
  const deepScan = options.deepScan === true || excludeJobIds.size > 0;
  const maxPages = Math.min(
    12,
    Math.max(
      1,
      Number(
        options.maxPages ??
        (deepScan ? DEFAULT_DEEP_MAX_PAGES : DEFAULT_MAX_PAGES)
      )
    )
  );

  const cacheTtlMs = Math.max(
    0,
    Number(process.env.SERVER_FINDER_CACHE_TTL_MS || DEFAULT_CACHE_TTL_MS)
  );

  // Normal /server-find requests can use the short cache. Smart refreshes
  // deliberately bypass it so a refresh is always backed by a new Roblox scan.
  const cacheKey = [
    SERVER_FINDER_PLACE_ID,
    maxPlayers,
    maxResults,
    joinBaseUrl
  ].join("|");

  if (
    !forceFresh &&
    excludeJobIds.size === 0 &&
    cacheTtlMs > 0
  ) {
    const cached = cache.get(cacheKey);

    if (cached && Date.now() - cached.at < cacheTtlMs) {
      return cached.value;
    }

    const pending = inFlight.get(cacheKey);
    if (pending) {
      return pending;
    }
  }

  const requestKey =
    cacheKey +
    "|fresh=" + String(forceFresh) +
    "|exclude=" + [...excludeJobIds].sort().join(",");

  const existingFlight = inFlight.get(requestKey);
  if (existingFlight) return existingFlight;

  const operation = (async () => {
    let fresh;
    try {
      fresh = await scanLowPlayerServers({
        ...options,
        maxPlayers,
        maxResults,
        maxPages,
        excludeJobIds,
        joinBaseUrl
      });
    } catch (error) {
      const stale = cache.get(cacheKey);
      if (
        !forceFresh &&
        excludeJobIds.size === 0 &&
        stale?.value &&
        Array.isArray(stale.value.servers) &&
        stale.value.servers.length
      ) {
        return {
          ...stale.value,
          freshScan: false,
          stale: true
        };
      }
      throw error;
    }

    let servers = fresh.servers;
    let pagesScanned = fresh.pagesScanned;

    // If the exclusion pass did not produce enough candidates, make a second,
    // deeper non-excluded scan only to fill the remaining slots. Fresh results
    // are already preferred by mergeServerLists because they are discovered first.
    if (excludeJobIds.size > 0 && servers.length < maxResults) {
      const fallbackPages = Math.min(
        12,
        Math.max(maxPages + 2, DEFAULT_DEEP_MAX_PAGES)
      );

      const fallback = await scanLowPlayerServers({
        ...options,
        maxPlayers,
        maxResults,
        maxPages: fallbackPages,
        excludeJobIds: new Set(),
        joinBaseUrl
      });

      const excluded = fallback.servers.filter(
        server => !excludeJobIds.has(server.jobId)
      );

      servers = mergeServerLists(
        servers,
        [...excluded, ...fallback.servers],
        maxResults
      );
      pagesScanned += fallback.pagesScanned;
    }

    return {
      servers,
      pagesScanned,
      freshScan: true,
      excludedCount: excludeJobIds.size
    };
  })()
    .then(value => {
      if (!forceFresh && excludeJobIds.size === 0 && cacheTtlMs > 0) {
        cache.set(cacheKey, {
          at: Date.now(),
          value
        });
      }

      return value;
    })
    .finally(() => {
      inFlight.delete(requestKey);
      if (!forceFresh && excludeJobIds.size === 0) {
        inFlight.delete(cacheKey);
      }
    });

  inFlight.set(requestKey, operation);

  if (!forceFresh && excludeJobIds.size === 0) {
    inFlight.set(cacheKey, operation);
  }

  return operation;
}
