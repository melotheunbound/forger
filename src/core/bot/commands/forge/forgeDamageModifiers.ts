import { ButtonStyles, MessageComponentTypes, MessageFlags, TextStyles, type Collection } from 'discordeno';
import { RequestMethod, ResponseType, type Interaction } from 'types/types';
import { makeRequest } from 'utils/request';
import { emoji } from 'utils/markdown';
import type { ForgeSelectionData as SelectionData } from './forgeTypes';

type DamageModifierContext = {
  handlers: Collection<string, (i: Interaction) => Promise<void>>;
  selections: Collection<string, SelectionData>;
  interaction: any;
  apiHeaders: Record<string, string>;
  renderBuild: (data: SelectionData) => Promise<void>;
};

type WeaponConditionKey = 'moon_boost' | 'bulls_fury' | 'berserker';

const configuredLethalityTotal = (data: SelectionData) => {
  let total = 0;
  for (const rune of data.runes ?? []) {
    for (const subtrait of rune.subtraits ?? []) {
      const name = subtrait.subtrait.replace(/^Secondary:\s*/i, '').trim().toLowerCase();
      if (name !== 'lethality') continue;
      const value = Number(Object.values(subtrait.roll ?? {})[0] ?? 0);
      if (Number.isFinite(value)) total += value;
    }
  }
  return Math.round(total * 100) / 100;
};

const oreTraitIsActive = (data: SelectionData, oreName: string) => {
  const entries = Object.entries(data.ores ?? {});
  const total = entries.reduce((sum, [, amount]) => sum + amount, 0);
  if (total <= 0) return false;
  const amount = entries.find(([name]) => name.toLowerCase() === oreName.toLowerCase())?.[1] ?? 0;
  // Runes:GetRunesFromItem ignores an ore below 10% recipe composition.
  return amount / total >= 0.1;
};

export const getAvailableWeaponConditions = (data: SelectionData): Record<WeaponConditionKey, boolean> => ({
  // MoonBoost currently comes from Moon Stone and only exists on weapons.
  moon_boost: data.equipmentType === 'Weapon' && oreTraitIsActive(data, 'Moon Stone'),
  // Bull's Fury is a Minotaur race trait.
  bulls_fury: data.equipmentType === 'Weapon' && data.race === 'Minotaur',
  // The current weapon-rooted Berserker source is Fierce Jade. Armor/Rage Mark
  // Berserker is represented separately through externalBerserker.
  berserker: data.equipmentType === 'Weapon' && oreTraitIsActive(data, 'Fierce Jade'),
});

/**
 * Build the weapon-only runtime fields sent to the API and clean stale UI state.
 * The API repeats all source validation; this is the first guard so changing a
 * recipe/race cannot leave an impossible condition active in a draft.
 *
 * Lethality is intentionally excluded. It is a weapon rune secondary trait and
 * must be configured through the rune manager rather than as a free-form modifier.
 */
export function getWeaponRuntimeInput(data: SelectionData) {
  const available = getAvailableWeaponConditions(data);
  const externalBerserker = Math.min(200, Math.max(0, Number(data.externalBerserker ?? 0) || 0));

  // Clear legacy drafts/saved builds that may still contain the old manual value.
  data.lethality = undefined;
  data.externalBerserker = externalBerserker;
  data.weaponConditions = {
    moon_boost: Boolean(data.weaponConditions?.moon_boost && available.moon_boost),
    bulls_fury: Boolean(data.weaponConditions?.bulls_fury && available.bulls_fury),
    berserker: Boolean(data.weaponConditions?.berserker && available.berserker),
  };

  return {
    external_berserker: externalBerserker,
    conditions: { ...data.weaponConditions },
  };
}

const conditionOptions = (data: SelectionData) => {
  const available = getAvailableWeaponConditions(data);
  const options: any[] = [];

  if (available.moon_boost) {
    options.push({
      label: 'Moon Boost active',
      value: 'moon_boost',
      description: 'Night only (18:00-06:00) · requires active Moon Stone trait',
      default: Boolean(data.weaponConditions?.moon_boost),
    });
  }
  if (available.bulls_fury) {
    options.push({
      label: "Bull's Fury active",
      value: 'bulls_fury',
      description: 'At/below 50% HP · Minotaur only · +30% physical damage',
      default: Boolean(data.weaponConditions?.bulls_fury),
    });
  }
  if (available.berserker) {
    options.push({
      label: 'Weapon Berserker active',
      value: 'berserker',
      description: 'At/below 35% HP after damage · requires weapon Berserker',
      default: Boolean(data.weaponConditions?.berserker),
    });
  }

  return options;
};

