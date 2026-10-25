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
  name: 'armor',
  description: "Preview one of Forge's armors",
  integrationTypes: [ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall],
  contexts: [InteractionContextType.BotDM, InteractionContextType.Guild, InteractionContextType.PrivateChannel],
  options: [
    {
      type: ApplicationCommandOptionType.String,
      name: 'name',
      description: 'The name of the armor to preview',
      required: true,
      autocomplete: true,
    },
  ],
  acknowledge: true,
  async autocomplete(interaction, client) {
    const focused = getAutocompleteFocusedOption(interaction.data.options)
    const value = String(focused?.value ?? '').toLowerCase()

    const armors = await makeRequest('http://localhost:9999/armors', {
      method: RequestMethod.GET,
      response: ResponseType.JSON,
      headers: {
        'x-api-key': env.get('forger_api_key', true).toString(),
      },
    })

    const choices = armors
      .flatMap((armor: any) => armor.variants)
      .filter((variant: any) => variant.name.toLowerCase().includes(value))
      .map((variant: any) => ({
        name: variant.name,
        value: variant.name,
      }))
      .slice(0, 25)

    await client.api.interactions.createAutocompleteResponse(interaction.id, interaction.token, { choices })
  },
  async run(interaction, options, client) {
    const { name } = options

    const armor = await makeRequest(`http://localhost:9999/armors`, {
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
            ...(armor.image
              ? ([
                  {
                    type: ComponentType.Section,
                    components: [
                      {
                        type: ComponentType.TextDisplay,
                        content: `## ${armor.name}\n-# ${armor.type}${armor.inherent_traits ? `${armor.inherent_traits.map((trait: any) => `\n> ${trait.description}`)}` : ''}`,
                      },
                    ],
                    accessory: {
                      type: ComponentType.Thumbnail,
                      media: {
                        url: armor.image,
                      },
                    },
                  },
                ] satisfies APIMessageTopLevelComponent[])
              : ([
                  {
                    type: ComponentType.TextDisplay,
                    content: `## ${armor.name}\n-# ${armor.type}`,
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
                  custom_id: 'armor_info',
                  placeholder: 'Armor Information:',
                  options: [
                    {
                      label: 'Health',
                      value: 'health',
                      description: armor.health,
                    },
                    {
                      label: 'Chance',
                      value: 'chance',
                      description: armor.chance,
                    },
                    {
                      label: 'Base Price',
                      value: 'base_price',
                      description: armor.base_price,
                    },
                    {
                      label: 'Min Ores',
                      value: 'min_ores',
                      description: armor.min_ores,
                    },
                  ] satisfies APISelectMenuOption[],
                },
              ],
            },
            {
              type: ComponentType.Separator,
            },
            ...(armor.from?.length
              ? ([
                  {
                    type: ComponentType.TextDisplay,
                    content: `### Craftable At:\n${armor.from.map((world: string) => `> - ${world}`).join('\n')}`,
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
