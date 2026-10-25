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
  name: 'pickaxe',
  description: "Preview one of Forge's pickaxes",
  integrationTypes: [ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall],
  contexts: [InteractionContextType.BotDM, InteractionContextType.Guild, InteractionContextType.PrivateChannel],
  options: [
    {
      type: ApplicationCommandOptionType.String,
      name: 'name',
      description: 'The name of the pickaxe to preview',
      required: true,
      autocomplete: true,
    },
  ],
  acknowledge: true,
  async autocomplete(interaction, client) {
    const focused = getAutocompleteFocusedOption(interaction.data.options)
    const value = String(focused?.value ?? '').toLowerCase()

    const pickaxes = await makeRequest('http://localhost:9999/pickaxes', {
      method: RequestMethod.GET,
      response: ResponseType.JSON,
      headers: {
        'x-api-key': env.get('forger_api_key', true).toString(),
      },
    })

    const choices = pickaxes
      .filter((pickaxe: any) => pickaxe.name.toLowerCase().includes(value))
      .map((pickaxe: any) => ({
        name: pickaxe.name,
        value: pickaxe.name,
      }))
      .slice(0, 25)

    await client.api.interactions.createAutocompleteResponse(interaction.id, interaction.token, { choices })
  },
  async run(interaction, options, client) {
    const { name } = options

    const pickaxe = await makeRequest(`http://localhost:9999/pickaxes`, {
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
            ...(pickaxe.image
              ? ([
                  {
                    type: ComponentType.Section,
                    components: [
                      {
                        type: ComponentType.TextDisplay,
                        content: `## ${pickaxe.name}\n-# ${pickaxe.rarity}\n*${pickaxe.description}*${pickaxe.skin_only ? `\n> Skin Only` : ''}`,
                      },
                    ],
                    accessory: {
                      type: ComponentType.Thumbnail,
                      media: {
                        url: pickaxe.image,
                      },
                    },
                  },
                ] satisfies APIMessageTopLevelComponent[])
              : ([
                  {
                    type: ComponentType.TextDisplay,
                    content: `## ${pickaxe.name}\n-# ${pickaxe.rarity}\n*${pickaxe.description}*${pickaxe.skin_only ? `\n> Skin Only` : ''}`,
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
                  custom_id: 'pickaxe_info',
                  placeholder: 'Pickaxe Information:',
                  options: [
                    {
                      label: 'Mine Power',
                      value: 'mine_power',
                      description: pickaxe.mine_power,
                    },
                    ...(pickaxe.mine_speed != null
                      ? [{ label: 'Mine Speed', value: 'mine_speed', description: pickaxe.mine_speed }]
                      : []),
                    ...(pickaxe.luck_boost != null
                      ? [{ label: 'Luck Boost', value: 'luck_boost', description: pickaxe.luck_boost }]
                      : []),
                    ...(pickaxe.rune_slots != null
                      ? [{ label: 'Rune Slots', value: 'rune_slots', description: pickaxe.rune_slots }]
                      : []),
                    ...(pickaxe.rune_price != null
                      ? [{ label: 'Rune Price', value: 'rune_price', description: pickaxe.rune_price }]
                      : []),
                    ...(pickaxe.price != null ? [{ label: 'Price', value: 'price', description: pickaxe.price }] : []),
                    ...(pickaxe.goblin_price != null
                      ? [{ label: 'Goblin Price', value: 'goblin_price', description: pickaxe.goblin_price }]
                      : []),
                    ...(pickaxe.sell_price != null
                      ? [{ label: 'Sell Price', value: 'sell_price', description: pickaxe.sell_price }]
                      : []),
                  ] satisfies APISelectMenuOption[],
                },
              ],
            },
            {
              type: ComponentType.Separator,
            },
            ...(pickaxe.requirement
              ? ([
                  {
                    type: ComponentType.TextDisplay,
                    content: `### Requirement:\n> ${pickaxe.requirement.requirement}${pickaxe.requirement.details ? `\n> -# ${pickaxe.requirement.details}` : ''}`,
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
