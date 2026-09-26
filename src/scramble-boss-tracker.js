import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";

export const SCRAMBLE_CYCLE_MINUTES = 30;
export const SCRAMBLE_ACTIVE_MINUTES = 5;

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

function extractJoinUrl(data) {
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

function parseRelativeMinutes(text) {
  const match = String(text || "").match(
    /(?:next\s+(?:boss|scramble)|next\s+(?:dr\.?\s*scramble)?\s*(?:event|cycle))[^\n]{0,140}?\(\s*in\s+(\d+(?:\.\d+)?)\s*(minutes?|mins?|hours?|hrs?)\s*\)/i
  );

  if (!match) return null;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  return /hour|hr/i.test(match[2]) ? amount * 60 : amount;
}

function findNumber(text, patterns) {
  for (const pattern of patterns) {
    const match = String(text || "").match(pattern);
    if (match?.[1] && Number.isFinite(Number(match[1]))) {
      return Number(match[1]);
    }
  }
  return null;
}

export function parseScrambleBoss(data) {
  const text = clean(data?.text);
  const fields = Array.isArray(data?.fields) ? data.fields : [];
  const combined = [
    text,
    ...fields.flatMap(field => [field?.name || "", field?.value || ""])
  ].filter(Boolean).join("\n");

  const hasDoctor = /dr\.?\s*scramble/i.test(combined);
  if (!hasDoctor) return null;

  const liveSignal =
    /(?:returns?|appeared|spawned|started|is\s+here|is\s+active|went\s+live|take(?:s)?\s+over|invades?|attacks?|boss\s+fight|defeat\s+dr\.?\s*scramble)/i
      .test(combined);

  const mechaSignal = /\bmecha\b/i.test(combined);
  const sampleSignal = /\bsamples?\b/i.test(combined);
  const bossSignal = /\bboss\b/i.test(combined);

  // Update/patch notes can mention the boss without indicating a live spawn.
  const looksLikeUpdateNotes =
    /\bupdate\s*#?\s*6\b|\bpatch\s+notes?\b|\bcoming\s+soon\b/i.test(combined);

  if (!liveSignal && !(mechaSignal && (sampleSignal || bossSignal) && !looksLikeUpdateNotes)) {
    return null;
  }

  const createdTimestamp = Number(data?.createdTimestamp || Date.now());
  const appearedAt = Number.isFinite(createdTimestamp) ? createdTimestamp : Date.now();
  const relativeMinutes = parseRelativeMinutes(combined);

  const nextAt = appearedAt +
    (Number.isFinite(relativeMinutes) ? relativeMinutes : SCRAMBLE_CYCLE_MINUTES) *
    60_000;

  const tier =
    findNumber(combined, [
      /tier\s*(?:#?\s*)?(\d+)/i,
      /milestone\s*(?:tier\s*)?(\d+)/i
    ]);

  const samples =
    findNumber(combined, [
      /(?:earned|reward|dropped|gave|got)\s*(\d+)\s*samples?/i
    ]);

  return {
    type: "scramble_boss",
    eventName: "Dr. Scramble Event — Part 2",
    title: "Dr. Scramble has returned in his Mecha!",
    appearedAt,
    nextBossAt: nextAt,
    cycleMinutes: SCRAMBLE_CYCLE_MINUTES,
    activeMinutes: SCRAMBLE_ACTIVE_MINUTES,
    tier,
    samples,
    reward: "Tier 100 → OP Eternal",
    secretDrop: "Super rare chance for the newest Divine",
    joinUrl: extractJoinUrl(data),
    messageUrl: data?.messageUrl || null,
    sourceMessageId: data?.sourceMessageId || null,
    authorId: data?.authorId || null,
    sourceText: combined.slice(0, 2200)
  };
}

export function scrambleEventKey(event) {
  const bucket = Math.floor(
    Number(event?.appearedAt || Date.now()) / (60_000)
  );
  return ["scramble", bucket, String(event?.joinUrl || "").replace(/\?.*$/, "")].join("|");
}

export function buildScrambleBossEmbed(event) {
  const appearedUnix = Math.floor(
    Number(event?.appearedAt || Date.now()) / 1000
  );
  const nextUnix = Math.floor(
    Number(event?.nextBossAt || (Date.now() + SCRAMBLE_CYCLE_MINUTES * 60_000)) / 1000
  );

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("「・DR. SCRAMBLE EVENT」")
    .setDescription(
      "🤖 **DR. SCRAMBLE IS HERE!**\n\n" +
      "Dr. Scramble has returned in his **Mecha**.\n" +
      "⚔️ Defeat him to earn **Samples** and progress through the **100-Tier Boss Milestone**."
    )
    .addFields(
      {
        name: "🧪 Event",
        value: "Dr. Scramble — Part 2",
        inline: true
      },
      {
        name: "🏆 Tier 100",
        value: "OP Eternal",
        inline: true
      },
      {
        name: "👀 Secret Drop",
        value: "Super rare newest Divine chance",
        inline: true
      },
      {
        name: "⏭️ Next Boss",
        value: "<t:" + nextUnix + ":t> (<t:" + nextUnix + ":R>)",
        inline: false
      }
    )
    .setFooter({ text: "Powered by FSMM • Steal An Egg" })
    .setTimestamp(new Date(appearedUnix * 1000));

  if (Number.isFinite(Number(event?.tier))) {
    embed.addFields({
      name: "📈 Current Tier",
      value: String(event.tier),
      inline: true
    });
  }

  if (Number.isFinite(Number(event?.samples))) {
    embed.addFields({
      name: "🧪 Samples",
      value: String(event.samples),
      inline: true
    });
  }

  return embed;
}

export function buildScrambleActionRow(event) {
  if (!event?.joinUrl) return null;

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel("Join Game")
      .setStyle(ButtonStyle.Link)
      .setURL(event.joinUrl)
  );
}
