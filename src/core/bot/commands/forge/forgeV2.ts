import { FORGER_API_KEY } from 'core/variables';
import { ButtonStyles, MessageComponentTypes, MessageFlags, TextStyles, type Collection } from 'discordeno';
import { randomUUID } from 'crypto';
import { RequestMethod, ResponseType, type Interaction } from 'types/types';
import { createForgeQualityInput, formatForgeRecipe, parseForgeRecipeInput } from 'utils/forge';
import { makeRequest } from 'utils/request';
import { emoji, highlight } from 'utils/markdown';
import { formatRenderedTrait, formatRuneRollValue, normalizeUiText } from './forgeFormatting';
import { getWeaponRuntimeInput, registerForgeDamageModifiers } from './forgeDamageModifiers';
import type { ForgeSelectionData as SelectionData, StoredRuneRollMeta } from './forgeTypes';
import {
  deleteSavedForgeBuild,
  getForgeDraft,
  getForgeProfile,
  getSavedForgeBuild,
  listSavedForgeBuilds,
  saveForgeBuild,
  saveForgeDraft,
  saveForgeProfile,
} from './forgeStore';

type OreBrowseState = {
  world: string;
  page: number;
  selectedOre?: string;
};

type ForgeV2Context = {
  handlers: Collection<string, (i: Interaction) => Promise<void>>;
  selections: Collection<string, SelectionData>;
  interaction: any;
  ores: any;
};

