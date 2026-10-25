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
  name: 'mob',
  description: "Preview one of Forge's mobs",
  integrationTypes: [ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall],
  contexts: [InteractionContextType.BotDM, InteractionContextType.Guild, InteractionContextType.PrivateChannel],
  options: [
    {
      type: ApplicationCommandOptionType.String,
      name: 'name',
      description: 'The name of the mob to preview',
      required: true,
      autocomplete: true,
    },
  ],
  acknowledge: true,
  async autocomplete(interaction, client) {
    const focused = getAutocompleteFocusedOption(interaction.data.options)
    const value = String(focused?.value ?? '').toLowerCase()

    const mobs = await makeRequest('http://localhost:9999/mobs', {
      method: RequestMethod.GET,
      response: ResponseType.JSON,
      headers: {
        'x-api-key': env.get('forger_api_key', true).toString(),
      },
    })

    const choices = mobs
      .filter((mob: any) => mob.name.toLowerCase().includes(value))
      .map((mob: any) => ({
        name: mob.name,
        value: mob.name,
      }))
      .slice(0, 25)

    await client.api.interactions.createAutocompleteResponse(interaction.id, interaction.token, { choices })
  },
  async run(interaction, options, client) {
    const { name } = options

    const mob = await makeRequest(`http://localhost:9999/mobs`, {
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
            ...(mob.image
              ? ([
                  {
                    type: ComponentType.Section,
                    components: [
                      {
                        type: ComponentType.TextDisplay,
                        content: `## ${mob.name}\n*${mob.description}*`,
                      },
                    ],
                    accessory: {
                      type: ComponentType.Thumbnail,
                      media: {
                        url: mob.image,
                      },
                    },
                  },
                ] satisfies APIMessageTopLevelComponent[])
              : ([
                  {
                    type: ComponentType.TextDisplay,
                    content: `## ${mob.name}\n*${mob.description}*`,
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
                  custom_id: 'mob_info',
                  placeholder: 'Mob Information:',
                  options: [
                    {
                      label: 'Level',
                      value: 'level',
                      description: `${mob.level_range.min} - ${mob.level_range.max}`,
                    },
                    {
                      label: 'Health',
                      value: 'health',
                      description: `${mob.health.min} - ${mob.health.max}`,
                    },
                    {
                      label: 'Damage',
                      value: 'damage',
                      description: `${mob.damage.min} - ${mob.damage.max}`,
                    },
                    {
                      label: 'Gold',
                      value: 'gold',
                      description: `${mob.gold.min} - ${mob.gold.max}`,
                    },
                    {
                      label: 'Experience',
                      value: 'experience',
                      description: `${mob.experience.min} - ${mob.experience.max}`,
                    },
                  ] satisfies APISelectMenuOption[],
                },
              ],
            },
            {
              type: ComponentType.Separator,
            },
            ...(mob.location?.length
              ? ([
                  {
                    type: ComponentType.TextDisplay,
                    content: `### Found At:\n${[...new Set(mob.location.flatMap((location: any) => location.world))]
                      .map(world => `> - ${world}`)
                      .join('\n')}`,
                  },
                ] satisfies APIMessageTopLevelComponent[])
              : []),
            ...(mob.drops?.length
              ? ([
                  {
                    type: ComponentType.TextDisplay,
                    content: `### Drops:\n${mob.drops
                      .map((drop: any) => {
                        const quantity =
                          drop.quantity_min != null
                            ? ` ×${drop.quantity_max == null || drop.quantity_min === drop.quantity_max ? drop.quantity_min : `${drop.quantity_min}-${drop.quantity_max}`}`
                            : ''

                        const chance = drop.guaranteed
                          ? 'Guaranteed'
                          : drop.chance_denominator
                            ? `1/${drop.chance_denominator}`
                            : `${parseFloat((drop.chance * 100).toFixed(2))}%`

                        return `> - ${drop.item ?? drop.name}${quantity} (${chance})`
                      })
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
