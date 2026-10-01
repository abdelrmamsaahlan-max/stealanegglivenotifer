import "dotenv/config";
import crypto from "node:crypto";

const TOKEN = String(process.env.DISCORD_BOT_TOKEN || "").trim();
const GUILD_ID = String(process.env.GROWTH_GUILD_ID || "").trim();
const INVITE_CHANNEL_ID = String(process.env.GROWTH_INVITE_CHANNEL_ID || "").trim();
const INTERVAL_MS = Math.max(15, Number(process.env.GROWTH_INTERVAL_MINUTES || 360)) * 60_000;
const DAILY_CAP = Math.max(1, Number(process.env.GROWTH_DAILY_CAP || 4));
const CAMPAIGN_NAME = String(process.env.GROWTH_CAMPAIGN_NAME || "FSMM").trim();

function parseWebhooks() {
  try {
    const raw = JSON.parse(process.env.GROWTH_WEBHOOKS_JSON || "[]");
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(x => x && /^https:\/\/discord(?:app)?\.com\/api\/webhooks\//i.test(String(x.url || "")))
      .map(x => ({ name: String(x.name || "Partner"), url: String(x.url) }))
      .slice(0, 50);
  } catch {
    return [];
  }
}

const targets = parseWebhooks();
const sentToday = new Map();

function dayKey() {
  return new Date().toISOString().slice(0, 10);
}

function canSend(targetName) {
  const key = dayKey();
  const state = sentToday.get(key) || { total: 0, targets: new Set() };
  if (state.total >= DAILY_CAP || state.targets.has(targetName)) return false;
  state.targets.add(targetName);
  state.total++;
  sentToday.set(key, state);
  return true;
}

function makeCopy(invite) {
  const variants = [
    `Looking for an active Roblox community? **${CAMPAIGN_NAME}** is open. Trades, events, giveaways and a clean community setup — join if that's your thing.\\n\\n${invite}`,
    `Roblox players 👀 **${CAMPAIGN_NAME}** is building an active community for trading, events and gaming together.\\n\\nJoin: ${invite}`,
    `New Roblox community worth checking out: **${CAMPAIGN_NAME}**. No forced activity — just events, trading and people who actually play.\\n\\n${invite}`
  ];
  return variants[Math.floor(Math.random() * variants.length)];
}

async function discord(path, init = {}) {
  const response = await fetch("https://discord.com/api/v10" + path, {
    ...init,
    headers: {
      Authorization: `Bot ${TOKEN}`,
      "Content-Type": "application/json",
      ...(init.headers || {})
    }
  });
  if (!response.ok) throw new Error(`Discord API ${response.status}: ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}

async function getInvite() {
  if (!TOKEN || !GUILD_ID || !INVITE_CHANNEL_ID) {
    throw new Error("Missing GROWTH_GUILD_ID or GROWTH_INVITE_CHANNEL_ID.");
  }
  const invites = await discord(`/channels/${INVITE_CHANNEL_ID}/invites?limit=100`);
  const existing = Array.isArray(invites)
    ? invites.find(x => x.guild?.id === GUILD_ID && x.max_age === 0 && x.max_uses === 0)
    : null;
  if (existing?.code) return `https://discord.gg/${existing.code}`;

  const created = await discord(`/channels/${INVITE_CHANNEL_ID}/invites`, {
    method: "POST",
    body: JSON.stringify({
      max_age: 0,
      max_uses: 0,
      unique: true,
      reason: "Growth Engine campaign invite"
    })
  });
  return `https://discord.gg/${created.code}`;
}

async function postWebhook(target, content) {
  const response = await fetch(target.url + "?wait=true", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "Growth Engine",
      content,
      allowed_mentions: { parse: [] }
    })
  });
  if (!response.ok) throw new Error(`${target.name}: webhook ${response.status}`);
}

async function runCampaign() {
  if (!TOKEN || !targets.length) {
    console.log("[Growth] idle: configure DISCORD_BOT_TOKEN + GROWTH_WEBHOOKS_JSON.");
    return;
  }

  const invite = await getInvite();
  let posted = 0;

  for (const target of targets) {
    if (!canSend(target.name)) continue;
    try {
      await postWebhook(target, makeCopy(invite));
      posted++;
      console.log(`[Growth] posted campaign to approved target: ${target.name}`);
    } catch (error) {
      console.warn("[Growth] target failed:", error?.message || error);
    }
  }

  console.log(`[Growth] campaign complete: ${posted} approved targets.`);
}

console.log("[Growth] engine online.");
runCampaign().catch(error => console.error("[Growth] initial run failed:", error));
setInterval(() => runCampaign().catch(error => console.error("[Growth] run failed:", error)), INTERVAL_MS);

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