export function registerForgeV2({ handlers, selections, interaction, ores }: ForgeV2Context): void {
  const apiHeaders = { 'x-api-key': FORGER_API_KEY };
  const userKey = () => interaction.user.id.toString();
  const pendingRecipeAmounts = new Map<number, number>();
  const oreBrowseState = new Map<number, OreBrowseState>();
  const ORE_PAGE_SIZE = 25;
  const ALL_ORES_WORLD = '__all_ores__';
  const ORE_WORLDS = ["Stonewake's Cross", 'Forgotten Kingdom', 'Frostspire Expanse', 'Crimson Sakura'];

  const getEquipmentCatalog = async (equipmentType: string) =>
    makeRequest(equipmentType === 'Weapon' ? 'http://localhost:9999/weapons' : 'http://localhost:9999/armors', {
      method: RequestMethod.GET,
      response: ResponseType.JSON,
      headers: apiHeaders,
    });

  const getRuneSlotsForUi = (enhancement = 0) =>
    enhancement >= 9 ? 3 : enhancement >= 6 ? 2 : enhancement >= 3 ? 1 : 0;

  const friendlyRequestError = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const jsonMatch = message.match(/\{\s*"error"\s*:\s*"([^"]+)"/);
    return jsonMatch?.[1] ?? message.replace(/^Request failed \(\d+\):\s*/, '');
  };

  const buildFullBuildBody = (data: SelectionData) => {
    const common = {
      world: data.world ?? "Stonewake's Cross",
      recipe: formatForgeRecipe(data.ores),
      category: data.category,
      variant: data.variant,
      ...createForgeQualityInput(data.quality),
      enhancement: data.enhancement,
      runes: data.runes,
    };

    return data.equipmentType === 'Weapon'
      ? {
          race: data.race,
          achievement: data.achievement,
          weapon: { ...common, ...getWeaponRuntimeInput(data) },
        }
      : { race: data.race, achievement: data.achievement, armor: common };
  };

  const fetchV2Build = async (data: SelectionData) =>
    makeRequest('http://localhost:9999/forge/full-build', {
      method: RequestMethod.POST,
      response: ResponseType.JSON,
      body: buildFullBuildBody(data),
      headers: apiHeaders,
    });

  const fetchV2Chances = async (data: SelectionData) => {
    const recipeTotal = Object.values(data.ores ?? {}).reduce((sum, amount) => sum + amount, 0);
    const total = data.chancesOreTotal ?? recipeTotal;
    return makeRequest(
      data.equipmentType === 'Weapon'
        ? 'http://localhost:9999/forge/weapon-chance'
        : 'http://localhost:9999/forge/armor-chance',
      {
        method: RequestMethod.GET,
        response: ResponseType.JSON,
        params: {
          world: data.world ?? "Stonewake's Cross",
          ores_total: total.toString(),
        },
        headers: apiHeaders,
      },
    );
  };

  const recipeSummary = (data: SelectionData) => {
    const entries = Object.entries(data.ores ?? {});
    if (!entries.length) return '*No recipe selected yet.*';
    const total = entries.reduce((sum, [, amount]) => sum + amount, 0);
    return [
      `**${formatForgeRecipe(data.ores)}**`,
      entries.map(([ore, amount]) => `${ore} ${Number(((amount / total) * 100).toFixed(2))}%`).join(' · '),
      `-# ${total} total ores`,
    ].join('\n');
  };

  const ensureRecipeSlots = (data: SelectionData) => {
    if (!data.oreSlots) {
      data.oreSlots = Object.entries(data.ores ?? {})
        .slice(0, 4)
        .map(([ore, amount]) => ({ ore, amount }));
    }

    while (data.oreSlots.length < 4) data.oreSlots.push(null);
    if (data.oreSlots.length > 4) data.oreSlots = data.oreSlots.slice(0, 4);
    return data.oreSlots;
  };

  const syncRecipeFromSlots = (data: SelectionData) => {
    const next: Record<string, number> = {};
    for (const slot of ensureRecipeSlots(data)) {
      if (!slot?.ore || !Number.isSafeInteger(slot.amount) || slot.amount <= 0) continue;
      next[slot.ore] = slot.amount;
    }
    data.ores = next;
  };

  const setRecipeSlot = (data: SelectionData, slotIndex: number, ore: string, amount: number) => {
    const slots = ensureRecipeSlots(data);
    slots[slotIndex] = { ore, amount };
    syncRecipeFromSlots(data);
  };

  const clearRecipeSlot = (data: SelectionData, slotIndex: number) => {
    const slots = ensureRecipeSlots(data);
    slots[slotIndex] = null;
    syncRecipeFromSlots(data);
  };

  const duplicateOreSlot = (data: SelectionData, slotIndex: number, ore: string) =>
    ensureRecipeSlots(data).findIndex((slot, index) => index !== slotIndex && slot?.ore === ore);

  const rememberRecentOre = async (ore: string) => {
    const profile = (await getForgeProfile(userKey())) ?? {};
    profile.recentOres = [ore, ...(profile.recentOres ?? []).filter((entry) => entry !== ore)].slice(0, 20);
    await saveForgeProfile(userKey(), profile);
  };

  const oreWorlds = (ore: any) => {
    const worlds = new Set<string>();

    // The /ores collection endpoint exposes a compact worlds[] field for browsing.
    // Keep support for the full ore shape too so this remains compatible with
    // detailed ore responses and older local API builds.
    for (const world of ore.worlds ?? []) {
      if (typeof world === 'string') worlds.add(world);
    }

    for (const source of ore.from ?? []) {
      const value = source?.world;
      if (Array.isArray(value)) {
        for (const world of value) if (typeof world === 'string') worlds.add(world);
      } else if (typeof value === 'string') {
        worlds.add(value);
      }
    }
    return worlds;
  };

  const getBrowseOres = (data: SelectionData, slotIndex: number, world: string) => {
    const usedElsewhere = new Set(
      ensureRecipeSlots(data).flatMap((slot, index) => (index !== slotIndex && slot?.ore ? [slot.ore] : [])),
    );

    return (ores as any[])
      .filter((ore: any) => !usedElsewhere.has(String(ore.name)))
      .filter((ore: any) => world === ALL_ORES_WORLD || oreWorlds(ore).has(world))
      .sort((a: any, b: any) => String(a.name).localeCompare(String(b.name)));
  };

  const initialBrowseWorld = (data: SelectionData, slotIndex: number) => {
    const currentOre = ensureRecipeSlots(data)[slotIndex]?.ore;
    if (currentOre) {
      const ore = (ores as any[]).find((entry: any) => entry.name === currentOre);
      const firstWorld = ore ? [...oreWorlds(ore)].find((world) => ORE_WORLDS.includes(world)) : undefined;
      if (firstWorld) return firstWorld;
    }

    if (data.world && ORE_WORLDS.includes(data.world)) return data.world;
    return ALL_ORES_WORLD;
  };

  const getOreBrowseState = (data: SelectionData, slotIndex: number) => {
    let state = oreBrowseState.get(slotIndex);
    if (!state) {
      state = { world: initialBrowseWorld(data, slotIndex), page: 0 };
      oreBrowseState.set(slotIndex, state);
    }
    return state;
  };

  const searchOreNames = (query: string, data: SelectionData, slotIndex: number) => {
    const normalized = query.trim().toLowerCase();
    const usedElsewhere = new Set(
      ensureRecipeSlots(data).flatMap((slot, index) =>
        index !== slotIndex && slot?.ore ? [slot.ore.toLowerCase()] : [],
      ),
    );

    const availableNames: string[] = (ores as any[])
      .map((ore: any) => String(ore.name))
      .filter((name: string) => !usedElsewhere.has(name.toLowerCase()));
    const scored: ({ name: string; score: number } | undefined)[] = availableNames.map((name: string) => {
      const lower = name.toLowerCase();
      let score = 4;
      if (lower === normalized) score = 0;
      else if (lower.startsWith(normalized)) score = 1;
      else if (lower.includes(normalized)) score = 2;
      else {
        const words = lower.split(/\s+/);
        if (words.some((word) => word.startsWith(normalized))) score = 3;
        else return undefined;
      }
      return { name, score };
    });

    return scored
      .filter((entry): entry is { name: string; score: number } => Boolean(entry))
      .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name))
      .map((entry) => entry.name);
  };

  const renderV2RecipeEditor = async (data: SelectionData) => {
    const slots = ensureRecipeSlots(data);
    syncRecipeFromSlots(data);
    await saveForgeDraft(userKey(), data);
    const total = slots.reduce((sum, slot) => sum + (slot?.amount ?? 0), 0);
    const components: any[] = [
      {
        type: MessageComponentTypes.TextDisplay,
        content:
          '# Recipe\nFill up to four ore slots. Browse every ore by **World → Page → Ore**, or use search as a shortcut.',
      },
      { type: MessageComponentTypes.Separator },
    ];

    for (let index = 0; index < 4; index++) {
      const slot = slots[index];
      const percentage = slot && total > 0 ? Number(((slot.amount / total) * 100).toFixed(2)) : 0;
      components.push({
        type: MessageComponentTypes.Section,
        components: [
          {
            type: MessageComponentTypes.TextDisplay,
            content: slot
              ? `**Slot ${index + 1}**\n${slot.amount} × **${slot.ore}**${total ? ` · ${percentage}%` : ''}`
              : `**Slot ${index + 1}**\n-# Empty`,
          },
        ],
        accessory: {
          type: MessageComponentTypes.Button,
          customId: `v2-recipe-slot-${index + 1}`,
          label: slot ? 'Edit' : 'Add',
          style: slot ? ButtonStyles.Secondary : ButtonStyles.Primary,
        },
      });
    }

    components.push({ type: MessageComponentTypes.Separator });
    components.push({
      type: MessageComponentTypes.TextDisplay,
      content: `**Total:** ${total} ores${total > 0 && total < 3 ? '\n-# The game requires at least 3 total ores.' : ''}`,
    });
    components.push({
      type: MessageComponentTypes.ActionRow,
      components: [
        {
          type: MessageComponentTypes.Button,
          customId: 'v2-recipe-done',
          label: 'Done',
          style: ButtonStyles.Success,
          disabled: total < 3,
        },
        {
          type: MessageComponentTypes.Button,
          customId: 'v2-recipe-clear',
          label: 'Clear Recipe',
          style: ButtonStyles.Danger,
          disabled: total === 0,
        },
        {
          type: MessageComponentTypes.Button,
          customId: 'v2-recipe-cancel',
          label: 'Back',
          style: ButtonStyles.Secondary,
        },
      ],
    });

    await interaction.edit({
      components: [{ type: MessageComponentTypes.Container, components }],
      flags: MessageFlags.IsComponentsV2,
    });
  };

  const renderOreBrowser = async (data: SelectionData, slotIndex: number) => {
    const slot = ensureRecipeSlots(data)[slotIndex];
    const state = getOreBrowseState(data, slotIndex);
    const available = getBrowseOres(data, slotIndex, state.world);
    const pageCount = Math.max(1, Math.ceil(available.length / ORE_PAGE_SIZE));
    state.page = Math.min(Math.max(0, state.page), pageCount - 1);
    oreBrowseState.set(slotIndex, state);

    const pageStart = state.page * ORE_PAGE_SIZE;
    const pageOres = available.slice(pageStart, pageStart + ORE_PAGE_SIZE);
    const worldLabel = state.world === ALL_ORES_WORLD ? 'All Ores' : state.world;

    const worldOptions = [
      {
        label: 'All Ores',
        value: ALL_ORES_WORLD,
        description: `${getBrowseOres(data, slotIndex, ALL_ORES_WORLD).length} available ores`,
        default: state.world === ALL_ORES_WORLD,
      },
      ...ORE_WORLDS.map((world) => ({
        label: world,
        value: world,
        description: `${getBrowseOres(data, slotIndex, world).length} available ores`,
        default: state.world === world,
      })),
    ];

    const components: any[] = [
      {
        type: MessageComponentTypes.TextDisplay,
        content: `# Browse Ores · Slot ${slotIndex + 1}\nChoose a **world**, use the page buttons, then select the ore. Search is optional.\n${slot ? `\nCurrent: **${slot.amount} × ${slot.ore}**` : ''}`,
      },
      { type: MessageComponentTypes.Separator },
      {
        type: MessageComponentTypes.ActionRow,
        components: [
          {
            type: MessageComponentTypes.StringSelect,
            customId: `v2-recipe-browse-world-${slotIndex + 1}`,
            placeholder: `World: ${worldLabel}`,
            options: worldOptions,
          },
        ],
      },
      {
        type: MessageComponentTypes.ActionRow,
        components: [
          {
            type: MessageComponentTypes.Button,
            customId: `v2-recipe-browse-prev-${slotIndex + 1}`,
            label: 'Previous',
            style: ButtonStyles.Secondary,
            disabled: state.page <= 0,
          },
          {
            type: MessageComponentTypes.Button,
            customId: `v2-recipe-browse-page-label-${slotIndex + 1}`,
            label: `Page ${state.page + 1} of ${pageCount}`,
            style: ButtonStyles.Secondary,
            disabled: true,
          },
          {
            type: MessageComponentTypes.Button,
            customId: `v2-recipe-browse-next-${slotIndex + 1}`,
            label: 'Next',
            style: ButtonStyles.Secondary,
            disabled: state.page >= pageCount - 1,
          },
        ],
      },
    ];

    if (pageOres.length) {
      components.push({
        type: MessageComponentTypes.ActionRow,
        components: [
          {
            type: MessageComponentTypes.StringSelect,
            customId: `v2-recipe-browse-ore-${slotIndex + 1}`,
            placeholder: `Choose an ore · ${pageStart + 1}-${pageStart + pageOres.length} of ${available.length}`,
            options: pageOres.map((ore: any) => ({
              label: String(ore.name),
              value: String(ore.name),
              description: ore.rarity
                ? `${ore.rarity}${oreWorlds(ore).size > 1 ? ' · Multiple worlds' : ''}`
                : undefined,
              default: slot?.ore === ore.name,
            })),
          },
        ],
      });
    } else {
      components.push({
        type: MessageComponentTypes.TextDisplay,
        content: '-# No selectable ores are available in this world after excluding ores already used in other slots.',
      });
    }

    components.push({ type: MessageComponentTypes.Separator });
    components.push({
      type: MessageComponentTypes.ActionRow,
      components: [
        {
          type: MessageComponentTypes.Button,
          customId: `v2-recipe-search-${slotIndex + 1}`,
          label: 'Search Ores',
          style: ButtonStyles.Secondary,
        },
        ...(slot
          ? [
              {
                type: MessageComponentTypes.Button,
                customId: `v2-recipe-remove-${slotIndex + 1}`,
                label: 'Clear Slot',
                style: ButtonStyles.Danger,
              },
            ]
          : []),
        {
          type: MessageComponentTypes.Button,
          customId: 'v2-edit-recipe',
          label: 'Back to Recipe',
          style: ButtonStyles.Secondary,
        },
      ],
    });

    await interaction.edit({
      components: [{ type: MessageComponentTypes.Container, components }],
      flags: MessageFlags.IsComponentsV2,
    });
  };

  const showOreAmountModal = async (i: Interaction, data: SelectionData, slotIndex: number, ore: string) => {
    const slot = ensureRecipeSlots(data)[slotIndex];
    await i.respond({
      customId: `v2-recipe-browse-amount-submit-${slotIndex + 1}`,
      title: `Add ${ore}`.slice(0, 45),
      components: [
        {
          type: MessageComponentTypes.Label,
          label: 'Amount',
          description: `How many ${ore} ores are in this slot?`,
          component: {
            type: MessageComponentTypes.TextInput,
            customId: `v2-recipe-browse-amount-${slotIndex + 1}`,
            placeholder: '10',
            value: slot?.ore === ore && slot.amount ? String(slot.amount) : undefined,
            style: TextStyles.Short,
            required: true,
            maxLength: 9,
          },
        },
      ],
    });
  };

  const showOreSearchModal = async (i: Interaction, data: SelectionData, slotIndex: number) => {
    const slot = ensureRecipeSlots(data)[slotIndex];
    await i.respond({
      customId: `v2-recipe-search-submit-${slotIndex + 1}`,
      title: `Search Ore · Slot ${slotIndex + 1}`,
      components: [
        {
          type: MessageComponentTypes.Label,
          label: 'Ore name',
          description: 'Type the full name or part of it. Search is optional; browsing works without it.',
          component: {
            type: MessageComponentTypes.TextInput,
            customId: `v2-recipe-search-query-${slotIndex + 1}`,
            placeholder: 'e.g. Galaxite or gala',
            style: TextStyles.Short,
            required: true,
            maxLength: 100,
          },
        },
        {
          type: MessageComponentTypes.Label,
          label: 'Amount',
          description: 'Whole-number ore quantity for this slot.',
          component: {
            type: MessageComponentTypes.TextInput,
            customId: `v2-recipe-search-amount-${slotIndex + 1}`,
            placeholder: '10',
            value: slot?.amount ? String(slot.amount) : undefined,
            style: TextStyles.Short,
            required: true,
            maxLength: 9,
          },
        },
      ],
    });
  };

  const renderOreSearchResults = async (data: SelectionData, slotIndex: number, query: string, matches: string[]) => {
    await interaction.edit({
      components: [
        {
          type: MessageComponentTypes.Container,
          components: [
            {
              type: MessageComponentTypes.TextDisplay,
              content: `# Choose Ore · Slot ${slotIndex + 1}\nSearch: **${query}**\n-# ${matches.length > 25 ? `Showing the best 25 of ${matches.length} matches.` : `${matches.length} match${matches.length === 1 ? '' : 'es'}.`}`,
            },
            {
              type: MessageComponentTypes.ActionRow,
              components: [
                {
                  type: MessageComponentTypes.StringSelect,
                  customId: `v2-recipe-search-result-${slotIndex + 1}`,
                  placeholder: 'Choose an ore',
                  options: matches.slice(0, 25).map((name) => {
                    const ore = ores.find((entry: any) => entry.name === name);
                    return { label: name, value: name, description: ore?.rarity };
                  }),
                },
              ],
            },
            {
              type: MessageComponentTypes.ActionRow,
              components: [
                {
                  type: MessageComponentTypes.Button,
                  customId: `v2-recipe-slot-${slotIndex + 1}`,
                  label: 'Back',
                  style: ButtonStyles.Secondary,
                },
              ],
            },
          ],
        },
      ],
      flags: MessageFlags.IsComponentsV2,
    });
  };

  const renderV2BuildSetup = async (data: SelectionData) => {
    await saveForgeDraft(userKey(), data);
    const components: any[] = [
      {
        type: MessageComponentTypes.TextDisplay,
        content:
          '# Build Calculator\nChoose the item you actually want to calculate first. Your recipe and modifiers stay attached to the build while you edit it.',
      },
      { type: MessageComponentTypes.Separator },
      {
        type: MessageComponentTypes.ActionRow,
        components: [
          {
            type: MessageComponentTypes.StringSelect,
            customId: 'v2-build-equipment-type',
            placeholder: data.equipmentType ? `Equipment: ${data.equipmentType}` : '1. Choose Weapon or Armor',
            options: [
              { label: 'Weapon', value: 'Weapon', default: data.equipmentType === 'Weapon' },
              { label: 'Armor', value: 'Armor', default: data.equipmentType === 'Armor' },
            ],
          },
        ],
      },
    ];

    if (data.equipmentType) {
      const catalog = await getEquipmentCatalog(data.equipmentType);
      components.push({
        type: MessageComponentTypes.ActionRow,
        components: [
          {
            type: MessageComponentTypes.StringSelect,
            customId: 'v2-build-category',
            placeholder: data.category ? `Category: ${data.category}` : '2. Choose equipment category',
            options: catalog.map((entry: any) => ({
              label: entry.type,
              value: entry.type,
              default: entry.type === data.category,
            })),
          },
        ],
      });

      if (data.category) {
        const category = catalog.find((entry: any) => entry.type === data.category);
        const variants = category?.variants ?? [];
        components.push({
          type: MessageComponentTypes.ActionRow,
          components: [
            {
              type: MessageComponentTypes.StringSelect,
              customId: 'v2-build-variant',
              placeholder: data.variant ? `Variant: ${data.variant}` : '3. Choose exact variant',
              options: variants.slice(0, 25).map((variant: any) => ({
                label: variant.name,
                value: variant.name,
                description: Array.isArray(variant.from) ? variant.from.join(', ').slice(0, 100) : undefined,
                default: variant.name === data.variant,
              })),
            },
          ],
        });
      }
    }

    if (data.variant) {
      components.push({ type: MessageComponentTypes.Separator });
      components.push({
        type: MessageComponentTypes.TextDisplay,
        content: `### Target\n**${data.variant}** · ${data.category}\n${recipeSummary(data)}`,
      });
      components.push({
        type: MessageComponentTypes.ActionRow,
        components: [
          {
            type: MessageComponentTypes.Button,
            customId: 'v2-edit-recipe',
            label: data.ores && Object.keys(data.ores).length ? 'Edit Recipe Slots' : 'Set Recipe Slots',
            style: ButtonStyles.Success,
          },
        ],
      });
    }

    components.push({ type: MessageComponentTypes.Separator });
    components.push({
      type: MessageComponentTypes.ActionRow,
      components: [
        { type: MessageComponentTypes.Button, customId: 'v2-home', label: 'Back', style: ButtonStyles.Secondary },
      ],
    });

    await interaction.edit({
      components: [{ type: MessageComponentTypes.Container, components }],
      flags: MessageFlags.IsComponentsV2,
    });
  };

  const renderV2BuildDashboard = async (data: SelectionData) => {
    await saveForgeDraft(userKey(), data);
    let equipment: any;
    try {
      equipment = await fetchV2Build(data);
    } catch (error) {
      await interaction.edit({
        components: [
          {
            type: MessageComponentTypes.Container,
            components: [
              {
                type: MessageComponentTypes.TextDisplay,
                content: `# Build Calculator\n${emoji('Wrong')} **This build is not valid yet.**\n${friendlyRequestError(error)}`,
              },
              {
                type: MessageComponentTypes.TextDisplay,
                content: `### Target\n**${data.variant ?? 'Not selected'}** · ${data.category ?? 'Unknown'}\n### Recipe\n${recipeSummary(data)}`,
              },
              {
                type: MessageComponentTypes.ActionRow,
                components: [
                  {
                    type: MessageComponentTypes.Button,
                    customId: 'v2-edit-recipe',
                    label: 'Edit Recipe',
                    style: ButtonStyles.Primary,
                  },
                  {
                    type: MessageComponentTypes.Button,
                    customId: 'v2-change-target',
                    label: 'Change Item',
                    style: ButtonStyles.Secondary,
                  },
                  {
                    type: MessageComponentTypes.Button,
                    customId: 'v2-home',
                    label: 'Home',
                    style: ButtonStyles.Secondary,
                  },
                ],
              },
            ],
          },
        ],
        flags: MessageFlags.IsComponentsV2,
      });
      return;
    }
    const result = data.equipmentType === 'Weapon' ? equipment.weapon : equipment.armor;
    data.equipmentRuneSlots = result.rune_slots;
    selections.set(userKey(), data);

    const statLines =
      data.equipmentType === 'Weapon'
        ? [
            `Damage **${result.final_damage_display ?? result.base_damage_display}**`,
            `Attack Speed **${result.final_attack_interval}s**`,
            `Crit **${Number(((result.critical?.chance ?? result.crit_chance ?? 0) * 100).toFixed(2))}%**`,
            `Estimated DPS **${result.dps?.estimated ?? result.dps?.effective}**`,
            `Multiplier **${result.avg_multi}x**`,
            `Sell **${result.sell_price_display}**`,
          ]
        : [
            `Health **${result.health_display ?? result.health ?? result.defense_display ?? result.defense}**`,
            `Multiplier **${result.avg_multi}x**`,
            `Sell **${result.sell_price_display ?? result.forged_price}**`,
          ];

    const extras = [
      `Quality **${data.quality ?? 0}%**`,
      `Enhancement **+${data.enhancement ?? 0}**`,
      data.race ? `Race **${data.race}**` : undefined,
      data.achievement ? `Achievement **${data.achievement.name} ${data.achievement.stage}**` : undefined,
      `Runes **${(data.runes ?? []).filter(Boolean).length}/${result.rune_slots ?? 0}**`,
    ]
      .filter(Boolean)
      .join(' · ');

    const components: any[] = [
      {
        type: MessageComponentTypes.Section,
        components: [
          {
            type: MessageComponentTypes.TextDisplay,
            content: `# ${result.name}\n${data.equipmentType} · ${data.category}\n-# ${data.world ?? "Stonewake's Cross"}`,
          },
        ],
        ...(result.image ? { accessory: { type: MessageComponentTypes.Thumbnail, media: { url: result.image } } } : {}),
      },
      { type: MessageComponentTypes.Separator },
      { type: MessageComponentTypes.TextDisplay, content: `### Recipe\n${recipeSummary(data)}` },
      {
        type: MessageComponentTypes.ActionRow,
        components: [
          {
            type: MessageComponentTypes.Button,
            customId: 'v2-edit-recipe',
            label: 'Recipe',
            style: ButtonStyles.Primary,
          },
          {
            type: MessageComponentTypes.Button,
            customId: 'v2-modifiers',
            label: 'Modifiers',
            style: ButtonStyles.Secondary,
          },
          {
            type: MessageComponentTypes.Button,
            customId: 'v2-rune-manager',
            label: 'Runes',
            style: ButtonStyles.Secondary,
            disabled: (result.rune_slots ?? 0) < 1,
          },
          {
            type: MessageComponentTypes.Button,
            customId: 'v2-details',
            label: 'Details',
            style: ButtonStyles.Secondary,
          },
        ],
      },
      { type: MessageComponentTypes.Separator },
      {
        type: MessageComponentTypes.TextDisplay,
        content: `### Overview\n${statLines.map((line) => `- ${line}`).join('\n')}`,
      },
      { type: MessageComponentTypes.TextDisplay, content: `### Build Settings\n${extras}` },
      {
        type: MessageComponentTypes.ActionRow,
        components: [
          {
            type: MessageComponentTypes.StringSelect,
            customId: 'v2-quality-preset',
            placeholder: `Quality: ${data.quality ?? 0}%`,
            options: [0, 50, 100].map((value) => ({
              label: `${value}% Quality`,
              value: String(value),
              default: (data.quality ?? 0) === value,
            })),
          },
        ],
      },
      {
        type: MessageComponentTypes.ActionRow,
        components: [
          {
            type: MessageComponentTypes.StringSelect,
            customId: 'v2-enhancement-preset',
            placeholder: `Enhancement: +${data.enhancement ?? 0}`,
            options: [0, 3, 6, 9].map((value) => ({
              label: `+${value}${value === 3 ? ' · 1 rune slot' : value === 6 ? ' · 2 rune slots' : value === 9 ? ' · 3 rune slots' : ''}`,
              value: String(value),
              default: (data.enhancement ?? 0) === value,
            })),
          },
        ],
      },
    ];

    if ((data.variantWorlds ?? []).length > 1) {
      components.push({
        type: MessageComponentTypes.ActionRow,
        components: [
          {
            type: MessageComponentTypes.StringSelect,
            customId: 'v2-build-world',
            placeholder: `World: ${data.world}`,
            options: (data.variantWorlds ?? []).map((world) => ({
              label: world,
              value: world,
              default: world === data.world,
            })),
          },
        ],
      });
    }

    components.push({ type: MessageComponentTypes.Separator });
    components.push({
      type: MessageComponentTypes.ActionRow,
      components: [
        {
          type: MessageComponentTypes.Button,
          customId: 'v2-show-chances',
          label: 'Forge Chances',
          style: ButtonStyles.Secondary,
        },
        {
          type: MessageComponentTypes.Button,
          customId: 'v2-save-build',
          label: 'Save Build',
          style: ButtonStyles.Success,
        },
        {
          type: MessageComponentTypes.Button,
          customId: 'v2-change-target',
          label: 'Change Item',
          style: ButtonStyles.Secondary,
        },
        { type: MessageComponentTypes.Button, customId: 'v2-home', label: 'Home', style: ButtonStyles.Secondary },
      ],
    });

    await interaction.edit({
      components: [{ type: MessageComponentTypes.Container, components }],
      flags: MessageFlags.IsComponentsV2,
    });
  };

  const renderV2RuneManager = async (data: SelectionData) => {
    const runes = await makeRequest('http://localhost:9999/runes', {
      method: RequestMethod.GET,
      response: ResponseType.JSON,
      headers: apiHeaders,
    });
    const equippedRunes = (data.runes ?? []).filter(Boolean);
    const slots = data.equipmentRuneSlots ?? getRuneSlotsForUi(data.enhancement ?? 0);
    const components: any[] = [
      {
        type: MessageComponentTypes.TextDisplay,
        content: `# Runes · ${equippedRunes.length}/${slots}\nChoose a rune, then use a roll preset. Custom values are still available when you need them.`,
      },
      { type: MessageComponentTypes.Separator },
    ];

    if (equippedRunes.length) {
      for (const [index, rune] of equippedRunes.entries()) {
        const values = Object.entries(rune.roll ?? {})
          .slice(0, 5)
          .map(([key, value]) => {
            const cleanKey = key.replace(/^.*?_/, '').replace(/_/g, ' ');
            return `${cleanKey}: ${formatRuneRollValue(rune, key, value)}`;
          })
          .join(' · ');
        components.push({
          type: MessageComponentTypes.TextDisplay,
          content: `**${index + 1}. ${rune.name.replace(/^Rune:\s*/, '')}**${values ? `\n-# ${values}` : ''}`,
        });
      }
      components.push({
        type: MessageComponentTypes.ActionRow,
        components: [
          {
            type: MessageComponentTypes.StringSelect,
            customId: 'manage-rune',
            placeholder: 'Edit or remove an equipped rune',
            options: equippedRunes.map((rune: any, index: number) => ({
              label: `${index + 1}. ${rune.name.replace(/^Rune:\s*/, '')}`,
              value: String(rune.id),
            })),
          },
        ],
      });
    } else {
      components.push({ type: MessageComponentTypes.TextDisplay, content: '*No runes equipped yet.*' });
    }

    if (equippedRunes.length < slots) {
      components.push({ type: MessageComponentTypes.Separator });
      components.push({
        type: MessageComponentTypes.ActionRow,
        components: [
          {
            type: MessageComponentTypes.StringSelect,
            customId: 'v2-select-rune',
            placeholder: 'Add a rune',
            options: runes
              .filter((rune: any) => rune.type === data.equipmentType)
              .slice(0, 25)
              .map((rune: any) => ({ label: rune.name, value: rune.name, description: rune.rarity })),
          },
        ],
      });
    }

    components.push({ type: MessageComponentTypes.Separator });
    components.push({
      type: MessageComponentTypes.ActionRow,
      components: [
        {
          type: MessageComponentTypes.Button,
          customId: 'v2-clear-runes',
          label: 'Clear All',
          style: ButtonStyles.Danger,
          disabled: equippedRunes.length === 0,
        },
        {
          type: MessageComponentTypes.Button,
          customId: 'v2-back-build-dashboard',
          label: 'Back to Build',
          style: ButtonStyles.Secondary,
        },
      ],
    });

    await interaction.edit({
      components: [{ type: MessageComponentTypes.Container, components }],
      flags: MessageFlags.IsComponentsV2,
    });
  };

  const renderV2RuneDetail = async (data: SelectionData) => {
    const selected = (data.runes ?? []).find((rune) => rune.id === data.runeTemp?.id);
    if (!selected) {
      await renderV2RuneManager(data);
      return;
    }
    const runeName = selected.name.replace(/^Rune:\s*/, '');
    const definition = await makeRequest('http://localhost:9999/runes', {
      method: RequestMethod.GET,
      response: ResponseType.JSON,
      params: { name: runeName },
      headers: apiHeaders,
    });
    const rollLines = Object.entries(selected.roll ?? {})
      .map(
        ([key, value]) =>
          `- **${selected.roll_meta?.[key]?.label ?? key.replace(/_/g, ' ')}:** ${formatRuneRollValue(selected, key, value)}`,
      )
      .join('\n');
    const subtraits = selected.subtraits ?? [];
    const maxSubtraits = Number(definition.max_subtraits ?? 0);
    const components: any[] = [
      {
        type: MessageComponentTypes.Section,
        components: [{ type: MessageComponentTypes.TextDisplay, content: `# ${runeName}\n${definition.rarity ?? ''}` }],
        ...(definition.image
          ? { accessory: { type: MessageComponentTypes.Thumbnail, media: { url: definition.image } } }
          : {}),
      },
      {
        type: MessageComponentTypes.TextDisplay,
        content: `### Primary Roll\n${rollLines || '*No roll values configured.*'}`,
      },
      {
        type: MessageComponentTypes.TextDisplay,
        content: `### Subtraits · ${subtraits.length}/${maxSubtraits}\n${
          subtraits.length
            ? subtraits
                .map((subtrait) => {
                  const value = Object.values(subtrait.roll ?? {})[0];
                  return `- **${subtrait.subtrait.replace(/^Secondary:\s*/, '')}:** ${value}%`;
                })
                .join('\n')
            : '*None*'
        }`,
      },
      { type: MessageComponentTypes.Separator },
      {
        type: MessageComponentTypes.ActionRow,
        components: [
          {
            type: MessageComponentTypes.Button,
            customId: 'v2-reroll-existing-rune',
            label: 'Change Roll',
            style: ButtonStyles.Primary,
          },
          {
            type: MessageComponentTypes.Button,
            customId: 'v2-add-subtrait',
            label: 'Add Subtrait',
            style: ButtonStyles.Secondary,
            disabled: subtraits.length >= maxSubtraits || maxSubtraits <= 0,
          },
          {
            type: MessageComponentTypes.Button,
            customId: 'v2-remove-rune',
            label: 'Remove Rune',
            style: ButtonStyles.Danger,
          },
        ],
      },
    ];
    if (subtraits.length) {
      components.push({
        type: MessageComponentTypes.ActionRow,
        components: [
          {
            type: MessageComponentTypes.StringSelect,
            customId: 'v2-remove-subtrait',
            placeholder: 'Remove a subtrait',
            options: subtraits.map((subtrait, index) => ({
              label: subtrait.subtrait.replace(/^Secondary:\s*/, ''),
              value: String(index),
            })),
          },
        ],
      });
    }
    components.push({
      type: MessageComponentTypes.ActionRow,
      components: [
        {
          type: MessageComponentTypes.Button,
          customId: 'v2-rune-manager',
          label: 'Back to Runes',
          style: ButtonStyles.Secondary,
        },
      ],
    });
    await interaction.edit({
      components: [{ type: MessageComponentTypes.Container, components }],
      flags: MessageFlags.IsComponentsV2,
    });
  };

  const renderV2RunePreset = async (data: SelectionData) => {
    const fields = data.runeTemp?.rollFields ?? [];
    const fieldLines = fields
      .map((field) => {
        const suffix =
          field.unit === '%' ? '%' : field.unit === 'seconds' ? 's' : field.unit === 'studs' ? ' studs' : '';
        const direction = field.use_lowest ? ' · lower is better' : '';
        return `- **${field.label}:** ${field.min}-${field.max}${suffix}${direction}`;
      })
      .join('\n');

    await interaction.edit({
      components: [
        {
          type: MessageComponentTypes.Container,
          components: [
            {
              type: MessageComponentTypes.TextDisplay,
              content: `# ${data.runeTemp?.name}\nChoose how you want to roll this rune.`,
            },
            { type: MessageComponentTypes.TextDisplay, content: fieldLines || '*No configurable fields.*' },
            { type: MessageComponentTypes.Separator },
            {
              type: MessageComponentTypes.ActionRow,
              components: [
                {
                  type: MessageComponentTypes.Button,
                  customId: 'v2-rune-best',
                  label: 'Best Roll',
                  style: ButtonStyles.Success,
                },
                {
                  type: MessageComponentTypes.Button,
                  customId: 'v2-rune-average',
                  label: 'Average',
                  style: ButtonStyles.Primary,
                },
                {
                  type: MessageComponentTypes.Button,
                  customId: 'v2-rune-worst',
                  label: 'Worst Roll',
                  style: ButtonStyles.Secondary,
                },
                {
                  type: MessageComponentTypes.Button,
                  customId: 'v2-rune-custom',
                  label: 'Custom',
                  style: ButtonStyles.Secondary,
                },
              ],
            },
            {
              type: MessageComponentTypes.ActionRow,
              components: [
                {
                  type: MessageComponentTypes.Button,
                  customId: 'v2-rune-manager',
                  label: 'Back',
                  style: ButtonStyles.Secondary,
                },
              ],
            },
          ],
        },
      ],
      flags: MessageFlags.IsComponentsV2,
    });
  };

  const applyRunePreset = async (data: SelectionData, preset: 'best' | 'average' | 'worst') => {
    const fields = data.runeTemp?.rollFields ?? [];
    const roll: Record<string, number> = {};
    const rollMeta: Record<string, StoredRuneRollMeta> = {};
    for (const field of fields) {
      let displayValue: number;
      if (preset === 'average') displayValue = Math.round(((field.min + field.max) / 2) * 100) / 100;
      else if (preset === 'best') displayValue = field.use_lowest ? field.min : field.max;
      else displayValue = field.use_lowest ? field.max : field.min;

      roll[field.key] = Math.round(displayValue * field.input_scale * 1e8) / 1e8;
      rollMeta[field.key] = { label: field.label, unit: field.unit, input_scale: field.input_scale };
    }

    const existingIndex = (data.runes ?? []).findIndex((rune) => rune.id === data.runeTemp?.id);
    if (existingIndex >= 0) {
      const existing = data.runes?.[existingIndex];
      if (existing) {
        existing.roll = roll;
        existing.roll_meta = rollMeta;
      }
    } else {
      (data.runes ??= []).push({
        id: data.runeTemp?.id ?? randomUUID(),
        name: `Rune: ${data.runeTemp?.name}`,
        roll,
        roll_meta: rollMeta,
      });
    }
    data.runeTemp = undefined;
    selections.set(userKey(), data);
    await renderV2RuneManager(data);
  };

  const renderV2ChanceSetup = async (data: SelectionData) => {
    const recipeTotal = Object.values(data.ores ?? {}).reduce((sum, amount) => sum + amount, 0);
    const total = data.chancesOreTotal ?? recipeTotal;
    await interaction.edit({
      components: [
        {
          type: MessageComponentTypes.Container,
          components: [
            {
              type: MessageComponentTypes.TextDisplay,
              content:
                '# Forge Chances\nForge type chances only depend on **total ore count** and world - the ore names do not change these odds.',
            },
            { type: MessageComponentTypes.Separator },
            {
              type: MessageComponentTypes.ActionRow,
              components: [
                {
                  type: MessageComponentTypes.StringSelect,
                  customId: 'v2-chances-equipment-type',
                  placeholder: data.equipmentType ? `Equipment: ${data.equipmentType}` : 'Choose Weapon or Armor',
                  options: [
                    { label: 'Weapon', value: 'Weapon', default: data.equipmentType === 'Weapon' },
                    { label: 'Armor', value: 'Armor', default: data.equipmentType === 'Armor' },
                  ],
                },
              ],
            },
            {
              type: MessageComponentTypes.ActionRow,
              components: [
                {
                  type: MessageComponentTypes.StringSelect,
                  customId: 'v2-chances-world',
                  placeholder: `World: ${data.world ?? "Stonewake's Cross"}`,
                  options: ["Stonewake's Cross", 'Forgotten Kingdom', 'Frostspire Expanse', 'Crimson Sakura'].map(
                    (world) => ({
                      label: world,
                      value: world,
                      default: world === (data.world ?? "Stonewake's Cross"),
                    }),
                  ),
                },
              ],
            },
            {
              type: MessageComponentTypes.TextDisplay,
              content: `### Ore Count\n**${total || 'Not set'}**${recipeTotal ? `\n-# Carried over from the current build recipe (${recipeTotal} ores).` : ''}`,
            },
            {
              type: MessageComponentTypes.ActionRow,
              components: [
                {
                  type: MessageComponentTypes.Button,
                  customId: 'v2-chances-edit-count',
                  label: total ? 'Change Ore Count' : 'Set Ore Count',
                  style: ButtonStyles.Success,
                },
                ...(data.equipmentType && total >= 3
                  ? [
                      {
                        type: MessageComponentTypes.Button,
                        customId: 'v2-chances-calculate',
                        label: 'Calculate',
                        style: ButtonStyles.Primary,
                      },
                    ]
                  : []),
                {
                  type: MessageComponentTypes.Button,
                  customId: 'v2-home',
                  label: 'Back',
                  style: ButtonStyles.Secondary,
                },
              ] as any,
            },
          ],
        },
      ],
      flags: MessageFlags.IsComponentsV2,
    });
  };

  const renderV2Chances = async (data: SelectionData, backToBuild = false) => {
    const chance = await fetchV2Chances(data);
    await interaction.edit({
      components: [
        {
          type: MessageComponentTypes.Container,
          components: [
            { type: MessageComponentTypes.TextDisplay, content: `# ${data.equipmentType} Forge Chances` },
            {
              type: MessageComponentTypes.TextDisplay,
              content: `### Inputs\n**${data.chancesOreTotal ?? Object.values(data.ores ?? {}).reduce((sum, amount) => sum + amount, 0)} ores** · ${data.world ?? "Stonewake's Cross"}`,
            },
            { type: MessageComponentTypes.Separator },
            {
              type: MessageComponentTypes.TextDisplay,
              content: chance.chances
                .map(
                  (entry: any) =>
                    `- **${entry.name}** ${entry.chance_rounded_1dp} · min ${entry.min_ores} ores${entry.lockable ? ' · lockable' : ''}`,
                )
                .join('\n'),
            },
            {
              type: MessageComponentTypes.ActionRow,
              components: [
                {
                  type: MessageComponentTypes.Button,
                  customId: 'v2-chances-edit-count',
                  label: 'Change Ore Count',
                  style: ButtonStyles.Primary,
                },
                ...(backToBuild
                  ? [
                      {
                        type: MessageComponentTypes.Button,
                        customId: 'v2-back-build-dashboard',
                        label: 'Back to Build',
                        style: ButtonStyles.Secondary,
                      },
                    ]
                  : [
                      {
                        type: MessageComponentTypes.Button,
                        customId: 'v2-chances-setup',
                        label: 'Settings',
                        style: ButtonStyles.Secondary,
                      },
                    ]),
                {
                  type: MessageComponentTypes.Button,
                  customId: 'v2-home',
                  label: 'Home',
                  style: ButtonStyles.Secondary,
                },
              ] as any,
            },
          ],
        },
      ],
      flags: MessageFlags.IsComponentsV2,
    });
  };

  const renderSavedBuilds = async () => {
    const builds = await listSavedForgeBuilds(userKey());
    const components: any[] = [
      {
        type: MessageComponentTypes.TextDisplay,
        content: '# Saved Builds\nLoad a saved setup directly into the calculator.',
      },
      { type: MessageComponentTypes.Separator },
    ];

    if (!builds.length) {
      components.push({ type: MessageComponentTypes.TextDisplay, content: '*You have no saved builds yet.*' });
    } else {
      components.push({
        type: MessageComponentTypes.TextDisplay,
        content: builds
          .map(
            (build, index) =>
              `**${index + 1}. ${build.name}**\n-# ${build.data.variant ?? 'Unknown item'} · ${formatForgeRecipe(build.data.ores)} · +${build.data.enhancement ?? 0}`,
          )
          .join('\n\n'),
      });
      components.push({
        type: MessageComponentTypes.ActionRow,
        components: [
          {
            type: MessageComponentTypes.StringSelect,
            customId: 'v2-load-build',
            placeholder: 'Load a saved build',
            options: builds.map((build) => ({
              label: build.name.slice(0, 100),
              value: build.id,
              description: `${build.data.variant ?? 'Unknown item'} · +${build.data.enhancement ?? 0}`.slice(0, 100),
            })),
          },
        ],
      });
      if (builds.length >= 2) {
        components.push({
          type: MessageComponentTypes.ActionRow,
          components: [
            {
              type: MessageComponentTypes.StringSelect,
              customId: 'v2-compare-builds',
              placeholder: 'Compare exactly 2 saved builds',
              minValues: 2,
              maxValues: 2,
              options: builds.map((build) => ({ label: build.name.slice(0, 100), value: build.id })),
            },
          ],
        });
      }
      components.push({
        type: MessageComponentTypes.ActionRow,
        components: [
          {
            type: MessageComponentTypes.StringSelect,
            customId: 'v2-delete-build',
            placeholder: 'Delete a saved build',
            options: builds.map((build) => ({ label: build.name.slice(0, 100), value: build.id })),
          },
        ],
      });
    }

    components.push({ type: MessageComponentTypes.Separator });
    components.push({
      type: MessageComponentTypes.ActionRow,
      components: [
        { type: MessageComponentTypes.Button, customId: 'v2-home', label: 'Back', style: ButtonStyles.Secondary },
      ],
    });

    await interaction.edit({
      components: [{ type: MessageComponentTypes.Container, components }],
      flags: MessageFlags.IsComponentsV2,
    });
  };

  const renderClassicStart = async () => {
    const data = selections.get(userKey()) ?? {};
    data.mode = 'classic';
    selections.set(userKey(), data);
    await interaction.edit({
      components: [
        {
          type: MessageComponentTypes.Container,
          components: [
            { type: MessageComponentTypes.TextDisplay, content: '# Forge Calculator · Classic' },
            {
              type: MessageComponentTypes.Section,
              components: [
                {
                  type: MessageComponentTypes.TextDisplay,
                  content: "Press the button on the right when you're ready to forge!",
                },
              ],
              accessory: {
                type: MessageComponentTypes.Button,
                customId: 'forge',
                label: 'Forge',
                style: ButtonStyles.Success,
              },
            },
            { type: MessageComponentTypes.Separator },
            {
              type: MessageComponentTypes.TextDisplay,
              content: 'Select the type of your equipment and the ores you want to use.',
            },
            {
              type: MessageComponentTypes.ActionRow,
              components: [
                {
                  type: MessageComponentTypes.StringSelect,
                  customId: 'equipment-type',
                  placeholder: 'Available Equipment Types:',
                  options: [
                    { label: 'Weapon', value: 'Weapon' },
                    { label: 'Armor', value: 'Armor' },
                  ],
                },
              ],
            },
            {
              type: MessageComponentTypes.ActionRow,
              components: [
                {
                  type: MessageComponentTypes.StringSelect,
                  customId: 'ores-selection',
                  placeholder: 'Available Ores:',
                  options: ores
                    .slice(0, 25)
                    .map((ore: any) => ({ label: ore.name, value: ore.name, description: `${ore.multiplier}x` })),
                },
              ],
            },
            {
              type: MessageComponentTypes.ActionRow,
              components: [
                {
                  type: MessageComponentTypes.Button,
                  customId: 'view-more-ores',
                  label: 'View More Ores',
                  style: ButtonStyles.Secondary,
                },
                {
                  type: MessageComponentTypes.Button,
                  customId: 'v2-home',
                  label: 'New Calculator',
                  style: ButtonStyles.Primary,
                },
              ],
            },
          ],
        },
      ],
      flags: MessageFlags.IsComponentsV2,
    });
  };

  handlers.set('v2-home', async (i) => {
    await i.deferEdit();
    selections.delete(userKey());
    const draft = await getForgeDraft(userKey());
    const components: any[] = [
      {
        type: MessageComponentTypes.TextDisplay,
        content: '# Forge Calculator\nBuild a specific item, compare saved setups, or only calculate forge chances.',
      },
      { type: MessageComponentTypes.Separator },
    ];
    if (draft?.equipmentType || draft?.ores) {
      components.push({
        type: MessageComponentTypes.Section,
        components: [
          {
            type: MessageComponentTypes.TextDisplay,
            content: `**Resume Draft**\n${draft.variant ?? draft.category ?? draft.equipmentType ?? 'Unfinished build'} · ${formatForgeRecipe(draft.ores)}`,
          },
        ],
        accessory: {
          type: MessageComponentTypes.Button,
          customId: 'v2-resume-draft',
          label: 'Resume',
          style: ButtonStyles.Primary,
        },
      });
    }
    components.push(
      {
        type: MessageComponentTypes.Section,
        components: [
          {
            type: MessageComponentTypes.TextDisplay,
            content: '**Build Calculator**\nTarget-first calculator with one-shot recipe entry.',
          },
        ],
        accessory: {
          type: MessageComponentTypes.Button,
          customId: 'v2-build-start',
          label: 'Build Calculator',
          style: ButtonStyles.Success,
        },
      },
      {
        type: MessageComponentTypes.Section,
        components: [
          {
            type: MessageComponentTypes.TextDisplay,
            content: '**Forge Chances**\nRecipe probabilities without unrelated build settings.',
          },
        ],
        accessory: {
          type: MessageComponentTypes.Button,
          customId: 'v2-chances-start',
          label: 'Forge Chances',
          style: ButtonStyles.Primary,
        },
      },
      {
        type: MessageComponentTypes.Section,
        components: [
          {
            type: MessageComponentTypes.TextDisplay,
            content: '**Saved Builds**\nLoad, compare, or delete saved setups.',
          },
        ],
        accessory: {
          type: MessageComponentTypes.Button,
          customId: 'v2-saved-builds',
          label: 'Saved Builds',
          style: ButtonStyles.Secondary,
        },
      },
      {
        type: MessageComponentTypes.Section,
        components: [
          {
            type: MessageComponentTypes.TextDisplay,
            content: '**Player Profile**\nSet your usual race, achievement, and default world once.',
          },
        ],
        accessory: {
          type: MessageComponentTypes.Button,
          customId: 'v2-profile',
          label: 'Profile',
          style: ButtonStyles.Secondary,
        },
      },
      {
        type: MessageComponentTypes.Section,
        components: [
          { type: MessageComponentTypes.TextDisplay, content: '-# Need the previous flow while V2 is rolling out?' },
        ],
        accessory: {
          type: MessageComponentTypes.Button,
          customId: 'classic-start',
          label: 'Classic',
          style: ButtonStyles.Secondary,
        },
      },
    );
    await interaction.edit({
      components: [{ type: MessageComponentTypes.Container, components }],
      flags: MessageFlags.IsComponentsV2,
    });
  });

  handlers.set('classic-start', async (i) => {
    await i.deferEdit();
    await renderClassicStart();
  });

  handlers.set('v2-build-start', async (i) => {
    const profile = await getForgeProfile(userKey());
    const data: SelectionData = {
      mode: 'build',
      race: profile?.race,
      achievement: profile?.achievement ? { ...profile.achievement } : undefined,
      world: profile?.defaultWorld,
      quality: 0,
      enhancement: 0,
    };
    selections.set(userKey(), data);
    await i.deferEdit();
    await renderV2BuildSetup(data);
  });

  handlers.set('v2-chances-start', async (i) => {
    const profile = await getForgeProfile(userKey());
    const data: SelectionData = {
      mode: 'chances',
      world: profile?.defaultWorld ?? "Stonewake's Cross",
    };
    selections.set(userKey(), data);
    await i.deferEdit();
    await renderV2ChanceSetup(data);
  });

  handlers.set('v2-build-equipment-type', async (i) => {
    const data = selections.get(userKey()) ?? { mode: 'build' as const };
    data.equipmentType = String(i.data?.values?.[0] ?? '');
    data.category = undefined;
    data.variant = undefined;
    data.variantWorlds = undefined;
    selections.set(userKey(), data);
    await i.deferEdit();
    await renderV2BuildSetup(data);
  });

  handlers.set('v2-build-category', async (i) => {
    const data = selections.get(userKey());
    if (!data?.equipmentType) return;
    data.category = String(i.data?.values?.[0] ?? '');
    data.variant = undefined;
    data.variantWorlds = undefined;
    selections.set(userKey(), data);
    await i.deferEdit();
    await renderV2BuildSetup(data);
  });

  handlers.set('v2-build-variant', async (i) => {
    const data = selections.get(userKey());
    if (!data?.equipmentType || !data.category) return;
    data.variant = String(i.data?.values?.[0] ?? '');
    const catalog = await getEquipmentCatalog(data.equipmentType);
    const category = catalog.find((entry: any) => entry.type === data.category);
    const variant = category?.variants?.find((entry: any) => entry.name === data.variant);
    const variantWorlds: string[] =
      Array.isArray(variant?.from) && variant.from.length ? variant.from : ["Stonewake's Cross"];
    data.variantWorlds = variantWorlds;
    if (!data.world || !variantWorlds.includes(data.world)) data.world = variantWorlds[0];
    selections.set(userKey(), data);
    await i.deferEdit();
    if (data.ores && Object.keys(data.ores).length) await renderV2BuildDashboard(data);
    else await renderV2BuildSetup(data);
  });

  handlers.set('v2-build-world', async (i) => {
    const data = selections.get(userKey());
    if (!data) return;
    data.world = String(i.data?.values?.[0] ?? data.world);
    selections.set(userKey(), data);
    await i.deferEdit();
    if (data.variant && data.ores && Object.keys(data.ores).length) await renderV2BuildDashboard(data);
    else await renderV2BuildSetup(data);
  });

  handlers.set('v2-edit-recipe', async (i) => {
    const data = selections.get(userKey()) ?? {};
    ensureRecipeSlots(data);
    selections.set(userKey(), data);
    await i.deferEdit();
    await renderV2RecipeEditor(data);
  });

  handlers.set('v2-recipe-input', async (i) => {
    const data = selections.get(userKey()) ?? {};
    const raw = i.data?.components?.[0]?.component?.value;
    const parsed = parseForgeRecipeInput(
      raw,
      ores.map((ore: any) => ore.name),
    );
    if (!parsed.ok) {
      await i.respond({
        components: [
          {
            type: MessageComponentTypes.Container,
            components: [{ type: MessageComponentTypes.TextDisplay, content: `${emoji('Wrong')} ${parsed.error}` }],
          },
        ],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      return;
    }

    data.ores = parsed.ores;
    data.oreSlots = Object.entries(parsed.ores)
      .slice(0, 4)
      .map(([ore, amount]) => ({ ore, amount }));
    while (data.oreSlots.length < 4) data.oreSlots.push(null);
    selections.set(userKey(), data);
    await i.deferEdit();

    if (data.mode === 'build') {
      if (!data.equipmentType || !data.category || !data.variant) await renderV2BuildSetup(data);
      else await renderV2BuildDashboard(data);
    } else {
      if (!data.equipmentType) await renderV2ChanceSetup(data);
      else await renderV2Chances(data);
    }
  });

  for (let slotIndex = 0; slotIndex < 4; slotIndex++) {
    handlers.set(`v2-recipe-slot-${slotIndex + 1}`, async (i) => {
      const data = selections.get(userKey()) ?? {};
      ensureRecipeSlots(data);
      oreBrowseState.set(slotIndex, { world: initialBrowseWorld(data, slotIndex), page: 0 });
      selections.set(userKey(), data);
      await i.deferEdit();
      await renderOreBrowser(data, slotIndex);
    });

    handlers.set(`v2-recipe-browse-world-${slotIndex + 1}`, async (i) => {
      const data = selections.get(userKey()) ?? {};
      const world = String(i.data?.values?.[0] ?? ALL_ORES_WORLD);
      oreBrowseState.set(slotIndex, { world, page: 0 });
      selections.set(userKey(), data);
      await i.deferEdit();
      await renderOreBrowser(data, slotIndex);
    });

    handlers.set(`v2-recipe-browse-prev-${slotIndex + 1}`, async (i) => {
      const data = selections.get(userKey()) ?? {};
      const state = getOreBrowseState(data, slotIndex);
      state.page = Math.max(0, state.page - 1);
      oreBrowseState.set(slotIndex, state);
      selections.set(userKey(), data);
      await i.deferEdit();
      await renderOreBrowser(data, slotIndex);
    });

    handlers.set(`v2-recipe-browse-next-${slotIndex + 1}`, async (i) => {
      const data = selections.get(userKey()) ?? {};
      const state = getOreBrowseState(data, slotIndex);
      const available = getBrowseOres(data, slotIndex, state.world);
      const pageCount = Math.max(1, Math.ceil(available.length / ORE_PAGE_SIZE));
      state.page = Math.min(pageCount - 1, state.page + 1);
      oreBrowseState.set(slotIndex, state);
      selections.set(userKey(), data);
      await i.deferEdit();
      await renderOreBrowser(data, slotIndex);
    });

    handlers.set(`v2-recipe-browse-ore-${slotIndex + 1}`, async (i) => {
      const data = selections.get(userKey()) ?? {};
      const ore = String(i.data?.values?.[0] ?? '');
      const duplicate = duplicateOreSlot(data, slotIndex, ore);
      if (!ore || !(ores as any[]).some((entry: any) => entry.name === ore) || duplicate >= 0) {
        await i.respond({
          components: [
            {
              type: MessageComponentTypes.Container,
              components: [
                {
                  type: MessageComponentTypes.TextDisplay,
                  content:
                    duplicate >= 0
                      ? `${emoji('Wrong')} **${ore}** is already used in slot ${duplicate + 1}.`
                      : `${emoji('Wrong')} That ore is no longer available.`,
                },
              ],
            },
          ],
          flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
        });
        return;
      }

      pendingRecipeAmounts.set(slotIndex, ensureRecipeSlots(data)[slotIndex]?.amount ?? 1);
      getOreBrowseState(data, slotIndex).selectedOre = ore;
      await showOreAmountModal(i, data, slotIndex, ore);
    });

    handlers.set(`v2-recipe-browse-amount-submit-${slotIndex + 1}`, async (i) => {
      const data = selections.get(userKey()) ?? {};
      const amount = Number(String(i.data?.components?.[0]?.component?.value ?? '').trim());
      const state = getOreBrowseState(data, slotIndex);
      const ore = state.selectedOre;

      if (!Number.isSafeInteger(amount) || amount <= 0) {
        await i.respond({
          components: [
            {
              type: MessageComponentTypes.Container,
              components: [
                {
                  type: MessageComponentTypes.TextDisplay,
                  content: `${emoji('Wrong')} Amount must be a whole number greater than 0.`,
                },
              ],
            },
          ],
          flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
        });
        return;
      }

      if (!ore || !(ores as any[]).some((entry: any) => entry.name === ore)) {
        await i.respond({
          components: [
            {
              type: MessageComponentTypes.Container,
              components: [
                { type: MessageComponentTypes.TextDisplay, content: `${emoji('Wrong')} Choose the ore again.` },
              ],
            },
          ],
          flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
        });
        return;
      }

      const duplicate = duplicateOreSlot(data, slotIndex, ore);
      if (duplicate >= 0) {
        await i.respond({
          components: [
            {
              type: MessageComponentTypes.Container,
              components: [
                {
                  type: MessageComponentTypes.TextDisplay,
                  content: `${emoji('Wrong')} **${ore}** is already used in slot ${duplicate + 1}.`,
                },
              ],
            },
          ],
          flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
        });
        return;
      }

      setRecipeSlot(data, slotIndex, ore, amount);
      delete state.selectedOre;
      oreBrowseState.set(slotIndex, state);
      await rememberRecentOre(ore);
      selections.set(userKey(), data);
      await i.deferEdit();
      await renderV2RecipeEditor(data);
    });

    handlers.set(`v2-recipe-search-${slotIndex + 1}`, async (i) => {
      const data = selections.get(userKey()) ?? {};
      await showOreSearchModal(i, data, slotIndex);
    });

    handlers.set(`v2-recipe-search-submit-${slotIndex + 1}`, async (i) => {
      const data = selections.get(userKey()) ?? {};
      const parts = i.data?.components ?? [];
      const searchQuery = String(parts[0]?.component?.value ?? '').trim();
      const amount = Number(String(parts[1]?.component?.value ?? '').trim());

      if (!Number.isSafeInteger(amount) || amount <= 0) {
        await i.respond({
          components: [
            {
              type: MessageComponentTypes.Container,
              components: [
                {
                  type: MessageComponentTypes.TextDisplay,
                  content: `${emoji('Wrong')} Amount must be a whole number greater than 0.`,
                },
              ],
            },
          ],
          flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
        });
        return;
      }

      const matches = searchOreNames(searchQuery, data, slotIndex);
      if (!matches.length) {
        await i.respond({
          components: [
            {
              type: MessageComponentTypes.Container,
              components: [
                {
                  type: MessageComponentTypes.TextDisplay,
                  content: `${emoji('Wrong')} No ores matched **${searchQuery}**.`,
                },
              ],
            },
          ],
          flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
        });
        return;
      }

      pendingRecipeAmounts.set(slotIndex, amount);
      const exact = matches.find((name) => name.toLowerCase() === searchQuery.toLowerCase());
      if (matches.length === 1 || exact) {
        const ore = exact ?? matches[0]!;
        const duplicate = duplicateOreSlot(data, slotIndex, ore);
        if (duplicate >= 0) {
          await i.respond({
            components: [
              {
                type: MessageComponentTypes.Container,
                components: [
                  {
                    type: MessageComponentTypes.TextDisplay,
                    content: `${emoji('Wrong')} **${ore}** is already used in slot ${duplicate + 1}.`,
                  },
                ],
              },
            ],
            flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
          });
          return;
        }
        setRecipeSlot(data, slotIndex, ore, amount);
        pendingRecipeAmounts.delete(slotIndex);
        await rememberRecentOre(ore);
        selections.set(userKey(), data);
        await i.deferEdit();
        await renderV2RecipeEditor(data);
        return;
      }

      selections.set(userKey(), data);
      await i.deferEdit();
      await renderOreSearchResults(data, slotIndex, searchQuery, matches);
    });

    handlers.set(`v2-recipe-search-result-${slotIndex + 1}`, async (i) => {
      const data = selections.get(userKey()) ?? {};
      const ore = String(i.data?.values?.[0] ?? '');
      const amount = pendingRecipeAmounts.get(slotIndex) ?? ensureRecipeSlots(data)[slotIndex]?.amount ?? 1;
      const duplicate = duplicateOreSlot(data, slotIndex, ore);

      if (!ore || !(ores as any[]).some((entry: any) => entry.name === ore) || duplicate >= 0) {
        await i.respond({
          components: [
            {
              type: MessageComponentTypes.Container,
              components: [
                {
                  type: MessageComponentTypes.TextDisplay,
                  content:
                    duplicate >= 0
                      ? `${emoji('Wrong')} **${ore}** is already used in slot ${duplicate + 1}.`
                      : `${emoji('Wrong')} That ore is no longer available.`,
                },
              ],
            },
          ],
          flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
        });
        return;
      }

      setRecipeSlot(data, slotIndex, ore, amount);
      pendingRecipeAmounts.delete(slotIndex);
      await rememberRecentOre(ore);
      selections.set(userKey(), data);
      await i.deferEdit();
      await renderV2RecipeEditor(data);
    });

    handlers.set(`v2-recipe-remove-${slotIndex + 1}`, async (i) => {
      const data = selections.get(userKey()) ?? {};
      clearRecipeSlot(data, slotIndex);
      oreBrowseState.delete(slotIndex);
      selections.set(userKey(), data);
      await i.deferEdit();
      await renderV2RecipeEditor(data);
    });
  }

  handlers.set('v2-recipe-done', async (i) => {
    const data = selections.get(userKey()) ?? {};
    syncRecipeFromSlots(data);
    const total = Object.values(data.ores ?? {}).reduce((sum, amount) => sum + amount, 0);
    if (total < 3) return;
    selections.set(userKey(), data);
    await i.deferEdit();
    if (data.equipmentType && data.category && data.variant) await renderV2BuildDashboard(data);
    else await renderV2BuildSetup(data);
  });

  handlers.set('v2-recipe-clear', async (i) => {
    const data = selections.get(userKey()) ?? {};
    data.oreSlots = [null, null, null, null];
    data.ores = {};
    selections.set(userKey(), data);
    await i.deferEdit();
    await renderV2RecipeEditor(data);
  });

  handlers.set('v2-recipe-cancel', async (i) => {
    const data = selections.get(userKey()) ?? {};
    syncRecipeFromSlots(data);
    selections.set(userKey(), data);
    await i.deferEdit();
    if (data.variant && data.ores && Object.keys(data.ores).length) await renderV2BuildDashboard(data);
    else await renderV2BuildSetup(data);
  });

  handlers.set('v2-chances-edit-count', async (i) => {
    const data = selections.get(userKey()) ?? { mode: 'chances' as const };
    const recipeTotal = Object.values(data.ores ?? {}).reduce((sum, amount) => sum + amount, 0);
    await i.respond({
      customId: 'v2-chances-count-submit',
      title: 'Forge Ore Count',
      components: [
        {
          type: MessageComponentTypes.Label,
          label: 'Total ores',
          description: 'Forge type odds depend on this total, not which ores are in the recipe.',
          component: {
            type: MessageComponentTypes.TextInput,
            customId: 'v2-chances-count',
            placeholder: '20',
            value: String((data.chancesOreTotal ?? recipeTotal) || ''),
            style: TextStyles.Short,
            required: true,
            maxLength: 9,
          },
        },
      ],
    });
  });

  handlers.set('v2-chances-count-submit', async (i) => {
    const data = selections.get(userKey()) ?? { mode: 'chances' as const };
    const raw = String(i.data?.components?.[0]?.component?.value ?? '').trim();
    const total = Number(raw);
    if (!Number.isSafeInteger(total) || total < 3) {
      await i.respond({
        components: [
          {
            type: MessageComponentTypes.Container,
            components: [
              {
                type: MessageComponentTypes.TextDisplay,
                content: `${emoji('Wrong')} Enter a whole-number ore count of **3 or more**.`,
              },
            ],
          },
        ],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      return;
    }
    data.mode = 'chances';
    data.chancesOreTotal = total;
    selections.set(userKey(), data);
    await i.deferEdit();
    if (data.equipmentType) await renderV2Chances(data);
    else await renderV2ChanceSetup(data);
  });

  handlers.set('v2-chances-calculate', async (i) => {
    const data = selections.get(userKey());
    const total = data?.chancesOreTotal ?? Object.values(data?.ores ?? {}).reduce((sum, amount) => sum + amount, 0);
    if (!data?.equipmentType || total < 3) return;
    await i.deferEdit();
    await renderV2Chances(data);
  });

  handlers.set('v2-chances-equipment-type', async (i) => {
    const data = selections.get(userKey()) ?? { mode: 'chances' as const };
    data.mode = 'chances';
    data.equipmentType = String(i.data?.values?.[0] ?? '');
    data.world ??= "Stonewake's Cross";
    selections.set(userKey(), data);
    await i.deferEdit();
    const total = data.chancesOreTotal ?? Object.values(data.ores ?? {}).reduce((sum, amount) => sum + amount, 0);
    if (total >= 3) await renderV2Chances(data);
    else await renderV2ChanceSetup(data);
  });

  handlers.set('v2-chances-world', async (i) => {
    const data = selections.get(userKey());
    if (!data) return;
    data.world = String(i.data?.values?.[0] ?? data.world);
    selections.set(userKey(), data);
    await i.deferEdit();
    const total = data.chancesOreTotal ?? Object.values(data.ores ?? {}).reduce((sum, amount) => sum + amount, 0);
    if (data.equipmentType && total >= 3) await renderV2Chances(data);
    else await renderV2ChanceSetup(data);
  });

  handlers.set('v2-chances-setup', async (i) => {
    const data = selections.get(userKey());
    if (!data) return;
    await i.deferEdit();
    await renderV2ChanceSetup(data);
  });

  handlers.set('v2-show-chances', async (i) => {
    const data = selections.get(userKey());
    if (!data?.equipmentType || !data.ores) return;
    data.chancesOreTotal = Object.values(data.ores).reduce((sum, amount) => sum + amount, 0);
    selections.set(userKey(), data);
    await i.deferEdit();
    await renderV2Chances(data, true);
  });

  handlers.set('v2-back-build-dashboard', async (i) => {
    const data = selections.get(userKey());
    if (!data) return;
    await i.deferEdit();
    await renderV2BuildDashboard(data);
  });

  handlers.set('v2-change-target', async (i) => {
    const data = selections.get(userKey());
    if (!data) return;
    data.category = undefined;
    data.variant = undefined;
    data.variantWorlds = undefined;
    data.runes = undefined;
    selections.set(userKey(), data);
    await i.deferEdit();
    await renderV2BuildSetup(data);
  });

  handlers.set('v2-quality-preset', async (i) => {
    const data = selections.get(userKey());
    if (!data) return;
    data.quality = Number(i.data?.values?.[0] ?? 0);
    selections.set(userKey(), data);
    await i.deferEdit();
    await renderV2BuildDashboard(data);
  });

  handlers.set('v2-enhancement-preset', async (i) => {
    const data = selections.get(userKey());
    if (!data) return;
    data.enhancement = Number(i.data?.values?.[0] ?? 0);
    const slots = getRuneSlotsForUi(data.enhancement);
    if ((data.runes ?? []).length > slots) data.runes = (data.runes ?? []).slice(0, slots);
    selections.set(userKey(), data);
    await i.deferEdit();
    await renderV2BuildDashboard(data);
  });

  handlers.set('v2-modifiers', async (i) => {
    const data = selections.get(userKey());
    if (!data) return;
    const races = await makeRequest('http://localhost:9999/races', {
      method: RequestMethod.GET,
      response: ResponseType.JSON,
      headers: apiHeaders,
    });
    const achievements = await makeRequest('http://localhost:9999/achievements', {
      method: RequestMethod.GET,
      response: ResponseType.JSON,
      headers: apiHeaders,
    });
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
                label: achievement.name,
                value: achievement.name,
                description: achievement.type,
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

  handlers.set('v2-modifiers-submit', async (i) => {
    const data = selections.get(userKey());
    if (!data) return;
    const components = i.data?.components ?? [];
    const race = components[0]?.component?.values?.[0];
    const achievement = components[1]?.component?.values?.[0];
    const stageRaw = components[2]?.component?.value;
    const qualityRaw = components[3]?.component?.value;
    const enhancementRaw = components[4]?.component?.value;

    if (race === '__none__') data.race = undefined;
    else if (typeof race === 'string' && race) data.race = race;

    if (achievement === '__none__') data.achievement = undefined;
    else if (typeof achievement === 'string' && achievement) {
      const stage = String(stageRaw ?? '').trim() === '' ? data.achievement?.stage : Number(stageRaw);
      if (!Number.isInteger(stage) || Number(stage) < 1 || Number(stage) > 5) {
        await i.respond({
          components: [
            {
              type: MessageComponentTypes.Container,
              components: [
                {
                  type: MessageComponentTypes.TextDisplay,
                  content: `${emoji('Wrong')} Achievement stage must be from 1 to 5.`,
                },
              ],
            },
          ],
          flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
        });
        return;
      }
      data.achievement = { name: achievement, stage: Number(stage) };
    }

    if (typeof qualityRaw === 'string' && qualityRaw.trim() !== '') {
      const quality = Number(qualityRaw);
      if (!Number.isInteger(quality) || quality < 0 || quality > 100) {
        await i.respond({
          components: [
            {
              type: MessageComponentTypes.Container,
              components: [
                {
                  type: MessageComponentTypes.TextDisplay,
                  content: `${emoji('Wrong')} Quality must be an integer from 0 to 100.`,
                },
              ],
            },
          ],
          flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
        });
        return;
      }
      data.quality = quality;
    }

    if (typeof enhancementRaw === 'string' && enhancementRaw.trim() !== '') {
      const enhancement = Number(enhancementRaw);
      if (!Number.isInteger(enhancement) || enhancement < 0 || enhancement > 9) {
        await i.respond({
          components: [
            {
              type: MessageComponentTypes.Container,
              components: [
                {
                  type: MessageComponentTypes.TextDisplay,
                  content: `${emoji('Wrong')} Enhancement must be an integer from 0 to 9.`,
                },
              ],
            },
          ],
          flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
        });
        return;
      }
      data.enhancement = enhancement;
      const slots = getRuneSlotsForUi(enhancement);
      if ((data.runes ?? []).length > slots) data.runes = (data.runes ?? []).slice(0, slots);
    }

    selections.set(userKey(), data);
    await i.deferEdit();
    await renderV2BuildDashboard(data);
  });

  handlers.set('v2-details', async (i) => {
    const data = selections.get(userKey());
    if (!data) return;
    const equipment = await fetchV2Build(data);
    const result = data.equipmentType === 'Weapon' ? equipment.weapon : equipment.armor;
    const traits = (result.traits_rendered ?? [])
      .map((trait: any) => `- **${normalizeUiText(trait.source)}:** ${formatRenderedTrait(trait.trait)}`)
      .join('\n');
    const mechanics = Object.entries(result.mechanics ?? {})
      .filter(([, value]) => typeof value === 'number' && value !== 0)
      .slice(0, 20)
      .map(([key, value]) => `- ${key.replaceAll('_', ' ')}: **${value}**`)
      .join('\n');
    await i.respond({
      components: [
        {
          type: MessageComponentTypes.Container,
          components: [
            { type: MessageComponentTypes.TextDisplay, content: `# ${result.name} · Details` },
            { type: MessageComponentTypes.TextDisplay, content: `### Traits\n${traits || '*None*'}` },
            ...(mechanics
              ? [{ type: MessageComponentTypes.TextDisplay, content: `### Runtime / derived mechanics\n${mechanics}` }]
              : []),
            ...(data.equipmentType === 'Weapon'
              ? [
                  {
                    type: MessageComponentTypes.TextDisplay,
                    content:
                      '-# Ping h0gtt if you find any errors in the calculations',
                  },
                ]
              : []),
          ] as any,
        },
      ],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    });
  });

  handlers.set('v2-browse-ores', async (i) => {
    const data = selections.get(userKey());
    if (!data) return;
    data.mode = 'classic';
    selections.set(userKey(), data);
    await i.deferEdit();
    await renderClassicStart();
  });

  handlers.set('v2-profile', async (i) => {
    const [profile, races, achievements] = await Promise.all([
      getForgeProfile(userKey()),
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
    await i.respond({
      customId: 'v2-profile-submit',
      title: 'Forge Player Profile',
      components: [
        {
          type: MessageComponentTypes.Label,
          label: 'Default race',
          component: {
            type: MessageComponentTypes.StringSelect,
            customId: 'v2-profile-race',
            placeholder: profile?.race ?? 'None',
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
          label: 'Default achievement',
          component: {
            type: MessageComponentTypes.StringSelect,
            customId: 'v2-profile-achievement',
            placeholder: profile?.achievement?.name ?? 'None',
            options: [
              { label: 'None', value: '__none__' },
              ...achievements.slice(0, 24).map((achievement: any) => ({
                label: achievement.name,
                value: achievement.name,
                description: achievement.type,
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
            customId: 'v2-profile-stage',
            placeholder: profile?.achievement ? String(profile.achievement.stage) : 'Only if using an achievement',
            style: TextStyles.Short,
            required: false,
          },
        },
        {
          type: MessageComponentTypes.Label,
          label: 'Default world',
          component: {
            type: MessageComponentTypes.StringSelect,
            customId: 'v2-profile-world',
            placeholder: profile?.defaultWorld ?? "Stonewake's Cross",
            options: ["Stonewake's Cross", 'Forgotten Kingdom', 'Frostspire Expanse', 'Crimson Sakura'].map(
              (world) => ({
                label: world,
                value: world,
                default: world === profile?.defaultWorld,
              }),
            ),
            required: false,
          },
        },
      ],
    });
  });

  handlers.set('v2-profile-submit', async (i) => {
    const previous = (await getForgeProfile(userKey())) ?? {};
    const parts = i.data?.components ?? [];
    const race = parts[0]?.component?.values?.[0];
    const achievement = parts[1]?.component?.values?.[0];
    const stageRaw = parts[2]?.component?.value;
    const world = parts[3]?.component?.values?.[0];
    const profile = { ...previous };

    if (race === '__none__') profile.race = undefined;
    else if (typeof race === 'string' && race) profile.race = race;

    if (achievement === '__none__') profile.achievement = undefined;
    else if (typeof achievement === 'string' && achievement) {
      const stage = String(stageRaw ?? '').trim() === '' ? previous.achievement?.stage : Number(stageRaw);
      if (!Number.isInteger(stage) || Number(stage) < 1 || Number(stage) > 5) {
        await i.respond({
          components: [
            {
              type: MessageComponentTypes.Container,
              components: [
                {
                  type: MessageComponentTypes.TextDisplay,
                  content: `${emoji('Wrong')} Achievement stage must be from 1 to 5.`,
                },
              ],
            },
          ],
          flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
        });
        return;
      }
      profile.achievement = { name: achievement, stage: Number(stage) };
    }

    if (typeof world === 'string' && world) profile.defaultWorld = world;
    await saveForgeProfile(userKey(), profile);
    await i.respond({
      components: [
        {
          type: MessageComponentTypes.Container,
          components: [
            {
              type: MessageComponentTypes.TextDisplay,
              content: `${emoji('Correct')} Forge profile saved. New builds will use these defaults.`,
            },
          ],
        },
      ],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    });
  });

  handlers.set('v2-resume-draft', async (i) => {
    const draft = await getForgeDraft(userKey());
    if (!draft) {
      await i.respond({
        components: [
          {
            type: MessageComponentTypes.Container,
            components: [
              {
                type: MessageComponentTypes.TextDisplay,
                content: `${emoji('Exclamation')} There is no draft to resume.`,
              },
            ],
          },
        ],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      return;
    }
    draft.mode = 'build';
    selections.set(userKey(), draft);
    await i.deferEdit();
    if (draft.variant && draft.ores && Object.keys(draft.ores).length) await renderV2BuildDashboard(draft);
    else await renderV2BuildSetup(draft);
  });

  handlers.set('v2-save-build', async (i) => {
    const data = selections.get(userKey());
    if (!data?.variant || !data.ores) return;
    await i.respond({
      customId: 'v2-save-build-submit',
      title: 'Save Build',
      components: [
        {
          type: MessageComponentTypes.Label,
          label: 'Build name',
          component: {
            type: MessageComponentTypes.TextInput,
            customId: 'v2-build-name',
            placeholder: `${data.variant} build`.slice(0, 100),
            style: TextStyles.Short,
            required: true,
            maxLength: 60,
          },
        },
      ],
    });
  });

  handlers.set('v2-save-build-submit', async (i) => {
    const data = selections.get(userKey());
    if (!data) return;
    const name = String(i.data?.components?.[0]?.component?.value ?? '').trim();
    if (!name) return;
    try {
      const saved = await saveForgeBuild(userKey(), name, data);
      await i.respond({
        components: [
          {
            type: MessageComponentTypes.Container,
            components: [
              { type: MessageComponentTypes.TextDisplay, content: `${emoji('Correct')} Saved **${saved.name}**.` },
            ],
          },
        ],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
    } catch (error) {
      await i.respond({
        components: [
          {
            type: MessageComponentTypes.Container,
            components: [
              { type: MessageComponentTypes.TextDisplay, content: `${emoji('Wrong')} ${friendlyRequestError(error)}` },
            ],
          },
        ],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
    }
  });

  handlers.set('v2-saved-builds', async (i) => {
    await i.deferEdit();
    await renderSavedBuilds();
  });

  handlers.set('v2-load-build', async (i) => {
    const id = String(i.data?.values?.[0] ?? '');
    const saved = await getSavedForgeBuild(userKey(), id);
    if (!saved) return;
    const data = structuredClone(saved.data);
    data.mode = 'build';
    selections.set(userKey(), data);
    await i.deferEdit();
    await renderV2BuildDashboard(data);
  });

  handlers.set('v2-compare-builds', async (i) => {
    const ids = (i.data?.values ?? []).map(String);
    if (ids.length !== 2) return;
    const [savedA, savedB] = await Promise.all([
      getSavedForgeBuild(userKey(), ids[0] ?? ''),
      getSavedForgeBuild(userKey(), ids[1] ?? ''),
    ]);
    if (!savedA || !savedB) return;
    if (savedA.data.equipmentType !== savedB.data.equipmentType) {
      await i.respond({
        components: [
          {
            type: MessageComponentTypes.Container,
            components: [
              {
                type: MessageComponentTypes.TextDisplay,
                content: `${emoji('Exclamation')} Compare two weapons or two armor builds, not one of each.`,
              },
            ],
          },
        ],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      return;
    }

    let buildA: any;
    let buildB: any;
    try {
      [buildA, buildB] = await Promise.all([fetchV2Build(savedA.data), fetchV2Build(savedB.data)]);
    } catch (error) {
      await i.respond({
        components: [
          {
            type: MessageComponentTypes.Container,
            components: [
              {
                type: MessageComponentTypes.TextDisplay,
                content: `${emoji('Wrong')} One of these saved builds is no longer valid with the current game data. Load it and update the recipe/item first.\n-# ${friendlyRequestError(error)}`,
              },
            ],
          },
        ],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      return;
    }
    const a = savedA.data.equipmentType === 'Weapon' ? buildA.weapon : buildA.armor;
    const b = savedB.data.equipmentType === 'Weapon' ? buildB.weapon : buildB.armor;
    const numberFromDisplay = (value: unknown) => Number(String(value ?? '0').replace(/[^0-9.-]/g, '')) || 0;
    const pctDelta = (from: number, to: number) => (from === 0 ? 0 : ((to - from) / from) * 100);

    let rows: string[];
    let conclusion: string;
    if (savedA.data.equipmentType === 'Weapon') {
      const dpsA = numberFromDisplay(a.dps?.estimated);
      const dpsB = numberFromDisplay(b.dps?.estimated);
      rows = [
        `Damage: **${a.hit_damage}** → **${b.hit_damage}**`,
        `Attack interval: **${a.final_attack_interval}s** → **${b.final_attack_interval}s**`,
        `Estimated DPS: **${a.dps?.estimated}** → **${b.dps?.estimated}**`,
        `Multiplier: **${a.avg_multi}x** → **${b.avg_multi}x**`,
        `Sell: **${a.sell_price_display}** → **${b.sell_price_display}**`,
      ];
      const delta = pctDelta(dpsA, dpsB);
      conclusion =
        Math.abs(delta) < 0.01
          ? 'Estimated DPS is effectively equal.'
          : `Build B has **${Math.abs(delta).toFixed(1)}% ${delta > 0 ? 'more' : 'less'}** estimated DPS than Build A.`;
    } else {
      const healthA = numberFromDisplay(a.enhanced_health ?? a.health);
      const healthB = numberFromDisplay(b.enhanced_health ?? b.health);
      rows = [
        `Health: **${a.health_display}** → **${b.health_display}**`,
        `Multiplier: **${a.avg_multi}x** → **${b.avg_multi}x**`,
        `Sell: **${a.sell_price_display}** → **${b.sell_price_display}**`,
      ];
      const delta = pctDelta(healthA, healthB);
      conclusion =
        Math.abs(delta) < 0.01
          ? 'Enhanced Health is effectively equal.'
          : `Build B has **${Math.abs(delta).toFixed(1)}% ${delta > 0 ? 'more' : 'less'}** enhanced Health than Build A.`;
    }

    await i.deferEdit();
    await interaction.edit({
      components: [
        {
          type: MessageComponentTypes.Container,
          components: [
            { type: MessageComponentTypes.TextDisplay, content: '# Build Comparison' },
            {
              type: MessageComponentTypes.TextDisplay,
              content: `**A · ${savedA.name}**\n${savedA.data.variant}\n\n**B · ${savedB.name}**\n${savedB.data.variant}`,
            },
            { type: MessageComponentTypes.Separator },
            { type: MessageComponentTypes.TextDisplay, content: rows.map((row) => `- ${row}`).join('\n') },
            { type: MessageComponentTypes.TextDisplay, content: `### Difference\n${conclusion}` },
            {
              type: MessageComponentTypes.ActionRow,
              components: [
                {
                  type: MessageComponentTypes.Button,
                  customId: 'v2-saved-builds',
                  label: 'Back to Saved Builds',
                  style: ButtonStyles.Secondary,
                },
              ],
            },
          ],
        },
      ],
      flags: MessageFlags.IsComponentsV2,
    });
  });

  handlers.set('v2-delete-build', async (i) => {
    const id = String(i.data?.values?.[0] ?? '');
    if (!id) return;
    await deleteSavedForgeBuild(userKey(), id);
    await i.deferEdit();
    await renderSavedBuilds();
  });

  handlers.set('v2-manage-existing-rune', async (i) => {
    const data = selections.get(userKey());
    const id = String(i.data?.values?.[0] ?? '');
    const selected = data?.runes?.find((rune) => rune.id === id);
    if (!data || !selected) return;
    data.runeTemp = { id, name: selected.name.replace(/^Rune:\s*/, '') };
    selections.set(userKey(), data);
    await i.deferEdit();
    await renderV2RuneDetail(data);
  });

  handlers.set('v2-reroll-existing-rune', async (i) => {
    const data = selections.get(userKey());
    const selected = data?.runes?.find((rune) => rune.id === data.runeTemp?.id);
    if (!data || !selected) return;
    const runeName = selected.name.replace(/^Rune:\s*/, '');
    const rune = await makeRequest('http://localhost:9999/runes', {
      method: RequestMethod.GET,
      response: ResponseType.JSON,
      params: { name: runeName },
      headers: apiHeaders,
    });
    const fields = Array.isArray(rune.roll_fields) ? rune.roll_fields : [];
    if (!fields.length || fields.length > 5 || rune.source?.configuration_supported === false) return;
    data.runeTemp = {
      id: selected.id,
      name: runeName,
      rollFields: fields.map((field: any) => ({
        key: String(field.key),
        label: String(field.label),
        min: Number(field.min),
        max: Number(field.max),
        unit: String(field.unit ?? 'flat'),
        input_scale: Number(field.input_scale ?? 1),
        use_lowest: Boolean(field.use_lowest),
        source_verified: Boolean(field.source_verified),
      })),
    };
    selections.set(userKey(), data);
    await i.deferEdit();
    await renderV2RunePreset(data);
  });

  handlers.set('v2-remove-rune', async (i) => {
    const data = selections.get(userKey());
    if (!data?.runeTemp?.id) return;
    data.runes = (data.runes ?? []).filter((rune) => rune.id !== data.runeTemp?.id);
    data.runeTemp = undefined;
    selections.set(userKey(), data);
    await i.deferEdit();
    await renderV2RuneManager(data);
  });

  handlers.set('v2-remove-subtrait', async (i) => {
    const data = selections.get(userKey());
    const selected = data?.runes?.find((rune) => rune.id === data.runeTemp?.id);
    const index = Number(i.data?.values?.[0]);
    if (!data || !selected || !Number.isInteger(index) || index < 0 || index >= (selected.subtraits?.length ?? 0))
      return;
    selected.subtraits?.splice(index, 1);
    selections.set(userKey(), data);
    await i.deferEdit();
    await renderV2RuneDetail(data);
  });

  handlers.set('v2-add-subtrait', async (i) => {
    const data = selections.get(userKey());
    const selected = data?.runes?.find((rune) => rune.id === data.runeTemp?.id);
    if (!data || !selected) return;
    const rune = await makeRequest('http://localhost:9999/runes', {
      method: RequestMethod.GET,
      response: ResponseType.JSON,
      params: { name: selected.name.replace(/^Rune:\s*/, '') },
      headers: apiHeaders,
    });
    const existing = new Set(
      (selected.subtraits ?? []).map((subtrait) => subtrait.subtrait.replace(/^Secondary:\s*/, '')),
    );
    const available = Object.entries(rune.subtraits ?? {}).filter(([name]) => !existing.has(name));
    if (!available.length) return;
    await i.respond({
      customId: 'v2-subtrait-submit',
      title: 'Add Rune Subtrait',
      components: [
        {
          type: MessageComponentTypes.Label,
          label: 'Subtrait',
          component: {
            type: MessageComponentTypes.StringSelect,
            customId: 'v2-subtrait-name',
            options: available.slice(0, 25).map(([name, def]: [string, any]) => ({
              label: name,
              value: name,
              description: `${def.min}-${def.max}%${def.source_verified === false ? ' · unverified range' : ''}`.slice(
                0,
                100,
              ),
            })),
            required: true,
          },
        },
        {
          type: MessageComponentTypes.Label,
          label: 'Roll value (%)',
          component: {
            type: MessageComponentTypes.TextInput,
            customId: 'v2-subtrait-value',
            placeholder: 'Enter a value inside the shown range',
            style: TextStyles.Short,
            required: true,
          },
        },
      ],
    });
  });

  handlers.set('v2-subtrait-submit', async (i) => {
    const data = selections.get(userKey());
    const selected = data?.runes?.find((rune) => rune.id === data.runeTemp?.id);
    if (!data || !selected) return;
    const name = String(i.data?.components?.[0]?.component?.values?.[0] ?? '');
    const value = Number(i.data?.components?.[1]?.component?.value);
    const rune = await makeRequest('http://localhost:9999/runes', {
      method: RequestMethod.GET,
      response: ResponseType.JSON,
      params: { name: selected.name.replace(/^Rune:\s*/, '') },
      headers: apiHeaders,
    });
    const definition = rune.subtraits?.[name];
    if (!definition || !Number.isFinite(value) || value < definition.min || value > definition.max) {
      await i.respond({
        components: [
          {
            type: MessageComponentTypes.Container,
            components: [
              {
                type: MessageComponentTypes.TextDisplay,
                content: `${emoji('Wrong')} Enter a valid ${name || 'subtrait'} value inside its allowed range.`,
              },
            ],
          },
        ],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      return;
    }
    const maxSubtraits = Number(rune.max_subtraits ?? 0);
    if ((selected.subtraits?.length ?? 0) >= maxSubtraits) return;
    const key = definition.key || name.toLowerCase().replace(/\s+/g, '_');
    (selected.subtraits ??= []).push({ subtrait: `Secondary: ${name}`, roll: { [key]: value } });
    selections.set(userKey(), data);
    await i.deferEdit();
    await renderV2RuneDetail(data);
  });

  handlers.set('v2-select-rune', async (i) => {
    const selectedRune = String(i.data?.values?.[0] ?? '');
    const data = selections.get(userKey());
    if (!data || !selectedRune) return;

    const rune = await makeRequest('http://localhost:9999/runes', {
      method: RequestMethod.GET,
      response: ResponseType.JSON,
      params: { name: selectedRune },
      headers: apiHeaders,
    });
    const fields = Array.isArray(rune.roll_fields) ? rune.roll_fields : [];
    if (rune.source?.configuration_supported === false || fields.length === 0 || fields.length > 5) {
      await i.respond({
        components: [
          {
            type: MessageComponentTypes.Container,
            components: [
              {
                type: MessageComponentTypes.TextDisplay,
                content: `${emoji('Exclamation')} ${highlight(selectedRune)} cannot be configured accurately with the numeric source data currently available.`,
              },
            ],
          },
        ],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      return;
    }

    data.runeTemp = {
      id: randomUUID(),
      name: selectedRune,
      rollFields: fields.map((field: any) => ({
        key: String(field.key),
        label: String(field.label),
        min: Number(field.min),
        max: Number(field.max),
        unit: String(field.unit ?? 'flat'),
        input_scale: Number(field.input_scale ?? 1),
        use_lowest: Boolean(field.use_lowest),
        source_verified: Boolean(field.source_verified),
      })),
    };
    selections.set(userKey(), data);
    await i.deferEdit();
    await renderV2RunePreset(data);
  });

  handlers.set('v2-configure-rune-values', async (i) => {
    const data = selections.get(userKey());
    if (!data?.runeTemp?.rollFields?.length) return;
    const runeValues: Record<string, number> = {};
    const rollMeta: Record<string, StoredRuneRollMeta> = {};
    const fields = data.runeTemp.rollFields;

    for (const comp of i.data?.components ?? []) {
      const customId = String(comp.component?.customId ?? '');
      const match = customId.match(/^rune-roll-(\d+)$/);
      if (!match) continue;
      const field = fields[Number(match[1])];
      if (!field) continue;
      const value = Number(comp.component?.value);
      if (!Number.isFinite(value) || value < field.min || value > field.max) {
        await i.respond({
          components: [
            {
              type: MessageComponentTypes.Container,
              components: [
                {
                  type: MessageComponentTypes.TextDisplay,
                  content: `${emoji('Wrong')} ${field.label} must be between ${field.min} and ${field.max}${field.unit === '%' ? '%' : ''}.`,
                },
              ],
            },
          ],
          flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
        });
        return;
      }
      runeValues[field.key] = Math.round(value * field.input_scale * 1e8) / 1e8;
      rollMeta[field.key] = { label: field.label, unit: field.unit, input_scale: field.input_scale };
    }

    if (Object.keys(runeValues).length !== fields.length) {
      await i.respond({
        components: [
          {
            type: MessageComponentTypes.Container,
            components: [
              { type: MessageComponentTypes.TextDisplay, content: `${emoji('Wrong')} Complete every rune roll field.` },
            ],
          },
        ],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      return;
    }

    const existingIndex = (data.runes ?? []).findIndex((rune) => rune.id === data.runeTemp?.id);
    if (existingIndex >= 0) {
      const existing = data.runes?.[existingIndex];
      if (existing) {
        existing.roll = runeValues;
        existing.roll_meta = rollMeta;
      }
    } else {
      (data.runes ??= []).push({
        id: data.runeTemp.id ?? randomUUID(),
        name: `Rune: ${data.runeTemp.name}`,
        roll: runeValues,
        roll_meta: rollMeta,
      });
    }
    data.runeTemp = undefined;
    selections.set(userKey(), data);
    await i.deferEdit();
    await renderV2RuneManager(data);
  });

  handlers.set('v2-rune-manager', async (i) => {
    const data = selections.get(userKey());
    if (!data) return;
    await i.deferEdit();
    await renderV2RuneManager(data);
  });

  handlers.set('v2-clear-runes', async (i) => {
    const data = selections.get(userKey());
    if (!data) return;
    data.runes = [];
    selections.set(userKey(), data);
    await i.deferEdit();
    await renderV2RuneManager(data);
  });

  handlers.set('v2-rune-best', async (i) => {
    const data = selections.get(userKey());
    if (!data?.runeTemp?.rollFields?.length) return;
    await i.deferEdit();
    await applyRunePreset(data, 'best');
  });

  handlers.set('v2-rune-average', async (i) => {
    const data = selections.get(userKey());
    if (!data?.runeTemp?.rollFields?.length) return;
    await i.deferEdit();
    await applyRunePreset(data, 'average');
  });

  handlers.set('v2-rune-worst', async (i) => {
    const data = selections.get(userKey());
    if (!data?.runeTemp?.rollFields?.length) return;
    await i.deferEdit();
    await applyRunePreset(data, 'worst');
  });

  handlers.set('v2-rune-custom', async (i) => {
    const data = selections.get(userKey());
    if (!data?.runeTemp?.rollFields?.length) return;
    if (data.runeTemp.rollFields.length > 5) return;
    await i.respond({
      customId: 'v2-configure-rune-values',
      title: `Configure ${data.runeTemp.name}`,
      components: data.runeTemp.rollFields.map((field, index) => ({
        type: MessageComponentTypes.Label,
        label: field.label,
        component: {
          type: MessageComponentTypes.TextInput,
          customId: `rune-roll-${index}`,
          placeholder: `${field.min} to ${field.max}${field.unit === '%' ? '%' : field.unit === 'seconds' ? 's' : field.unit === 'studs' ? ' studs' : ''}`,
          style: TextStyles.Short,
          required: true,
        },
      })),
    });
  });

  registerForgeDamageModifiers({
    handlers,
    selections,
    interaction,
    apiHeaders,
    renderBuild: renderV2BuildDashboard,
  });
}
