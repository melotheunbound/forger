export type StoredRuneRollMeta = { label: string; unit: string; input_scale: number };

export type ForgeOreSlot = {
  ore: string;
  amount: number;
};

export type ForgeSelectionData = {
  ores?: Record<string, number>;
  oreSlots?: (ForgeOreSlot | null)[];
  lastSelectedOre?: string;
  currentPage?: number;
  world?: string;
  equipmentType?: string;
  category?: string;
  variant?: string;
  race?: string;
  achievement?: {
    name: string;
    stage: number;
  };
  quality?: number;
  enhancement?: number;
  /** @deprecated Legacy saved-build field; runtime input clears it. Configure Lethality through weapon rune subtraits. */
  lethality?: number;
  /** Active Berserker damage percentage supplied by equipped armor/external gear. */
  externalBerserker?: number;
  /** Source-gated weapon conditions that the user wants treated as active. */
  weaponConditions?: {
    moon_boost?: boolean;
    bulls_fury?: boolean;
    berserker?: boolean;
  };
  runes?: {
    id: string;
    name: string;
    roll: Record<string, number>;
    subtraits?: {
      subtrait: string;
      roll: Record<string, number>;
    }[];
    roll_meta?: Record<string, StoredRuneRollMeta>;
  }[];
  runeTemp?: {
    name?: string;
    id?: string;
    ranges?: Record<string, { min: number; max: number }>;
    rollFields?: {
      key: string;
      label: string;
      min: number;
      max: number;
      unit: string;
      input_scale: number;
      use_lowest?: boolean;
      source_verified?: boolean;
    }[];
  };
  equipmentRuneSlots?: number;
  mode?: 'build' | 'chances' | 'classic';
  variantWorlds?: string[];
  chancesOreTotal?: number;
};
