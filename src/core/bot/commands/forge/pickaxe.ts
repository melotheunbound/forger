import { FORGER_API_KEY } from 'core/variables';
import {
  ApplicationCommandOptionTypes,
  DiscordApplicationIntegrationType,
  DiscordInteractionContextType,
  MessageComponentTypes,
  MessageFlags,
} from 'discordeno';
import createApplicationCommand from 'helpers/command';
import { ApplicationCommandCategory, RequestMethod, ResponseType } from 'types/types';
import { makeRequest } from 'utils/request';

createApplicationCommand({
  name: 'pickaxe',
  description: 'Views information about the selected pickaxe',
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
      type: ApplicationCommandOptionTypes.String,
      name: 'pickaxe',
      description: 'Pick a pickaxe to view information about',
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

    const res = await makeRequest('http://localhost:9999/pickaxes', {
      method: RequestMethod.GET,
      response: ResponseType.JSON,
      headers: {
        'x-api-key': FORGER_API_KEY,
      },
    });

    const choices = res
      .filter((pickaxe: any) => {
        if (!focused) return true;
        return String(pickaxe.name ?? '')
          .toLowerCase()
          .includes(focused);
      })
      .slice(0, 25)
      .map((pickaxe: any) => ({
        name: String(pickaxe.name ?? 'Unknown Pickaxe'),
        value: String(pickaxe.name ?? ''),
      }))
      .filter((pickaxe: any) => pickaxe.value);

    return interaction.respond({ choices });
  },
  async run(bot, interaction, options) {
    const res = await makeRequest('http://localhost:9999/pickaxes', {
      method: RequestMethod.GET,
      response: ResponseType.JSON,
      params: {
        name: options.pickaxe,
      },
      headers: {
        'x-api-key': FORGER_API_KEY,
      },
    });

    const components: any[] = [
      {
        type: MessageComponentTypes.Section,
        components: [
          {
            type: MessageComponentTypes.TextDisplay,
            content: `# ${res.name ?? 'Unknown Pickaxe'}\n-# ${res.rarity ?? 'Unknown rarity'}`,
          },
        ],
        ...(res.image
          ? {
              accessory: {
                type: MessageComponentTypes.Thumbnail,
                media: { url: res.image },
              },
            }
          : {}),
      },
    ];

    if (res.description) {
      components.push({
        type: MessageComponentTypes.TextDisplay,
        content: `### Description\n> ${String(res.description).replace(/\n/g, '\n> ')}`,
      });
    }

    components.push({ type: MessageComponentTypes.Separator });
    components.push({
      type: MessageComponentTypes.TextDisplay,
      content: [
        res.mine_power != null ? `- **Mine Power:** ${res.mine_power}` : '',
        res.mine_speed != null ? `- **Mine Speed:** ${res.mine_speed}` : '',
        res.luck_boost != null ? `- **Luck Boost:** ${res.luck_boost}` : '',
        res.rune_slots != null ? `- **Rune Slots:** ${res.rune_slots}` : '',
        res.rune_price != null ? `- **Rune Price:** ${res.rune_price}` : '',
        res.price != null ? `- **Price:** ${res.price}` : '',
        res.tickets != null ? `- **Tickets:** ${res.tickets}` : '',
        res.goblin_price != null ? `- **Goblin Price:** ${res.goblin_price}` : '',
        res.sell_price != null ? `- **Sell Price:** ${res.sell_price}` : '',
      ]
        .filter(Boolean)
        .join('\n') || '-# No stat data is available for this pickaxe.',
    });

    if (res.requirement) {
      const typeLabel =
        res.requirement.type === 'quest'
          ? 'Quest requirement'
          : res.requirement.type === 'item'
            ? 'Item requirement'
            : 'Unlock requirement';
      components.push({ type: MessageComponentTypes.Separator });
      components.push({
        type: MessageComponentTypes.TextDisplay,
        content: `### How to Obtain\n- **${typeLabel}:** ${res.requirement.requirement}${
          res.requirement.details ? `\n-# ${res.requirement.details}` : ''
        }`,
      });
    }

    await interaction.edit({
      components: [
        {
          type: MessageComponentTypes.Container,
          components,
        },
      ],
      flags: MessageFlags.IsComponentsV2,
    });
  },
});
