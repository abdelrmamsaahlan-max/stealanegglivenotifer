import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} from "discord.js";

export const EXPERIMENT_CYCLE_MINUTES = 30;
export const EXPERIMENT_ACTIVE_MINUTES = 5;
export const EXPERIMENT_ACTIVE_AREAS = "Abyss Ocean → Angels & Demons";

function clean(value) {
  return String(value ?? "")
    .replace(/<a?:\w+:\d+>/g, "")
    .replace(/\*\*/g, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\r/g, "")
    .replace(/\\n/g, "\n")
    .trim();
}

function decodeUrl(value) {
  return String(value || "")
    .replace(/\\+&/g, "&")
    .replace(/&amp;/gi, "&")
    .replace(/["')]+$/g, "");
}

function extractCustomEmojis(text) {
  return [...String(text || "").matchAll(/<(a?):([A-Za-z0-9_]+):(\d+)>/g)]
    .map(match => ({
      animated: match[1] === "a",
      name: match[2],
      id: match[3]
    }))
    .filter((item, index, all) =>
      all.findIndex(other => other.id === item.id) === index
    );
}

function extractRobloxJoinUrl(data) {
  const urls = [
    ...(Array.isArray(data?.linkUrls) ? data.linkUrls : []),
    ...([...String(data?.text || "").matchAll(
      /https?:\/\/(?:www\.)?roblox\.com\/games\/start[^\s<>")]+/gi
    )].map(match => decodeUrl(match[0])))
  ];

  return urls.find(url => /roblox\.com\/games\/start/i.test(url)) ||
    urls.find(url => /roblox\.com\/games\//i.test(url)) ||
    null;
}

function parseRelativeMinutes(text) {
  const match = String(text || "").match(
    /next\s+experiment\s+in[\s\S]{0,120}?\(\s*in\s+(\d+(?:\.\d+)?)\s*(minutes?|mins?|hours?|hrs?)\s*\)/i
  );

  if (!match) return null;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;

  const unit = match[2].toLowerCase();
  return /hour|hr/.test(unit) ? amount * 60 : amount;
}

export function parseExperimentAlert(data) {
  const text = clean(data?.text);
  const lower = text.toLowerCase();

  const appeared =
    /\b(?:a\s+)?forbidden\s+experiment\s+has\s+appeared\b/i.test(text) ||
    /\bdr\.?\s*scramble\s+experiment\s+has\s+appeared\b/i.test(text) ||
    (/\bforbidden\s+experiment\b/i.test(text) && /\bappeared\b/i.test(text));

  if (!appeared) return null;

  const createdTimestamp = Number(data?.createdTimestamp || Date.now());
  const appearedAt = Number.isFinite(createdTimestamp)
    ? createdTimestamp
    : Date.now();

  const relativeMinutes = parseRelativeMinutes(text);
  const nextExperimentAt = appearedAt +
    (Number.isFinite(relativeMinutes)
      ? relativeMinutes
      : EXPERIMENT_CYCLE_MINUTES) * 60_000;

  return {
    type: "experiment",
    experimentName: "Dr. Scramble Experiment",
    title: "A Forbidden Experiment Has Appeared",
    appearedAt,
    nextExperimentAt,
    cycleMinutes: EXPERIMENT_CYCLE_MINUTES,
    activeMinutes: EXPERIMENT_ACTIVE_MINUTES,
    activeAreas: EXPERIMENT_ACTIVE_AREAS,
    joinUrl: extractRobloxJoinUrl(data),
    messageUrl: data?.messageUrl || null,
    authorId: data?.authorId || null,
    customEmojis: extractCustomEmojis(data?.text || "")
      .filter(emoji => /scramble|experiment|roblox|loading/i.test(emoji.name)),
    sourceText: text.slice(0, 1800),
    sourceLower: lower
  };
}

export function experimentEventKey(event) {
  const minute = Math.floor(Number(event?.appearedAt || Date.now()) / 60_000);
  return [
    "experiment",
    minute,
    String(event?.joinUrl || "").replace(/\?.*$/, "")
  ].join("|");
}

export function buildExperimentAlertEmbed(event, emojiMap = {}) {
  const scrambleEmoji = emojiMap.scramble || "🧪";
  const robloxEmoji = emojiMap.roblox || "🎮";
  const appearedUnix = Math.floor(
    Number(event?.appearedAt || Date.now()) / 1000
  );
  const nextUnix = Math.floor(
    Number(event?.nextExperimentAt || (Date.now() + 30 * 60_000)) / 1000
  );

  return new EmbedBuilder()
    .setColor(0xec4899)
    .setTitle(scrambleEmoji + "  A Forbidden Experiment Has Appeared")
    .setDescription(
      "**" + (event?.experimentName || "Dr. Scramble Experiment") +
      "** has appeared!\n\n" +
      "Get ready for the next experiment " +
      "<t:" + nextUnix + ":R>."
    )
    .addFields(
      {
        name: "🧪 Experiment",
        value: "Dr. Scramble",
        inline: true
      },
      {
        name: "⏳ Next Experiment",
        value: "<t:" + nextUnix + ":t> • <t:" + nextUnix + ":R>",
        inline: true
      },
      {
        name: "⌛ Active Window",
        value: (event?.activeMinutes || EXPERIMENT_ACTIVE_MINUTES) + " minutes",
        inline: true
      },
      {
        name: "📍 Active Areas",
        value: event?.activeAreas || EXPERIMENT_ACTIVE_AREAS,
        inline: false
      },
      {
        name: robloxEmoji + " Join Game",
        value: event?.joinUrl
          ? "[Click Here](" + event.joinUrl + ")"
          : "Join Game link not provided",
        inline: false
      }
    )
    .setFooter({
      text: "Steal An Egg • Experiment Tracker"
    })
    .setTimestamp(new Date(Number(event?.appearedAt || Date.now())));
}

export function buildExperimentActionRow(event) {
  if (!event?.joinUrl) return null;

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel("Join Game")
      .setStyle(ButtonStyle.Link)
      .setURL(event.joinUrl)
  );
}
