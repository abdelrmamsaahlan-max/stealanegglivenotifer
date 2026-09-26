import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} from "discord.js";

export const RIFT_DATA = {
  riftborn: {
    name: "Riftborn",
    eggName: "Riftborn Egg",
    rotationChance: "45%",
    pets: [
      { name: "Rift Eye", rarity: "Legendary", chance: "45%", income: "$11K/s" },
      { name: "Voidmaw", rarity: "Mythic", chance: "36%", income: "$50K/s" },
      { name: "Ventinal", rarity: "Cosmic", chance: "15%", income: "$585K/s" },
      { name: "Wendigo", rarity: "Secret", chance: "4%", income: "$15M/s" },
      { name: "World Eater", rarity: "Eternal", chance: "0.5%", income: "$500M/s" }
    ]
  },
  riftbeasts: {
    name: "Riftbeasts",
    eggName: "Riftbeasts Egg",
    rotationChance: "35%",
    pets: [
      { name: "Void Angler", rarity: "Legendary", chance: "45%", income: "$30K/s" },
      { name: "Riftwing", rarity: "Mythic", chance: "36%", income: "$220K/s" },
      { name: "Dreadclaw", rarity: "Cosmic", chance: "15%", income: "$2.2M/s" },
      { name: "Mawbreaker", rarity: "Secret", chance: "4%", income: "$60M/s" },
      { name: "Void Serpent", rarity: "Eternal", chance: "0.5%", income: "$900M/s" }
    ]
  },
  "shattered rift": {
    name: "Shattered Rift",
    eggName: "Shattered Rift Egg",
    rotationChance: "20%",
    pets: [
      { name: "Shardling", rarity: "Mythic", chance: "45%", income: "$450K/s" },
      { name: "Shattered Ram", rarity: "Cosmic", chance: "36%", income: "$8M/s" },
      { name: "Shardwing", rarity: "Secret", chance: "15%", income: "$145M/s" },
      { name: "Shattered Drake", rarity: "Eternal", chance: "4%", income: "$800M/s" },
      { name: "Shattered Colossus", rarity: "Divine", chance: "0.5%", income: "$3.5B/s" }
    ]
  }
};

function clean(value) {
  return String(value ?? "")
    .replace(/<a?:\w+:\d+>/g, "")
    .replace(/\*\*/g, "")
    .replace(/\r/g, "")
    .replace(/\\n/g, "\n")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim();
}

