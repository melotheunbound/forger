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
  name: 'weapon',
  description: 'Views information about the selected weapon',
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
      name: 'weapon',
      description: 'Pick a weapon to view information about',
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

    const res = await makeRequest('http://localhost:9999/weapons', {
      method: RequestMethod.GET,
      response: ResponseType.JSON,
      headers: {
        'x-api-key': FORGER_API_KEY,
      },
    });

    const variants = res.flatMap((weapon: any) =>
      weapon.variants.map((variant: any) => ({
        name: variant.name,
        value: variant.name,
      })),
    );

    const choices = variants.filter((v: any) => !focused || v.name.toLowerCase().includes(focused)).slice(0, 25);

    return interaction.respond({ choices });
  },
  async run(bot, interaction, options) {
    const res = await makeRequest(`http://localhost:9999/weapons`, {
      method: RequestMethod.GET,
      response: ResponseType.JSON,
      params: {
        name: options.weapon,
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
                  content: `# ${res.name}\n-# ${res.type}`,
                },
              ],
              accessory: {
                type: MessageComponentTypes.Thumbnail,
                media: {
                  url: res.image,
                },
              },
            },
            {
              type: MessageComponentTypes.ActionRow,
              components: [
                {
                  type: MessageComponentTypes.StringSelect,
                  customId: 'weapon-location',
                  placeholder: 'Obtainable From:',
                  options: res.from.map((item: any) => ({
                    label: item,
                    value: item.toLowerCase().replace(/\s+/g, '_'),
                  })),
                },
              ],
            },
            {
              type: MessageComponentTypes.Separator,
            },
            {
              type: MessageComponentTypes.TextDisplay,
              content: `## Information:\n- Damage: **${res.damage}**\n- Index Speed: **${res.index_speed ?? res.attack_speed}s**
- Real Speed: **${res.real_speed ?? res.attack_speed}s**\n- Damage Per Second: **${res.damage_per_second}**\n- Range: **${res.attack_range} studs**\n- Chance: **${res.chance}**\n- Minimum Ore Requirement: **${res.min_ores}**\n- Base Price: **${res.base_price}**`,
            },
          ],
        },
      ],
      flags: MessageFlags.IsComponentsV2,
    });
  },
});
