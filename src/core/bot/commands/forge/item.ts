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

const EFFECT_LABELS: Record<string, string> = {
  duration_seconds: 'Duration',
  health_restore_total: 'Health Restored',
};

const formatEffectLabel = (key: string) =>
  EFFECT_LABELS[key] ??
  key
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());

const formatEffectValue = (key: string, value: unknown) => {
  if (value == null) return 'Not available';
  if (key === 'duration_seconds' && typeof value === 'number') return `${value}s`;
  return String(value);
};

createApplicationCommand({
  name: 'item',
  description: 'Views information about the selected item',
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
      name: 'item',
      description: 'Pick an item to view information about',
      type: ApplicationCommandOptionTypes.String,
      required: true,
      autocomplete: true,
    },
  ],
  acknowledge: true,
  async autocomplete(bot, interaction) {
    const focused =
      interaction.data?.options
        ?.find((opt) => opt.focused)
        ?.value?.toString()
        .toLowerCase() ?? '';

    const res = await makeRequest('http://localhost:9999/items', {
      method: RequestMethod.GET,
      response: ResponseType.JSON,
      headers: {
        'x-api-key': FORGER_API_KEY,
      },
    });

    const choices = (Array.isArray(res) ? res : [])
      .filter((item: any) =>
        String(item.name ?? '')
          .toLowerCase()
          .includes(focused),
      )
      .slice(0, 25)
      .map((item: any) => ({
        name: String(item.name),
        value: String(item.name),
      }));

    return interaction.respond({ choices });
  },
  async run(bot, interaction, options) {
    const res = await makeRequest('http://localhost:9999/items', {
      method: RequestMethod.GET,
      response: ResponseType.JSON,
      params: {
        name: options.item,
      },
      headers: {
        'x-api-key': FORGER_API_KEY,
      },
    });

    const effects =
      res.effects && typeof res.effects === 'object'
        ? Object.entries(res.effects).filter(([, value]) => value != null)
        : [];

    const components: any[] = [
      {
        type: MessageComponentTypes.TextDisplay,
        content: `# ${res.name ?? 'Unknown Item'}\n-# ${res.category ?? 'Unknown category'}${res.price?.formatted ? ` · ${res.price.formatted}` : ''}`,
      },
    ];

    if (res.description) {
      components.push({
        type: MessageComponentTypes.TextDisplay,
        content: `### Description\n> ${String(res.description).replace(/\n/g, '\n> ')}`,
      });
    }

    if (effects.length) {
      components.push({ type: MessageComponentTypes.Separator });
      components.push({
        type: MessageComponentTypes.TextDisplay,
        content: `### Effects\n${effects
          .map(([key, value]) => `- **${formatEffectLabel(key)}:** ${formatEffectValue(key, value)}`)
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
