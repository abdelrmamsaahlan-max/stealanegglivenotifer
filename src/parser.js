export function cleanText(value) {
  return String(value ?? "")
    .replace(/<a?:\w+:\d+>/g, "")
    .replace(/\*\*/g, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replaceAll(String.fromCharCode(96), "")
    .replace(/\\n/g, "\n")
    .replace(/\r/g, "")
    .trim();
}

export function normalizeLabel(value) {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function firstMeaningfulLine(value) {
  return cleanText(value).split("\n").map(v => v.trim()).find(Boolean) || "";
}

function normalizeName(value, fallback) {
  const cleaned = cleanText(value).replace(/^[\s:：\-|]+|[\s:：\-|]+$/g, "").trim();
  if (!cleaned || /^(spawned|appeared|unknown|here|now|n\/a)$/i.test(cleaned)) return fallback;
  return cleaned.slice(0, 120);
}

export function extractMessageData(message) {
  const parts = [message.content || ""];
  const fields = [];
  let imageUrl = null;

  for (const embed of message.embeds || []) {
    if (embed.title) parts.push(embed.title);
    if (embed.description) parts.push(embed.description);

    for (const field of embed.fields || []) {
      fields.push({ name: field.name || "", value: field.value || "" });
      parts.push(field.name || "", field.value || "");
    }

    if (!imageUrl && embed.image?.url) imageUrl = embed.image.url;
    if (!imageUrl && embed.thumbnail?.url) imageUrl = embed.thumbnail.url;
  }

  if (!imageUrl && message.attachments?.size) {
    const attachment = message.attachments.find(item =>
      item.contentType?.startsWith("image/") ||
      /\.(png|jpe?g|gif|webp)(?:\?|$)/i.test(item.url || "")
    );
    if (attachment) imageUrl = attachment.url;
  }

  const linkUrls = [];
  for (const row of message.components || []) {
    for (const component of row.components || []) {
      if (component.url) linkUrls.push(component.url);
    }
  }

  return {
    text: parts.filter(Boolean).join("\n"),
    fields,
    imageUrl,
    linkUrls: [...new Set(linkUrls)].slice(0, 5),
    createdTimestamp: message.createdTimestamp || Date.now(),
    messageUrl: message.url || null,
    authorId: message.author?.id || null
  };
}

export function parseSpawn(data, allowedRarities) {
  const fields = Array.isArray(data?.fields) ? data.fields : [];
  const text = cleanText(data?.text);
  const fieldMap = new Map();

  for (const field of fields) {
    const key = normalizeLabel(field.name);
    const value = firstMeaningfulLine(field.value);
    if (key && value) fieldMap.set(key, value);
  }

  const combined = [text, ...fields.flatMap(field => [field.name || "", field.value || ""])]
    .filter(Boolean)
    .join("\n");

  const rarityMatch = combined.match(/\b(secret|eternal|divine)\b/i);
  if (!rarityMatch) return null;

  const rarityKey = rarityMatch[1].toLowerCase();
  if (allowedRarities && !allowedRarities.has(rarityKey)) return null;

  const rarity = rarityKey[0].toUpperCase() + rarityKey.slice(1);

  const getField = (...names) => {
    const wantedNames = names.map(normalizeLabel);

    // Prefer exact labels first so fields like "Egg Chance" do not win over "Egg".
    for (const wanted of wantedNames) {
      for (const [key, value] of fieldMap) {
        if (key === wanted) return value;
      }
    }

    // Only use fuzzy matching for meaningful multi-word labels.
    for (const wanted of wantedNames) {
      if (wanted.length < 4) continue;
      for (const [key, value] of fieldMap) {
        if (key.startsWith(wanted + " ") || key.endsWith(" " + wanted)) return value;
      }
    }

    return "";
  };

  let eggName = getField(
    "egg",
    "egg name",
    "egg type",
    "item",
    "item name",
    "spawn",
    "spawn name"
  );

  let area = getField(
    "area",
    "location",
    "biome",
    "zone",
    "place",
    "world"
  );

  if (!eggName) {
    const eggPatterns = [
      /(?:egg|item)\s*(?:name|type)?\s*[:：\-]\s*([^\n|]+?)(?=\s+(?:in|at|on|near)\s+|[.!?]|$)/i,
      /(?:secret|eternal|divine)\s+egg\s*[:：\-]?\s*([^\n|]+?)(?=\s+(?:in|at|on|near)\s+|[.!?]|$)/i,
      /(?:secret|eternal|divine)\s+(?:egg\s+)?([^\n|]+?)\s+(?:spawned|appeared|has\s+spawned|has\s+appeared)(?=\s+(?:in|at|on|near)\s+|[.!?]|$)/i,
      /(?:spawned|appeared|has\s+spawned|has\s+appeared)\s*[:：\-]?\s*(?:the\s+)?([^\n|.!?]+?)(?=\s+(?:in|at|on|near)\s+|[.!?]|$)/i
    ];

    for (const pattern of eggPatterns) {
      const match = combined.match(pattern);
      if (match?.[1]) {
        eggName = match[1];
        break;
      }
    }
  }

  if (!area) {
    const areaPatterns = [
      /\b(?:location|area|biome|zone|place|world)\s*[:：\-]\s*([^\n|]+)/i,
      /\b(?:in|at|on|near)\s+(?:the\s+)?([^\n|.!?]+?)(?:[.!?]|$)/i
    ];

    for (const pattern of areaPatterns) {
      const match = combined.match(pattern);
      if (match?.[1]) {
        area = match[1];
        break;
      }
    }
  }

  const optional = {
    chance: getField("chance", "spawn chance"),
    speed: getField("speed", "required speed", "steal speed"),
    value: getField("value", "worth", "money", "money per second", "income per second"),
    money: getField("money", "money per second", "cash per second"),
    recommendedSpeed: getField("recommended speed", "required speed", "steal speed"),
    income: getField("income", "cash per second", "money per second"),
    mutation: getField("mutation", "mutations"),
    countdown: getField("countdown", "time left", "expires", "remaining")
  };

  eggName = normalizeName(eggName, "Unknown Egg");
  area = normalizeName(area, "Unknown");

  const compact = combined.replace(/\s+/g, " ");
  const spawnSignal = /\b(spawned|spawn|appeared|detected|found|just\s+spawned|new\s+egg|egg\s+alert|egg\s+has\s+appeared|has\s+spawned)\b/i.test(compact);
  const explicitRarityEggSignal = /\b(secret|eternal|divine)\s+egg\s*[:：\-]/i.test(compact);
  const structuredSignal = Boolean(getField("egg", "egg name", "egg type", "item", "item name"));

  if (!spawnSignal && !explicitRarityEggSignal && !structuredSignal) return null;

  const cleanedOptional = {};
  for (const [key, value] of Object.entries(optional)) {
    const cleaned = firstMeaningfulLine(value);
    if (cleaned) cleanedOptional[key] = cleaned.slice(0, 500);
  }

  return {
    live: true,
    eggName,
    displayName: eggName,
    rarity,
    biome: area,
    spawnedAt: new Date().toISOString(),
    source: "Live Spawn",
    ...cleanedOptional
  };
}
