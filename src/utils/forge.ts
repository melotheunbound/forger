export function parseForgeOreAmount(input: unknown): number | undefined {
  if (typeof input !== 'string' || input.trim() === '') return undefined;

  const amount = Number(input);
  return Number.isSafeInteger(amount) && amount >= 0 ? amount : undefined;
}

export function createForgeQualityInput(craftQuality: number | undefined): { craft_quality?: number } {
  return craftQuality === undefined ? {} : { craft_quality: craftQuality };
}

export type ForgeRecipeParseResult =
  | { ok: true; ores: Record<string, number>; total: number }
  | { ok: false; error: string };

function normalizeOreLookup(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function resolveOreName(input: string, oreNames: readonly string[]): string | undefined {
  const normalized = normalizeOreLookup(input);
  if (!normalized) return undefined;

  const exact = oreNames.find((ore) => normalizeOreLookup(ore) === normalized);
  if (exact) return exact;

  // Convenience for common shorthand such as "gala" -> "Galaxite". Only
  // accept a prefix when it uniquely identifies an ore so we never silently
  // select the wrong material.
  const prefixMatches = oreNames.filter((ore) => normalizeOreLookup(ore).startsWith(normalized));
  return prefixMatches.length === 1 ? prefixMatches[0] : undefined;
}

/**
 * Parses a compact forge recipe from a Discord modal.
 *
 * Accepted examples:
 *   10 Galaxite, 5 Darkryte
 *   10x Galaxite + 5x Darkryte
 *   Galaxite: 10\nDarkryte: 5
 *   Galaxite 10, Darkryte 5
 */
export function parseForgeRecipeInput(input: unknown, oreNames: readonly string[]): ForgeRecipeParseResult {
  if (typeof input !== 'string' || input.trim() === '') {
    return { ok: false, error: 'Enter at least one ore.' };
  }

  const chunks = input
    .split(/[,+;\n]+/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (chunks.length === 0) return { ok: false, error: 'Enter at least one ore.' };

  const ores: Record<string, number> = {};

  for (const chunk of chunks) {
    let amountRaw: string | undefined;
    let oreRaw: string | undefined;

    // 10 Galaxite / 10x Galaxite / 10 x Galaxite
    let match = chunk.match(/^(\d+)\s*(?:x\s*)?(.+?)$/i);
    if (match) {
      amountRaw = match[1];
      oreRaw = match[2];
    } else {
      // Galaxite: 10 / Galaxite x10 / Galaxite 10
      match = chunk.match(/^(.+?)(?:\s*[:=]\s*|\s+x?\s*)(\d+)$/i);
      if (match) {
        oreRaw = match[1];
        amountRaw = match[2];
      }
    }

    const amount = amountRaw === undefined ? undefined : Number(amountRaw);
    if (!oreRaw || !Number.isSafeInteger(amount) || Number(amount) <= 0) {
      return {
        ok: false,
        error: `Could not read \"${chunk}\". Try formats like \"10 Galaxite\" or \"Galaxite: 10\".`,
      };
    }

    const canonicalOre = resolveOreName(oreRaw, oreNames);
    if (!canonicalOre) {
      return {
        ok: false,
        error: `Unknown or ambiguous ore \"${oreRaw.trim()}\". Use a little more of the ore name.`,
      };
    }

    ores[canonicalOre] = (ores[canonicalOre] ?? 0) + Number(amount);
  }

  const oreEntries = Object.entries(ores);
  if (oreEntries.length > 4) {
    return { ok: false, error: 'A forge recipe can contain at most 4 different ores.' };
  }

  const total = oreEntries.reduce((sum, [, amount]) => sum + amount, 0);
  if (total < 3) {
    return { ok: false, error: 'A forge recipe needs at least 3 total ores.' };
  }

  return { ok: true, ores, total };
}

export function formatForgeRecipe(ores: Record<string, number> | undefined): string {
  const entries = Object.entries(ores ?? {});
  if (entries.length === 0) return 'No recipe selected';

  return entries.map(([ore, amount]) => `${amount} ${ore}`).join(', ');
}
