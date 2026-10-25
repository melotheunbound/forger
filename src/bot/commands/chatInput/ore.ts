import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  ApplicationIntegrationType,
  ComponentType,
  InteractionContextType,
  MessageFlags,
  type APIMessageTopLevelComponent,
  type APISelectMenuOption,
} from '@discordjs/core'
import createApplicationCommand from '../../../builders/command'
import { getAutocompleteFocusedOption } from '../../../utils/utils'
import { makeRequest } from '../../../utils/request'
import { RequestMethod, ResponseType } from '../../../types/types'
import env from '../../../utils/env'

createApplicationCommand({
  type: ApplicationCommandType.ChatInput,
  name: 'ore',
  description: "Preview one of Forge's ores",
  integrationTypes: [ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall],
  contexts: [InteractionContextType.BotDM, InteractionContextType.Guild, InteractionContextType.PrivateChannel],
  options: [
    {
      type: ApplicationCommandOptionType.String,
      name: 'name',
      description: 'The name of the ore to preview',
      required: true,
      autocomplete: true,
    },
  ],
  acknowledge: true,
  async autocomplete(interaction, client) {
    const focused = getAutocompleteFocusedOption(interaction.data.options)
    const value = String(focused?.value ?? '').toLowerCase()

    const ores = await makeRequest('http://localhost:9999/ores', {
      method: RequestMethod.GET,
      response: ResponseType.JSON,
      headers: {
        'x-api-key': env.get('forger_api_key', true).toString(),
      },
    })

    const choices = ores
      .filter((ore: any) => ore.name.toLowerCase().includes(value))
      .map((ore: any) => ({
        name: ore.name,
        value: ore.name,
      }))
      .slice(0, 25)

    await client.api.interactions.createAutocompleteResponse(interaction.id, interaction.token, { choices })
  },
  async run(interaction, options, client) {
    const { name } = options

    const ore = await makeRequest(`http://localhost:9999/ores`, {
      method: RequestMethod.GET,
      response: ResponseType.JSON,
      params: {
        name,
      },
      headers: {
        'x-api-key': env.get('forger_api_key', true).toString(),
      },
    })

    await client.api.interactions.respond(interaction.application_id, interaction.id, interaction.token, {
      components: [
        {
          type: ComponentType.Container,
          components: [
            ...(ore.image
              ? ([
                  {
                    type: ComponentType.Section,
                    components: [
                      {
                        type: ComponentType.TextDisplay,
                        content: `## ${ore.name}\n-# ${ore.rarity}\n*${ore.description}*${ore.trait ? `\n> ${ore.trait.description}` : ''}`,
                      },
                    ],
                    accessory: {
                      type: ComponentType.Thumbnail,
                      media: {
                        url: ore.image,
                      },
                    },
                  },
                ] satisfies APIMessageTopLevelComponent[])
              : ([
                  {
                    type: ComponentType.TextDisplay,
                    content: `## ${ore.name}\n-# ${ore.rarity}\n*${ore.description}*${ore.trait ? `\n> ${ore.trait.description}` : ''}`,
                  },
                ] satisfies APIMessageTopLevelComponent[])),
            {
              type: ComponentType.Separator,
            },
            {
              type: ComponentType.ActionRow,
              components: [
                {
                  type: ComponentType.StringSelect,
                  custom_id: 'ore_info',
                  placeholder: 'Ore Information:',
                  options: [
                    {
                      label: 'Chance',
                      value: 'chance',
                      description: ore.chance,
                    },
                    {
                      label: 'Multiplier',
                      value: 'multiplier',
                      description: `${ore.multiplier}×`,
                    },
                    {
                      label: 'Price',
                      value: 'price',
                      description: ore.price,
                    },
                    ...(ore.unique_price_multiplier
                      ? ([
                          {
                            label: 'Unique Price Multiplier',
                            value: 'unique_price_multiplier',
                            description: `${ore.unique_price_multiplier}×`,
                          },
                        ] satisfies APISelectMenuOption[])
                      : []),
                  ],
                },
              ],
            },
            {
              type: ComponentType.Separator,
            },
            ...(ore.from.some((source: any) => source.source === 'Rock')
              ? ([
                  {
                    type: ComponentType.TextDisplay,
                    content: `### Rocks:\n${ore.from
                      .filter((source: any) => source.source === 'Rock')
                      .flatMap((item: any) => item.rock)
                      .map((rock: string) => `> - ${rock}`)
                      .join('\n')}`,
                  },
                ] satisfies APIMessageTopLevelComponent[])
              : []),
            ...(ore.from.some((source: any) => source.source === 'Enemy')
              ? ([
                  {
                    type: ComponentType.TextDisplay,
                    content: `### Mobs:\n${ore.from
                      .filter((source: any) => source.source === 'Enemy')
                      .flatMap((item: any) =>
                        item.enemy.map(
                          (enemy: string) =>
                            `> - ${enemy}${item.drop_chance != null ? ` (${item.drop_chance * 100}%)` : ''}`,
                        ),
                      )
                      .join('\n')}`,
                  },
                ] satisfies APIMessageTopLevelComponent[])
              : []),
            ...(ore.from.some((source: any) => source.source === 'Crafting')
              ? ([
                  {
                    type: ComponentType.TextDisplay,
                    content: `### Recipe:\n${ore.from
                      .filter((source: any) => source.source === 'Crafting')
                      .map(
                        (item: any) =>
                          `> - ${Object.entries(item.recipe as Record<string, number>)
                            .map(([name, amount]) => `${amount}× ${name}`)
                            .join(', ')}`,
                      )
                      .join('\n')}`,
                  },
                ] satisfies APIMessageTopLevelComponent[])
              : []),
          ],
        },
      ],
      flags: MessageFlags.IsComponentsV2,
    })
  },
})
