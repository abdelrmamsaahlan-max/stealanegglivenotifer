import fs from "node:fs";
import path from "node:path";
import { SUPPORTED_RARITIES, type Rarity } from "./types.js";
interface EggRecord { eggName: string; displayName: string; rarity?: Rarity; biome?: string; aliases?: string[]; active?: boolean; image?: string; lastVerified?: string; source?: string; notes?: string; }
interface CatalogFile { eggs: EggRecord[]; rarities: string[]; schemaVersion: number; }
const filePath = path.resolve(process.cwd(), "data/eggs.json");
const raw = fs.readFileSync(filePath, "utf8"); const data = JSON.parse(raw) as CatalogFile; const eggs = data.eggs ?? [];
const norm = (v: string) => v.trim().toLowerCase().replace(/\s+/g, " ");
export function findEgg(input: string): EggRecord | null { const n = norm(input); return eggs.find(e => norm(e.eggName) === n || norm(e.displayName) === n || (e.aliases ?? []).some(a => norm(a) === n)) ?? null; }
export function findEggImage(input: string): string | null {
  const egg = findEgg(input);
  return egg?.image ?? null;
}
export function resolveRarity(value: unknown): Rarity | null { if (typeof value !== "string") return null; return SUPPORTED_RARITIES.find(r => norm(r) === norm(value)) ?? null; }
export function catalogRarities(): readonly string[] { return SUPPORTED_RARITIES; }