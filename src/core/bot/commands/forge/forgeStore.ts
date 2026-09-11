import { randomUUID } from 'crypto';
import { redis } from 'utils/redis';
import type { ForgeSelectionData } from './forgeTypes';

export type SavedForgeBuild = {
  id: string;
  name: string;
  savedAt: string;
  data: ForgeSelectionData;
};

const MAX_SAVED_BUILDS = 10;
const keyFor = (userId: string) => `forge:saved-builds:${userId}`;
const draftKeyFor = (userId: string) => `forge:draft:${userId}`;
const profileKeyFor = (userId: string) => `forge:profile:${userId}`;

function snapshotBuild(data: ForgeSelectionData): ForgeSelectionData {
  return {
    mode: 'build',
    ores: data.ores ? { ...data.ores } : undefined,
    oreSlots: data.oreSlots?.map((slot) => (slot ? { ...slot } : null)),
    world: data.world,
    equipmentType: data.equipmentType,
    category: data.category,
    variant: data.variant,
    race: data.race,
    achievement: data.achievement ? { ...data.achievement } : undefined,
    quality: data.quality,
    enhancement: data.enhancement,
    lethality: data.lethality,
    externalBerserker: data.externalBerserker,
    weaponConditions: data.weaponConditions ? { ...data.weaponConditions } : undefined,
    runes: data.runes ? structuredClone(data.runes) : undefined,
    equipmentRuneSlots: data.equipmentRuneSlots,
    variantWorlds: data.variantWorlds ? [...data.variantWorlds] : undefined,
  };
}

export async function listSavedForgeBuilds(userId: string): Promise<SavedForgeBuild[]> {
  const raw = await redis.hGetAll(keyFor(userId));
  return Object.values(raw)
    .map((value) => {
      try {
        return JSON.parse(value) as SavedForgeBuild;
      } catch {
        return undefined;
      }
    })
    .filter((entry): entry is SavedForgeBuild => Boolean(entry?.id && entry.name && entry.data))
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

export async function saveForgeBuild(userId: string, name: string, data: ForgeSelectionData): Promise<SavedForgeBuild> {
  const existing = await listSavedForgeBuilds(userId);
  if (existing.length >= MAX_SAVED_BUILDS) {
    throw new Error(`You can save up to ${MAX_SAVED_BUILDS} builds. Delete one before saving another.`);
  }

  const build: SavedForgeBuild = {
    id: randomUUID(),
    name: name.trim().slice(0, 60),
    savedAt: new Date().toISOString(),
    data: snapshotBuild(data),
  };
  await redis.hSet(keyFor(userId), build.id, JSON.stringify(build));
  return build;
}

export async function getSavedForgeBuild(userId: string, id: string): Promise<SavedForgeBuild | undefined> {
  const raw = await redis.hGet(keyFor(userId), id);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as SavedForgeBuild;
  } catch {
    return undefined;
  }
}

export async function deleteSavedForgeBuild(userId: string, id: string): Promise<boolean> {
  return (await redis.hDel(keyFor(userId), id)) > 0;
}

export async function saveForgeDraft(userId: string, data: ForgeSelectionData): Promise<void> {
  await redis.set(draftKeyFor(userId), JSON.stringify(snapshotBuild(data)), { EX: 24 * 60 * 60 });
}

export async function getForgeDraft(userId: string): Promise<ForgeSelectionData | undefined> {
  const raw = await redis.get(draftKeyFor(userId));
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as ForgeSelectionData;
  } catch {
    return undefined;
  }
}

export async function clearForgeDraft(userId: string): Promise<void> {
  await redis.del(draftKeyFor(userId));
}

export type ForgeProfile = {
  race?: string;
  achievement?: { name: string; stage: number };
  defaultWorld?: string;
  recentOres?: string[];
};

export async function getForgeProfile(userId: string): Promise<ForgeProfile | undefined> {
  const raw = await redis.get(profileKeyFor(userId));
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as ForgeProfile;
  } catch {
    return undefined;
  }
}

export async function saveForgeProfile(userId: string, profile: ForgeProfile): Promise<void> {
  await redis.set(profileKeyFor(userId), JSON.stringify(profile));
}