function normalize(value) {
  return clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toRiftKey(value) {
  const key = normalize(value);
  if (key.includes("shattered rift")) return "shattered rift";
  if (key.includes("riftbeast")) return "riftbeasts";
  if (key.includes("riftborn")) return "riftborn";
  return "";
}

function fieldValue(fields, names) {
  const wanted = names.map(normalize);
  for (const field of fields) {
    const label = normalize(field?.name);
    if (label && wanted.includes(label)) return clean(field?.value);
  }
  return "";
}

function decodeUrl(value) {
  return String(value || "")
    .replace(/\\+&/g, "&")
    .replace(/&amp;/gi, "&")
    .replace(/[\"')]+$/g, "");
}

function extractRobloxJoinUrl(data) {
  const urls = [
    ...(Array.isArray(data?.linkUrls) ? data.linkUrls : []),
    ...([...String(data?.text || "").matchAll(
      /https?:\/\/(?:www\.)?roblox\.com\/games\/start[^\s<>\")]+/gi
    )].map(match => decodeUrl(match[0])))
  ];

  return urls.find(url => /roblox\.com\/games\/start/i.test(url)) ||
    urls.find(url => /roblox\.com\/games\//i.test(url)) ||
    null;
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^()|[\]\\]/g, "\\$&");
}

function extractLabel(combined, marker) {
  const pattern = new RegExp(
    "\\b" + escapeRegExp(marker) + "\\s*[:：-]?\\s*([^\\n]+)",
    "i"
  );
  const match = combined.match(pattern);
  if (!match?.[1]) return "";

  return match[1]
    .split(/\s+(?:Next Change|Join Game|Possible Pets|Rotation Chance)\b/i)[0]
    .trim();
}

function parsePets(combined, bannerKey) {
  const known = RIFT_DATA[bannerKey]?.pets || [];

  return known.map(pet => {
    const pattern = new RegExp(
      "\\b" + escapeRegExp(pet.name) +
      "\\b[\\s\\S]{0,140}?(\\d+(?:\\.\\d+)?)%[\\s\\S]{0,50}?(\\$?[0-9.,]+\\s*[KMBT]\\s*\\/s)",
      "i"
    );

    const match = combined.match(pattern);

    return {
      ...pet,
      chance: match?.[1] ? match[1] + "%" : pet.chance,
      income: match?.[2]?.replace(/\s+/g, "") || pet.income
    };
  });
}

export function parseRiftChange(data) {
  const fields = Array.isArray(data?.fields) ? data.fields : [];
  const combined = [
    data?.text || "",
    ...fields.flatMap(field => [field?.name || "", field?.value || ""])
  ]
    .filter(Boolean)
    .join("\n");

  const lower = normalize(combined);

  const bannerMatch = combined.match(
    /\b(Riftborn|Riftbeasts|Shattered\s+Rift)\b[^\n]{0,180}?\b(?:is\s+now\s+active|is\s+active|active\s+now|went\s+live|live\s+now|became\s+active|current|selected|shifted)\b/i
  );

  const shiftedMatch = combined.match(
    /\b(?:The\s+)?Rift\s+(?:shifted|changed|switched)\b[^\n]{0,180}?\b(Riftborn|Riftbeasts|Shattered\s+Rift)\b/i
  );

  const directBanner = combined.match(/\b(Riftborn|Riftbeasts|Shattered\s+Rift)\b/i);

  // A plain mention of a Rift egg/shop item is not a rotation event.
  // Direct banner fallback requires an actual rotation/status signal.
  const rotationSignal =
    /\b(?:Changed|Change|Next\s+Change|Rotation\s+Chance|Current\s+Egg|Current\s+Rift|Active\s+Banner|Banner)\b/i.test(combined) ||
    /\b(?:is\s+now\s+active|is\s+active|active\s+now|went\s+live|live\s+now|became\s+active|selected|shifted)\b/i.test(combined);

  const bannerKey = toRiftKey(
    bannerMatch?.[1] ||
    shiftedMatch?.[1] ||
    (rotationSignal ? directBanner?.[1] : "")
  );

  const bossSignal =
    /\babyss\s+overlord\b[\s\S]{0,220}\b(?:spawned|started|open|opened|active|appeared|live)\b/i.test(lower) ||
    /\brift\s+has\s+been\s+opened\b/i.test(lower) ||
    /\bboss\s+fight\b[\s\S]{0,120}\b(?:started|live|active|opened|began)\b/i.test(lower) ||
    /\babyss\s+overlord\b/i.test(lower) && /\b(?:rift|boss|fight|active|live)\b/i.test(lower);

  if (bossSignal && !bannerKey) {
    return {
      type: "boss",
      bossName: "Abyss Overlord",
      nextChangeLabel:
        extractLabel(combined, "Next boss fight") ||
        extractLabel(combined, "Next Boss"),
      joinUrl: extractRobloxJoinUrl(data),
      createdTimestamp: Number(data?.createdTimestamp || Date.now()),
      messageUrl: data?.messageUrl || null,
      imageUrl: data?.imageUrl || null
    };
  }

  if (!bannerKey || !RIFT_DATA[bannerKey]) return null;

  return {
    type: "banner",
    bannerKey,
    bannerName: RIFT_DATA[bannerKey].name,
    eggName: RIFT_DATA[bannerKey].eggName,
    rotationChance:
      fieldValue(fields, ["Rotation Chance", "Rotation", "Chance"]) ||
      RIFT_DATA[bannerKey].rotationChance,
    changedLabel:
      fieldValue(fields, ["Changed", "Change", "Current"]) ||
      extractLabel(combined, "Changed") ||
      extractLabel(combined, "Change"),
    nextChangeLabel:
      fieldValue(fields, ["Next Change", "Next"]) ||
      extractLabel(combined, "Next Change") ||
      extractLabel(combined, "Next"),
    possiblePets: parsePets(combined, bannerKey),
    joinUrl: extractRobloxJoinUrl(data),
    createdTimestamp: Number(data?.createdTimestamp || Date.now()),
    messageUrl: data?.messageUrl || null,
    imageUrl: data?.imageUrl || null
  };
}

function petLine(pet) {
  return "**" + pet.name + "** — " + pet.chance + " • " + pet.income;
}

export function buildRiftAlertEmbed(event) {
  const data = RIFT_DATA[event?.bannerKey] || null;
  const changedUnix = Math.floor(Number(event?.createdTimestamp || Date.now()) / 1000);
  const nextUnix = Number.isFinite(event?.nextChangeAt)
    ? Math.floor(event.nextChangeAt / 1000)
    : null;

  const changed = event?.changedLabel ||
    "<t:" + changedUnix + ":t> (<t:" + changedUnix + ":R>)";

  const next = event?.nextChangeLabel ||
    (nextUnix
      ? "<t:" + nextUnix + ":t> (<t:" + nextUnix + ":R>)"
      : "Not provided");

  const pets = event?.possiblePets?.length
    ? event.possiblePets
    : (data?.pets || []);

  const description = data
    ? "🟣 **" + event.bannerName + " is Active!**\n\n" +
      "⏱️ **Changed:** " + changed +
      "    •    ⏭️ **Next Change:** " + next +
      (event?.joinUrl
        ? "\n🎮 **Join Game:** [Click Here](" + event.joinUrl + ")"
        : "")
    : "🌀 **Abyss Overlord is Active!**\n\n" +
      (event?.joinUrl
        ? "🎮 **Join Game:** [Click Here](" + event.joinUrl + ")"
        : "") +
      "\n\n⏭️ **Next Boss:** " + (event?.nextChangeLabel || "Not provided");

  const embed = new EmbedBuilder()
    .setColor(0x8b5cf6)
    .setTitle("「・RIFT EVENT」")
    .setDescription(description)
    .setTimestamp(new Date(event?.createdTimestamp || Date.now()))
    .setFooter({ text: "SenZ V2 | Steal An Egg Rift Tracker" });

  if (data && event?.rotationChance) {
    embed.addFields({
      name: "🐾 Possible Pets",
      value: pets.slice(0, 5).map(petLine).join("\n"),
      inline: false
    });
  } else if (!data) {
    embed.addFields({
      name: "⚔️ Rift Boss",
      value: "**Abyss Overlord** spawned and the boss fight is active.",
      inline: false
    });
  }

  if (event?.imageUrl) {
    embed.setImage(event.imageUrl);
  }

  return embed;
}

export function buildRiftActionRow(event) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel("Join Game")
      .setStyle(ButtonStyle.Link)
      .setURL(
        event?.joinUrl ||
        "https://www.roblox.com/games/107778070777162/Steal-An-Egg"
      )
  );
}

export function riftBannerChoices() {
  return Object.entries(RIFT_DATA).map(([value, data]) => ({
    name: data.name,
    value
  }));
}

export function getRiftData(value) {
  return RIFT_DATA[toRiftKey(value)] || null;
}
