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
  name: 'weapon',
  description: "Preview one of Forge's weapons",
  integrationTypes: [ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall],
  contexts: [InteractionContextType.BotDM, InteractionContextType.Guild, InteractionContextType.PrivateChannel],
  options: [
    {
      type: ApplicationCommandOptionType.String,
      name: 'name',
      description: 'The name of the weapon to preview',
      required: true,
      autocomplete: true,
    },
  ],
  acknowledge: true,
  async autocomplete(interaction, client) {
    const focused = getAutocompleteFocusedOption(interaction.data.options)
    const value = String(focused?.value ?? '').toLowerCase()

    const weapons = await makeRequest('http://localhost:9999/weapons', {
      method: RequestMethod.GET,
      response: ResponseType.JSON,
      headers: {
        'x-api-key': env.get('forger_api_key', true).toString(),
      },
    })

    const choices = weapons
      .flatMap((weapon: any) => weapon.variants)
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

    const weapon = await makeRequest(`http://localhost:9999/weapons`, {
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
            ...(weapon.image
              ? ([
                  {
                    type: ComponentType.Section,
                    components: [
                      {
                        type: ComponentType.TextDisplay,
                        content: `## ${weapon.name}\n-# ${weapon.type}`,
                      },
                    ],
                    accessory: {
                      type: ComponentType.Thumbnail,
                      media: {
                        url: weapon.image,
                      },
                    },
                  },
                ] satisfies APIMessageTopLevelComponent[])
              : ([
                  {
                    type: ComponentType.TextDisplay,
                    content: `## ${weapon.name}\n-# ${weapon.type}`,
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
                  custom_id: 'weapon_info',
                  placeholder: 'Weapon Information:',
                  options: [
                    { label: 'Damage', value: 'damage', description: weapon.damage },
                    { label: 'Speed', value: 'speed', description: weapon.real_speed },
                    { label: 'Damage Per Second', value: 'damage_per_second', description: weapon.damage_per_second },
                    { label: 'Attack Range', value: 'attack_range', description: weapon.attack_range },
                    { label: 'Chance', value: 'chance', description: weapon.chance },
                    { label: 'Base Price', value: 'base_price', description: weapon.base_price },
                    { label: 'Min Ores', value: 'min_ores', description: weapon.min_ores },
                    ...(weapon.molds != null ? [{ label: 'Molds', value: 'molds', description: weapon.molds }] : []),
                  ] satisfies APISelectMenuOption[],
                },
              ],
            },
            {
              type: ComponentType.Separator,
            },
            ...(weapon.from?.length
              ? ([
                  {
                    type: ComponentType.TextDisplay,
                    content: `### Craftable At:\n${weapon.from.map((world: string) => `> - ${world}`).join('\n')}`,
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
