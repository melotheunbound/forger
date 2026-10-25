import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  ApplicationIntegrationType,
  ComponentType,
  InteractionContextType,
  MessageFlags,
  type APIMessageTopLevelComponent,
} from '@discordjs/core'
import createApplicationCommand from '../../../builders/command'
import { getAutocompleteFocusedOption } from '../../../utils/utils'
import { makeRequest } from '../../../utils/request'
import { RequestMethod, ResponseType } from '../../../types/types'
import env from '../../../utils/env'

createApplicationCommand({
  type: ApplicationCommandType.ChatInput,
  name: 'race',
  description: "Preview one of Forge's races",
  integrationTypes: [ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall],
  contexts: [InteractionContextType.BotDM, InteractionContextType.Guild, InteractionContextType.PrivateChannel],
  options: [
    {
      type: ApplicationCommandOptionType.String,
      name: 'name',
      description: 'The name of the race to preview',
      required: true,
      autocomplete: true,
    },
  ],
  acknowledge: true,
  async autocomplete(interaction, client) {
    const focused = getAutocompleteFocusedOption(interaction.data.options)
    const value = String(focused?.value ?? '').toLowerCase()

    const races = await makeRequest('http://localhost:9999/races', {
      method: RequestMethod.GET,
      response: ResponseType.JSON,
      headers: {
        'x-api-key': env.get('forger_api_key', true).toString(),
      },
    })

    const choices = races
      .filter((race: any) => race.name.toLowerCase().includes(value))
      .map((race: any) => ({
        name: race.name,
        value: race.name,
      }))
      .slice(0, 25)

    await client.api.interactions.createAutocompleteResponse(interaction.id, interaction.token, { choices })
  },
  async run(interaction, options, client) {
    const { name } = options

    const race = await makeRequest(`http://localhost:9999/races`, {
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
            ...(race.image
              ? ([
                  {
                    type: ComponentType.Section,
                    components: [
                      {
                        type: ComponentType.TextDisplay,
                        content: `## ${race.name}\n-# ${race.rarity} **(${race.drop_rate})**`,
                      },
                    ],
                    accessory: {
                      type: ComponentType.Thumbnail,
                      media: {
                        url: race.image,
                      },
                    },
                  },
                ] satisfies APIMessageTopLevelComponent[])
              : ([
                  {
                    type: ComponentType.TextDisplay,
                    content: `## ${race.name}\n-# ${race.rarity} **(${race.drop_rate})**`,
                  },
                ] satisfies APIMessageTopLevelComponent[])),
            ...(race.perks?.length
              ? ([
                  {
                    type: ComponentType.Separator,
                  },
                  {
                    type: ComponentType.TextDisplay,
                    content: `### Perks:\n${race.perks.map((perk: any) => `> ${perk.description}`).join('\n')}`,
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
