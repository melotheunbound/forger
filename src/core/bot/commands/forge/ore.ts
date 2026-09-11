import { FORGER_API_KEY } from 'core/variables';
import {
  ApplicationCommandOptionTypes,
  DiscordApplicationIntegrationType,
  DiscordInteractionContextType,
  MessageComponentTypes,
  MessageFlags,
  type MessageComponents,
} from 'discordeno';
import createApplicationCommand from 'helpers/command';
import { ApplicationCommandCategory, RequestMethod, ResponseType } from 'types/types';
import { truncate } from 'utils/markdown';
import { makeRequest } from 'utils/request';
import { normalizeUiText } from './forgeFormatting';

createApplicationCommand({
  name: 'ore',
  description: 'Views information about the selected ore',
  details: {
    category: ApplicationCommandCategory.Forge,
    cooldown: 5,
  },
  integrationTypes: [DiscordApplicationIntegrationType.GuildInstall, DiscordApplicationIntegrationType.UserInstall],
  contexts: [
    DiscordInteractionContextType.BotDm,
    DiscordInteractionContextType.Guild,
    DiscordInteractionContextType.PrivateChannel,
  ],
  options: [
    {
      name: 'ore',
      description: 'Pick an ore to view information about',
      type: ApplicationCommandOptionTypes.String,
      required: true,
      autocomplete: true,
    },
  ],
  acknowledge: true,
  async autocomplete(bot, interaction, options) {
    const focused =
      interaction.data?.options
        ?.find((opt) => opt.focused)
        ?.value?.toString()
        .toLowerCase() ?? '';
    const res = await makeRequest('http://localhost:9999/ores', {
      method: RequestMethod.GET,
      response: ResponseType.JSON,
      headers: {
        'x-api-key': FORGER_API_KEY,
      },
    });
    const choices = res
      .filter((ore: any) => {
        if (!focused) return true;
        return ore.name.toLowerCase().includes(focused);
      })
      .slice(0, 25)
      .map((ore: any) => ({
        name: ore.name,
        value: ore.name,
      }));
    return interaction.respond({ choices });
  },
  async run(bot, interaction, options) {
    const res = await makeRequest(`http://localhost:9999/ores`, {
      method: RequestMethod.GET,
      response: ResponseType.JSON,
      params: {
        name: options.ore,
      },
      headers: {
        'x-api-key': FORGER_API_KEY,
      },
    });

    await interaction.edit({
      components: [
        {
          type: MessageComponentTypes.Container,
          components: [
            {
              type: MessageComponentTypes.Section,
              components: [
                {
                  type: MessageComponentTypes.TextDisplay,
                  content: `# ${res.name}\n-# ${res.rarity}\n*${normalizeUiText(res.description)}*${res.trait ? `\n> ${normalizeUiText(res.trait.description)} (${normalizeUiText(res.trait.type)})` : '\n> None'}`,
                },
              ],
              accessory: {
                type: MessageComponentTypes.Thumbnail,
                media: {
                  url: res.image,
                },
              },
            },
            ...(res.from.some((s: any) => s.source === 'Rock')
              ? ([
                  {
                    type: MessageComponentTypes.TextDisplay,
                    content: '**Rock:**',
                  },
                  {
                    type: MessageComponentTypes.ActionRow,
                    components: [
                      {
                        type: MessageComponentTypes.StringSelect,
                        customId: 'ore-rock',
                        placeholder: 'Mineable From:',
                        options: res.from
                          .filter((s: any) => s.source === 'Rock')
                          .flatMap((item: any) =>
                            (item.world ?? []).map((world: string) => ({
                              label: world,
                              value: world,
                              description: truncate(item.rock?.join(', ') ?? '', 100),
                            })),
                          ),
                      },
                    ],
                  },
                ] satisfies MessageComponents)
              : []),
            ...(res.from.some((s: any) => s.source === 'Enemy')
              ? ([
                  {
                    type: MessageComponentTypes.TextDisplay,
                    content: '**Enemy:**',
                  },
                  {
                    type: MessageComponentTypes.ActionRow,
                    components: [
                      {
                        type: MessageComponentTypes.StringSelect,
                        customId: 'ore-enemy',
                        placeholder: 'Obtainable From:',
                        options: res.from
                          .filter((s: any) => s.source === 'Enemy')
                          .flatMap((item: any) =>
                            (item.world ?? []).map((world: string) => ({
                              label: world,
                              value: world,
                              description: truncate(
                                [
                                  item.enemy?.join(', '),
                                  item.drop_chance != null
                                    ? `${Number((item.drop_chance * 100).toFixed(4))}% drop`
                                    : null,
                                ]
                                  .filter(Boolean)
                                  .join(' - '),
                                100,
                              ),
                            })),
                          ),
                      },
                    ],
                  },
                ] satisfies MessageComponents)
              : []),
            ...(res.from.some((s: any) => s.source === 'Crafting')
              ? ([
                  {
                    type: MessageComponentTypes.TextDisplay,
                    content: `**Craft:**\n${res.from
                      .filter((s: any) => s.source === 'Crafting')
                      .map((item: any) => {
                        const location = [item.station, ...(item.region ?? [])].filter(Boolean).join(' — ');
                        const recipe = Object.entries(item.recipe ?? {})
                          .map(([name, qty]) => `- ${qty}x **${name}**`)
                          .join('\n');
                        return `${location ? `-# ${location}\n` : ''}${recipe}`;
                      })
                      .join('\n')}`,
                  },
                ] satisfies MessageComponents)
              : []),
            ...(res.from.some((s: any) => s.source === 'Raid')
              ? ([
                  {
                    type: MessageComponentTypes.TextDisplay,
                    content: `**Raid:**\n${res.from
                      .filter((s: any) => s.source === 'Raid')
                      .flatMap((item: any) => item.raid ?? item.region ?? [])
                      .map((raid: string) => `- **${raid}**`)
                      .join('\n')}`,
                  },
                ] satisfies MessageComponents)
              : []),
            {
              type: MessageComponentTypes.Separator,
            },
            {
              type: MessageComponentTypes.TextDisplay,
              content: `- Chance: **${res.chance}**\n- Multiplier: **${res.multiplier}x**\n- Price: **${res.price}**${res.unique_price_multiplier != null ? `\n- Unique Price Multiplier: **${res.unique_price_multiplier}x**` : ''}`,
            },
          ],
        },
      ],
      flags: MessageFlags.IsComponentsV2,
    });
  },
});
