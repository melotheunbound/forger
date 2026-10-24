import { normalizeUiText } from './forgeFormatting';

type OreView = {
  trait?: { description?: string; type?: string };
  display?: {
    weapon_traits?: string[];
    armor_traits?: string[];
    activation_note?: string;
    chance_text?: string;
    multiplier_note?: string;
    obtainment?: string;
  };
  chance?: string;
  multiplier?: string;
  price?: string | null;
  unique_price_multiplier?: string;
  neutral_multiplier?: boolean;
};

export function oreTraitText(ore: OreView): string {
  if (ore.display?.weapon_traits?.length || ore.display?.armor_traits?.length) {
    return [
      ...(ore.display.weapon_traits?.length
        ? ['**Weapon Traits**', ...ore.display.weapon_traits.map((line) => `- ${line}`)]
        : []),
      ...(ore.display.armor_traits?.length
        ? ['**Armor Traits**', ...ore.display.armor_traits.map((line) => `- ${line}`)]
        : []),
      ...(ore.display.activation_note ? [`-# ${ore.display.activation_note}`] : []),
    ].join('\n');
  }
  return ore.trait ? `> ${normalizeUiText(ore.trait.description)} (${normalizeUiText(ore.trait.type)})` : '> None';
}

export function oreInformationText(ore: OreView): string {
  const chance = ore.display?.chance_text
    ? `- Chest bonus chance: **${ore.display.chance_text}**`
    : `- Chance: **${ore.chance}**`;
  return [
    chance,
    `- ${ore.neutral_multiplier ? 'Base multiplier (neutral)' : 'Multiplier'}: **${ore.multiplier}x**`,
    ...(ore.display?.multiplier_note ? [`-# ${ore.display.multiplier_note}`] : []),
    `- Price: **${ore.price ?? 'Not available'}**`,
    ...(ore.unique_price_multiplier != null ? [`- Unique Price Multiplier: **${ore.unique_price_multiplier}x**`] : []),
  ].join('\n');
}
