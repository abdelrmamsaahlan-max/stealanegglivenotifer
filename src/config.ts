import "dotenv/config";
function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}
function int(name: string, fallback: number): number {
  const v = Number(process.env[name]); return Number.isFinite(v) ? v : fallback;
}
export const CONFIG = {
  nodeEnv: process.env.NODE_ENV ?? "development", port: int("PORT", 3000),
  dbPath: process.env.DATABASE_PATH ?? "./data/notifier.db",
  discordToken: process.env.DISCORD_BOT_TOKEN?.trim() ?? "",
  discordApplicationId: process.env.DISCORD_APPLICATION_ID?.trim() ?? "",
  discordDefaultChannelId: process.env.DISCORD_DEFAULT_CHANNEL_ID?.trim() ?? "",
  discordDevGuildId: process.env.DISCORD_DEV_GUILD_ID?.trim() ?? "",
  ingestSecret: required("INGEST_SHARED_SECRET"),
  ingestMaxSkewSeconds: int("INGEST_MAX_SKEW_SECONDS", 60),
  ingestRateLimitPerMinute: int("INGEST_RATE_LIMIT_PER_MINUTE", 120),
  liveFeedUrl: process.env.LIVE_FEED_URL?.trim() ?? "", liveFeedName: process.env.LIVE_FEED_NAME?.trim() ?? "",
  liveFeedPollMs: int("LIVE_FEED_POLL_MS", 1000), liveFeedTimeoutMs: int("LIVE_FEED_TIMEOUT_MS", 5000),
  liveFeedAuthHeader: process.env.LIVE_FEED_AUTH_HEADER?.trim() ?? "", liveFeedAuthValue: process.env.LIVE_FEED_AUTH_VALUE?.trim() ?? "",
  discordSourceChannelIds: (process.env.DISCORD_SOURCE_CHANNEL_IDS ?? "").split(",").map(v => v.trim()).filter(Boolean),
  discordSourceName: process.env.DISCORD_SOURCE_NAME?.trim() ?? "Discord Live Feed",
  discordSourceBotIds: (process.env.DISCORD_SOURCE_BOT_IDS ?? "").split(",").map(v => v.trim()).filter(Boolean),
  retentionDays: int("EVENT_RETENTION_DAYS", 30), dedupWindowSeconds: int("DEDUP_WINDOW_SECONDS", 60),
  sourceStaleAfterSeconds: int("SOURCE_STALE_AFTER_SECONDS", 180)
};
export function assertDiscordConfig(): void {
  if (!CONFIG.discordToken || !CONFIG.discordApplicationId) throw new Error("DISCORD_BOT_TOKEN and DISCORD_APPLICATION_ID are required to run the Discord bot.");
}