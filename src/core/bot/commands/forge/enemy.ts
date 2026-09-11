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
import { makeRequest } from 'utils/request';

const formatRange = (range: any) => {
  if (!range || (range.min == null && range.max == null)) return 'Not available';
  const min = range.min ?? '?';
  const max = range.max ?? '?';
  return min === max ? String(min) : `${min} - ${max}`;
};

createApplicationCommand({
  name: 'enemy',
  description: 'Views information about the selected enemy',
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
      name: 'enemy',
      description: 'Pick an enemy to view information about',
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

    const res = await makeRequest('http://localhost:9999/mobs', {
      method: RequestMethod.GET,
      response: ResponseType.JSON,
      headers: {
        'x-api-key': FORGER_API_KEY,
      },
    });

    const choices = (Array.isArray(res) ? res : [])
      .filter((enemy: any) => {
        if (!focused) return true;
        return String(enemy.name ?? '')
          .toLowerCase()
          .includes(focused);
      })
      .slice(0, 25)
      .map((enemy: any) => ({
        name: String(enemy.name ?? 'Unknown Enemy'),
        value: String(enemy.name ?? ''),
      }))
      .filter((enemy: any) => enemy.value);

    return interaction.respond({ choices });
  },
  async run(bot, interaction, options) {
    const res = await makeRequest('http://localhost:9999/mobs', {
      method: RequestMethod.GET,
      response: ResponseType.JSON,
      params: {
        name: options.enemy,
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
            content: `# ${res.name ?? 'Unknown Enemy'}`,
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

    if (Array.isArray(res.location) && res.location.length > 0) {
      const locationOptions = res.location
        .flatMap((loc: any) =>
          (Array.isArray(loc?.world) ? loc.world : []).map((world: string) => ({
            label: String(world).slice(0, 100),
            value: String(world).slice(0, 100),
            ...(Array.isArray(loc?.area) && loc.area.length
              ? { description: loc.area.join(', ').slice(0, 100) }
              : {}),
          })),
        )
        .slice(0, 25);

      if (locationOptions.length) {
        components.push({
          type: MessageComponentTypes.ActionRow,
          components: [
            {
              type: MessageComponentTypes.StringSelect,
              customId: 'mob-locations',
              placeholder: 'Locations',
              options: locationOptions,
            },
          ],
        });
      }
    }

    components.push({ type: MessageComponentTypes.Separator });
    components.push({
      type: MessageComponentTypes.TextDisplay,
      content: [
        `- **Level Range:** ${formatRange(res.level_range)}`,
        `- **Health:** ${formatRange(res.health)}`,
        `- **Damage:** ${formatRange(res.damage)}`,
        `- **Gold:** ${formatRange(res.gold)}`,
        `- **Experience:** ${formatRange(res.experience)}`,
      ].join('\n'),
    });

    if (Array.isArray(res.drops) && res.drops.length > 0) {
      components.push({ type: MessageComponentTypes.Separator });
      components.push({
        type: MessageComponentTypes.TextDisplay,
        content: `### Drops\n${res.drops
          .map((drop: any) => {
            const qty =
              drop.quantity_min != null && drop.quantity_max != null
                ? drop.quantity_min === drop.quantity_max
                  ? `${drop.quantity_min}x `
                  : `${drop.quantity_min}-${drop.quantity_max}x `
                : '';
            const chance = drop.guaranteed
              ? 'Guaranteed'
              : drop.chance_fraction ??
                (drop.chance != null
                  ? `${drop.chance}${drop.chance_percent != null ? ` (${Number(Number(drop.chance_percent).toFixed(4))}%)` : ''}`
                  : 'Chance unavailable');
            return `- ${qty}${drop.name ?? drop.item ?? 'Unknown drop'} — **${chance}**`;
          })
          .join('\n')}`,
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
