import { FORGER_API_KEY } from 'core/variables';
import {
  ApplicationCommandOptionTypes,
  DiscordApplicationIntegrationType,
  DiscordInteractionContextType,
  MessageFlags,
} from 'discordeno';
import createApplicationCommand from 'helpers/command';
import { ApplicationCommandCategory, RequestMethod, ResponseType } from 'types/types';
import { makeRequest } from 'utils/request';
import { buildRuneComponents } from './runePresentation';

createApplicationCommand({
  name: 'rune',
  description: 'Views information about the selected rune',
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
      name: 'rune',
      description: 'Pick a rune to view information about',
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

    const res = await makeRequest('http://localhost:9999/runes', {
      method: RequestMethod.GET,
      response: ResponseType.JSON,
      headers: { 'x-api-key': FORGER_API_KEY },
    });

    return interaction.respond({
      choices: res
        .filter((rune: any) => !focused || rune.name.toLowerCase().includes(focused))
        .slice(0, 25)
        .map((rune: any) => ({ name: rune.name, value: rune.name })),
    });
  },
  async run(bot, interaction, options) {
    const res = await makeRequest('http://localhost:9999/runes', {
      method: RequestMethod.GET,
      response: ResponseType.JSON,
      params: { name: options.rune },
      headers: { 'x-api-key': FORGER_API_KEY },
    });

    await interaction.edit({
      components: buildRuneComponents(res),
      flags: MessageFlags.IsComponentsV2,
    });
  },
});
