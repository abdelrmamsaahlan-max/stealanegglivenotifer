export const SUPPORTED_RARITIES = [
  "Common", "Uncommon", "Rare", "Epic", "Legendary",
  "Mythic", "Cosmic", "Secret", "Eternal", "Divine"
] as const;
export type Rarity = typeof SUPPORTED_RARITIES[number];

export type Confidence = "live" | "observed" | "prediction" | "static";

export interface NormalizedEggEvent {
  eventId: string; game: "steal-an-egg"; placeId: string; universeId: string;
  source: string; sourceConfidence: Confidence; eggName: string; displayName: string;
  rarity: Rarity; biome?: string; serverJobId?: string; spawnedAt: string;
  receivedAt: string; rawEvent: Record<string, unknown>; eventFingerprint: string;
  sourceEventId?: string; observedBy: string[];
}
export interface SourceStatus {
  sourceName: string; sourceType: string; connected: boolean;
  lastHeartbeat: string | null; lastEventTime: string | null; latencyMs: number | null;
  confidence: Confidence; errorState: string | null; eventsReceived: number;
  eventsAccepted: number; eventsRejected: number;
}
export interface ParsedCandidate {
  eggName: string; displayName: string; rarity: Rarity; biome?: string;
  serverJobId?: string; spawnedAt: string; sourceEventId?: string;
  sourceConfidence: Confidence; eventId?: string; rawEvent: Record<string, unknown>;
}
export interface SourceAdapter { readonly status: SourceStatus; start(): Promise<void>; stop(): Promise<void>; ingest?(payload: unknown, metadata?: Record<string, unknown>): Promise<void>; }
export interface AlertConfig {
  mode: "all" | "rare" | "secret" | "eternal" | "divine" | "specific" | "off";
  allowedRarities: Rarity[]; blockedRarities: Rarity[]; allowedEggs: string[]; blockedEggs: string[];
  channelId: string; mentionEnabled: boolean; roleByRarity: Partial<Record<Rarity, string>>;
}