const achievementLabel = (achievement: any) =>
  String(achievement.display_name ?? (achievement.trait ? `${achievement.name} · ${achievement.trait}` : achievement.name)).slice(
    0,
    100,
  );

export function registerForgeDamageModifiers({
  handlers,
  selections,
  interaction,
  apiHeaders,
  renderBuild,
}: DamageModifierContext): void {
  const userKey = () => interaction.user.id.toString();

  handlers.set('v2-modifiers', async (i) => {
    const data = selections.get(userKey());
    if (!data) return;
    getWeaponRuntimeInput(data);
    selections.set(userKey(), data);

    const available = conditionOptions(data);
    const active = available.filter((entry) => entry.default).map((entry) => entry.label);
    const lethality = configuredLethalityTotal(data);
    const damageSummary =
      data.equipmentType === 'Weapon'
        ? [
            `Lethality **${lethality > 0 ? `${lethality}% (from runes)` : 'None'}**`,
            `External active Berserker **${data.externalBerserker ?? 0}%**`,
            `Conditional states **${active.length ? active.join(', ') : 'None active'}**`,
          ].join('\n')
        : 'Damage modifiers are only used for weapon DPS calculations.';

    await i.deferEdit();
    await interaction.edit({
      components: [
        {
          type: MessageComponentTypes.Container,
          components: [
            { type: MessageComponentTypes.TextDisplay, content: '# Modifiers' },
            {
              type: MessageComponentTypes.TextDisplay,
              content: `### Build Modifiers\nRace **${data.race ?? 'None'}** · Achievement **${data.achievement ? `${data.achievement.name} ${data.achievement.stage}` : 'None'}** · Quality **${data.quality ?? 0}%** · Enhancement **+${data.enhancement ?? 0}**`,
            },
            {
              type: MessageComponentTypes.ActionRow,
              components: [
                {
                  type: MessageComponentTypes.Button,
                  customId: 'v2-build-modifiers-form',
                  label: 'Edit Build Modifiers',
                  style: ButtonStyles.Primary,
                },
              ],
            },
            ...(data.equipmentType === 'Weapon'
              ? [
                  { type: MessageComponentTypes.Separator },
                  { type: MessageComponentTypes.TextDisplay, content: `### Damage Modifiers\n${damageSummary}` },
                  {
                    type: MessageComponentTypes.ActionRow,
                    components: [
                      {
                        type: MessageComponentTypes.Button,
                        customId: 'v2-damage-modifiers-form',
                        label: 'Edit Damage Modifiers',
                        style: ButtonStyles.Primary,
                      },
                    ],
                  },
                  {
                    type: MessageComponentTypes.TextDisplay,
                    content:
                      '-# Lethality is configured in Runes. Conditional options are source-gated: Moon Boost only appears when Moon Stone contributes at least 10% of the recipe, Bull\'s Fury only appears for Minotaur, and weapon Berserker only appears when the weapon has its Berserker source.',
                  },
                ]
              : []),
            { type: MessageComponentTypes.Separator },
            {
              type: MessageComponentTypes.ActionRow,
              components: [
                {
                  type: MessageComponentTypes.Button,
                  customId: 'v2-back-build-dashboard',
                  label: 'Back to Build',
                  style: ButtonStyles.Secondary,
                },
              ],
            },
          ] as any,
        },
      ],
      flags: MessageFlags.IsComponentsV2,
    });
  });

  handlers.set('v2-build-modifiers-form', async (i) => {
    const data = selections.get(userKey());
    if (!data) return;
    const [races, achievements] = await Promise.all([
      makeRequest('http://localhost:9999/races', {
        method: RequestMethod.GET,
        response: ResponseType.JSON,
        headers: apiHeaders,
      }),
      makeRequest('http://localhost:9999/achievements', {
        method: RequestMethod.GET,
        response: ResponseType.JSON,
        headers: apiHeaders,
      }),
    ]);

    // Reuse the original submit handler so existing build-modifier behavior stays unchanged.
    await i.respond({
      customId: 'v2-modifiers-submit',
      title: 'Build Modifiers',
      components: [
        {
          type: MessageComponentTypes.Label,
          label: 'Race',
          component: {
            type: MessageComponentTypes.StringSelect,
            customId: 'v2-race',
            placeholder: data.race ?? 'No race selected',
            options: [
              { label: 'None', value: '__none__' },
              ...races
                .slice(0, 24)
                .map((race: any) => ({ label: race.name, value: race.name, description: race.rarity })),
            ],
            required: false,
          },
        },
        {
          type: MessageComponentTypes.Label,
          label: 'Achievement',
          component: {
            type: MessageComponentTypes.StringSelect,
            customId: 'v2-achievement',
            placeholder: data.achievement?.name ?? 'No achievement selected',
            options: [
              { label: 'None', value: '__none__' },
              ...achievements.slice(0, 24).map((achievement: any) => ({
                label: achievementLabel(achievement),
                value: achievement.name,
                description: achievement.type ? String(achievement.type).slice(0, 100) : undefined,
              })),
            ],
            required: false,
          },
        },
        {
          type: MessageComponentTypes.Label,
          label: 'Achievement stage (1-5)',
          component: {
            type: MessageComponentTypes.TextInput,
            customId: 'v2-achievement-stage',
            placeholder: data.achievement
              ? String(data.achievement.stage)
              : 'Only needed if an achievement is selected',
            style: TextStyles.Short,
            required: false,
          },
        },
        {
          type: MessageComponentTypes.Label,
          label: 'Forge quality (0-100)',
          component: {
            type: MessageComponentTypes.TextInput,
            customId: 'v2-quality',
            placeholder: String(data.quality ?? 0),
            style: TextStyles.Short,
            required: false,
          },
        },
        {
          type: MessageComponentTypes.Label,
          label: 'Enhancement (+0 to +9)',
          component: {
            type: MessageComponentTypes.TextInput,
            customId: 'v2-enhancement',
            placeholder: String(data.enhancement ?? 0),
            style: TextStyles.Short,
            required: false,
          },
        },
      ],
    });
  });

  handlers.set('v2-damage-modifiers-form', async (i) => {
    const data = selections.get(userKey());
    if (!data || data.equipmentType !== 'Weapon') return;
    getWeaponRuntimeInput(data);
    const options = conditionOptions(data);

    const components: any[] = [
      {
        type: MessageComponentTypes.Label,
        label: 'External active Berserker (0-200%)',
        description: 'For Berserker supplied by equipped armor or other gear. Weapon-rune Lethality is set in Runes.',
        component: {
          type: MessageComponentTypes.TextInput,
          customId: 'v2-damage-external-berserker',
          value: String(data.externalBerserker ?? 0),
          placeholder: '0',
          style: TextStyles.Short,
          required: false,
        },
      },
    ];

    if (options.length) {
      components.push({
        type: MessageComponentTypes.Label,
        label: 'Active conditional traits',
        description: 'Only conditions this exact weapon build can own are listed.',
        component: {
          type: MessageComponentTypes.StringSelect,
          customId: 'v2-damage-conditions',
          placeholder: 'Select active conditions',
          options,
          minValues: 0,
          maxValues: options.length,
          required: false,
        },
      });
    }

    await i.respond({
      customId: 'v2-damage-modifiers-submit',
      title: 'Damage Modifiers',
      components,
    });
  });

  handlers.set('v2-damage-modifiers-submit', async (i) => {
    const data = selections.get(userKey());
    if (!data || data.equipmentType !== 'Weapon') return;
    const components = i.data?.components ?? [];
    const byId = (id: string) => components.find((entry: any) => entry.component?.customId === id)?.component;

    const berserkerRaw = String(byId('v2-damage-external-berserker')?.value ?? '').trim();
    const externalBerserker = berserkerRaw === '' ? 0 : Number(berserkerRaw);

    if (!Number.isFinite(externalBerserker) || externalBerserker < 0 || externalBerserker > 200) {
      await i.respond({
        components: [
          {
            type: MessageComponentTypes.Container,
            components: [
              {
                type: MessageComponentTypes.TextDisplay,
                content: `${emoji('Wrong')} External Berserker must be between **0% and 200%**.`,
              },
            ],
          },
        ],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      return;
    }

    const available = getAvailableWeaponConditions(data);
    const selected = new Set<string>((byId('v2-damage-conditions')?.values ?? []).map(String));
    const invalid = [...selected].find((value) => !available[value as WeaponConditionKey]);
    if (invalid) {
      await i.respond({
        components: [
          {
            type: MessageComponentTypes.Container,
            components: [
              {
                type: MessageComponentTypes.TextDisplay,
                content: `${emoji('Wrong')} That conditional trait is no longer available on this build. Re-open Damage Modifiers after changing the recipe/race.`,
              },
            ],
          },
        ],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      return;
    }

    data.lethality = undefined;
    data.externalBerserker = externalBerserker;
    data.weaponConditions = {
      moon_boost: selected.has('moon_boost'),
      bulls_fury: selected.has('bulls_fury'),
      berserker: selected.has('berserker'),
    };
    getWeaponRuntimeInput(data);
    selections.set(userKey(), data);

    await i.deferEdit();
    await renderBuild(data);
  });
}
