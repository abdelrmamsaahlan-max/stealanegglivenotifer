const DEFAULT_PLACE_ID = 107778070777162;
const DEFAULT_MAX_PLAYERS = 1;
const DEFAULT_MAX_RESULTS = 10;
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 4;
const DEFAULT_TIMEOUT_MS = 7000;
const CACHE_TTL_MS = 5000;

export const SERVER_FINDER_PLACE_ID =
  Number(process.env.SERVER_FINDER_PLACE_ID || DEFAULT_PLACE_ID);

export const SERVER_FINDER_MAX_PLAYERS =
  Math.min(
    2,
    Math.max(0, Number(process.env.SERVER_FINDER_MAX_PLAYERS || DEFAULT_MAX_PLAYERS))
  );

const SERVER_API_BASE = "https://games.roblox.com/v1/games/";
let cachedResult = null;
let cachedAt = 0;
let cachePromise = null;

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
          "User-Agent": "StealAnEggServerFinder/1.0"
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
        await sleep(Math.min(2500, Math.max(250, retryAfter * 1000 || 500)));
        lastError = new Error("Roblox server API returned HTTP " + response.status);
        continue;
      }

      throw new Error("Roblox server API returned HTTP " + response.status);
    } catch (error) {
      lastError = error;
      if (attempt === 0) await sleep(400);
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
  joinBaseUrl = ""
} = {}) {
  const safeMaxPlayers = Math.min(2, Math.max(0, Number(maxPlayers) || 0));
  const safeMaxResults = Math.min(20, Math.max(1, Number(maxResults) || DEFAULT_MAX_RESULTS));
  const safePageSize = Math.min(100, Math.max(10, Number(pageSize) || DEFAULT_PAGE_SIZE));
  const safeMaxPages = Math.min(6, Math.max(1, Number(maxPages) || DEFAULT_MAX_PAGES));

  const found = new Map();
  let cursor = "";
  let pagesScanned = 0;

  for (let page = 0; page < safeMaxPages && found.size < safeMaxResults; page++) {
    const params = new URLSearchParams({
      sortOrder: "Asc",
      excludeFullGames: "true",
      limit: String(safePageSize)
    });

    if (cursor) params.set("cursor", cursor);

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

      found.set(server.jobId, {
        ...server,
        joinUrl: buildJoinUrl(server.jobId, joinBaseUrl)
      });
    }

    cursor = String(payload.nextPageCursor || "");
    if (!cursor) break;
  }

  const ordered = [...found.values()].sort((a, b) => {
    if (a.playing !== b.playing) return a.playing - b.playing;
    return a.jobId.localeCompare(b.jobId);
  });

  const zeroPlayer = ordered.filter(server => server.playing === 0);
  const oneOrMore = ordered.filter(server => server.playing > 0);

  return {
    servers: shuffle(zeroPlayer).concat(shuffle(oneOrMore)).slice(0, safeMaxResults),
    pagesScanned
  };
}

export async function findLowPlayerServers(options = {}) {
  const maxPlayers = Math.min(2, Math.max(0, Number(options.maxPlayers ?? SERVER_FINDER_MAX_PLAYERS)));
  const maxResults = Math.min(20, Math.max(1, Number(options.maxResults ?? DEFAULT_MAX_RESULTS)));
  const joinBaseUrl = String(options.joinBaseUrl || "").trim();

  const cacheKey = [SERVER_FINDER_PLACE_ID, maxPlayers, maxResults, joinBaseUrl].join("|");

  if (cachedResult?.key === cacheKey && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cachedResult.value;
  }

  if (cachePromise) return cachePromise;

  cachePromise = scanLowPlayerServers({
    ...options,
    maxPlayers,
    maxResults,
    joinBaseUrl
  })
    .then(value => {
      cachedResult = { key: cacheKey, value };
      cachedAt = Date.now();
      return value;
    })
    .finally(() => {
      cachePromise = null;
    });

  return cachePromise;
}
