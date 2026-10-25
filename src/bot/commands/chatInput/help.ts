import {
  ApplicationCommandType,
  ApplicationIntegrationType,
  ButtonStyle,
  ComponentType,
  InteractionContextType,
  MessageFlags,
  TextInputStyle,
  type APIComponentInActionRow,
  type APIMessageComponentButtonInteraction,
  type APIModalSubmitInteraction,
  type APIModalSubmitTextInputComponent,
  type ModalSubmitLabelComponent,
} from '@discordjs/core'
import createApplicationCommand from '../../../builders/command'
import List from '../../../utils/list'
import { getSubcommandPaths, toComponentEmoji } from '../../../utils/utils'
import { emoji } from '../../../utils/markdown'
import { getInteractionCollectorDeadline } from '../../../builders/collector'

createApplicationCommand({
  type: ApplicationCommandType.ChatInput,
  name: 'help',
  description: 'View and search through all available commands',
  integrationTypes: [ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall],
  contexts: [InteractionContextType.BotDM, InteractionContextType.Guild, InteractionContextType.PrivateChannel],
  cooldown: 3,
  acknowledge: true,
  async run(interaction, options, client) {
    const globalCommands = await client.api.applicationCommands.getGlobalCommands(interaction.application_id, {
      with_localizations: true,
    })

    const commands = globalCommands.flatMap(command => {
      const paths = getSubcommandPaths(command.options)

      if (!paths.length) {
        return [command]
      }

      return paths.map(path => ({
        ...command,
        name: `${command.name} ${path}`,
      }))
    })

    const limit = 5

    const list = new List(
      true,
      ...Array.from({ length: Math.ceil(commands.length / limit) }, (_, index) =>
        commands.slice(index * limit, index * limit + limit),
      ),
    )

    let pages = list
    let query: string | null = null

    let result = (pages.current ?? [])
      .map(
        (command, index) =>
          `**${pages.pointer * limit + index + 1}.** </${command.name}:${command.id}>${
            command.description ? `\n-# ${command.description}` : ''
          }`,
      )
      .join('\n\n')

    const response = await client.api.interactions.respond(
      interaction.application_id,
      interaction.id,
      interaction.token,
      {
        components: [
          {
            type: ComponentType.Container,
            components: [
              {
                type: ComponentType.Section,
                components: [
                  {
                    type: ComponentType.TextDisplay,
                    content: `## ${emoji('Slash')} Command Browser\n-# Browse all available commands using pagination, or search for a specific command`,
                  },
                ],
                accessory: {
                  type: ComponentType.Button,
                  custom_id: 'commands-browser',
                  emoji: toComponentEmoji('Search'),
                  style: ButtonStyle.Secondary,
                },
              },
            ],
          },
          {
            type: ComponentType.Container,
            components: [
              {
                type: ComponentType.TextDisplay,
                content: result,
              },
              {
                type: ComponentType.Separator,
              },
              {
                type: ComponentType.TextDisplay,
                content: `-# Page **${pages.pointer + 1}** of **${pages.length}**`,
              },
              {
                type: ComponentType.ActionRow,
                components: [
                  {
                    type: ComponentType.Button,
                    custom_id: 'commands-prev',
                    emoji: toComponentEmoji('Previous'),
                    style: ButtonStyle.Secondary,
                  },
                  {
                    type: ComponentType.Button,
                    custom_id: 'commands-next',
                    emoji: toComponentEmoji('Next'),
                    style: ButtonStyle.Secondary,
                  },
                ],
              },
            ],
          },
        ],
        flags: MessageFlags.IsComponentsV2,
      },
    )

    const collector = client.api.interactions.createCollector<
      APIMessageComponentButtonInteraction | APIModalSubmitInteraction
    >({
      key: 'help',
      filter: async i => {
        if (i.message?.id !== response.id) return false

        if ((i.user?.id ?? i.member?.user.id) !== (interaction.user?.id ?? interaction.member?.user.id)) {
          await client.api.interactions.reply(i.id, i.token, {
            content: "You cannot interact with components from another user's command.",
            flags: MessageFlags.Ephemeral,
          })

          return false
        }

        return true
      },
      duration: 5 * 60 * 1000,
      hardDeadline: getInteractionCollectorDeadline(interaction.id),
    })

    collector.on('collect', async i => {
      switch (i.data.custom_id) {
        case 'commands-prev': {
          await client.api.interactions.deferMessageUpdate(i.id, i.token)

          pages.back()

          result = (pages.current ?? [])
            .map(
              (command, index) =>
                `**${pages.pointer * limit + index + 1}.** </${command.name}:${command.id}>${
                  command.description ? `\n-# ${command.description}` : ''
                }`,
            )
            .join('\n\n')

          await client.api.interactions.respond(i.application_id, i.id, i.token, {
            components: [
              {
                type: ComponentType.Container,
                components: [
                  {
                    type: ComponentType.Section,
                    components: [
                      {
                        type: ComponentType.TextDisplay,
                        content: query
                          ? `## ${emoji('Slash')} Command Browser\n-# Search results for **${query}**`
                          : `## ${emoji('Slash')} Command Browser\n-# Browse all available commands using pagination, or search for a specific command`,
                      },
                    ],
                    accessory: {
                      type: ComponentType.Button,
                      custom_id: 'commands-browser',
                      emoji: toComponentEmoji('Search'),
                      style: ButtonStyle.Secondary,
                    },
                  },
                ],
              },
              {
                type: ComponentType.Container,
                components: [
                  {
                    type: ComponentType.TextDisplay,
                    content: result,
                  },
                  {
                    type: ComponentType.Separator,
                  },
                  {
                    type: ComponentType.TextDisplay,
                    content: `-# Page **${pages.pointer + 1}** of **${pages.length}**`,
                  },
                  {
                    type: ComponentType.ActionRow,
                    components: [
                      {
                        type: ComponentType.Button,
                        custom_id: 'commands-prev',
                        emoji: toComponentEmoji('Previous'),
                        style: ButtonStyle.Secondary,
                      },
                      ...(query !== null
                        ? ([
                            {
                              type: ComponentType.Button,
                              custom_id: 'commands-back',
                              emoji: toComponentEmoji('Home'),
                              style: ButtonStyle.Secondary,
                            },
                          ] satisfies APIComponentInActionRow[])
                        : []),
                      {
                        type: ComponentType.Button,
                        custom_id: 'commands-next',
                        emoji: toComponentEmoji('Next'),
                        style: ButtonStyle.Secondary,
                      },
                    ],
                  },
                ],
              },
            ],
            flags: MessageFlags.IsComponentsV2,
          })

          break
        }
        case 'commands-next': {
          await client.api.interactions.deferMessageUpdate(i.id, i.token)

          pages.next()

          result = (pages.current ?? [])
            .map(
              (command, index) =>
                `**${pages.pointer * limit + index + 1}.** </${command.name}:${command.id}>${
                  command.description ? `\n-# ${command.description}` : ''
                }`,
            )
            .join('\n\n')

          await client.api.interactions.respond(i.application_id, i.id, i.token, {
            components: [
              {
                type: ComponentType.Container,
                components: [
                  {
                    type: ComponentType.Section,
                    components: [
                      {
                        type: ComponentType.TextDisplay,
                        content: query
                          ? `## ${emoji('Slash')} Command Browser\n-# Search results for **${query}**`
                          : `## ${emoji('Slash')} Command Browser\n-# Browse all available commands using pagination, or search for a specific command`,
                      },
                    ],
                    accessory: {
                      type: ComponentType.Button,
                      custom_id: 'commands-browser',
                      emoji: toComponentEmoji('Search'),
                      style: ButtonStyle.Secondary,
                    },
                  },
                ],
              },
              {
                type: ComponentType.Container,
                components: [
                  {
                    type: ComponentType.TextDisplay,
                    content: result,
                  },
                  {
                    type: ComponentType.Separator,
                  },
                  {
                    type: ComponentType.TextDisplay,
                    content: `-# Page **${pages.pointer + 1}** of **${pages.length}**`,
                  },
                  {
                    type: ComponentType.ActionRow,
                    components: [
                      {
                        type: ComponentType.Button,
                        custom_id: 'commands-prev',
                        emoji: toComponentEmoji('Previous'),
                        style: ButtonStyle.Secondary,
                      },
                      ...(query
                        ? ([
                            {
                              type: ComponentType.Button,
                              custom_id: 'commands-back',
                              emoji: toComponentEmoji('Home'),
                              style: ButtonStyle.Secondary,
                            },
                          ] satisfies APIComponentInActionRow[])
                        : []),
                      {
                        type: ComponentType.Button,
                        custom_id: 'commands-next',
                        emoji: toComponentEmoji('Next'),
                        style: ButtonStyle.Secondary,
                      },
                    ],
                  },
                ],
              },
            ],
            flags: MessageFlags.IsComponentsV2,
          })

          break
        }
        case 'commands-browser': {
          await client.api.interactions.createModal(i.id, i.token, {
            title: 'Command Browser',
            custom_id: 'commands-browser-modal',
            components: [
              {
                type: ComponentType.Label,
                label: 'Search for commands by name',
                component: {
                  type: ComponentType.TextInput,
                  custom_id: 'commands-browser-input',
                  placeholder: 'Enter a command name...',
                  style: TextInputStyle.Short,
                  required: true,
                },
              },
            ],
          })

          break
        }
        case 'commands-browser-modal': {
          await client.api.interactions.deferMessageUpdate(i.id, i.token)

          const name =
            (i as APIModalSubmitInteraction).data.components?.[0]?.type === ComponentType.Label
              ? (
                  ((i as APIModalSubmitInteraction).data.components[0] as ModalSubmitLabelComponent)
                    .component as APIModalSubmitTextInputComponent
                ).value
              : undefined

          const search = name?.trim().toLowerCase()

          if (!search) return

          const results = commands.filter(command => command.name.trim().toLowerCase().includes(search))

          if (!results.length) {
            await client.api.interactions.followUp(i.application_id, i.token, {
              components: [
                {
                  type: ComponentType.Container,
                  components: [
                    {
                      type: ComponentType.TextDisplay,
                      content: `${emoji('Exclamation')} No commands found matching your search.`,
                    },
                  ],
                },
              ],
              flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
            })

            return
          }

          pages = new List(
            true,
            ...Array.from({ length: Math.ceil(results.length / limit) }, (_, index) =>
              results.slice(index * limit, index * limit + limit),
            ),
          )

          query = search

          result = (pages.current ?? [])
            .map(
              (command, index) =>
                `**${pages.pointer * limit + index + 1}.** </${command.name}:${command.id}>${
                  command.description ? `\n-# ${command.description}` : ''
                }`,
            )
            .join('\n\n')

          await client.api.interactions.respond(i.application_id, i.id, i.token, {
            components: [
              {
                type: ComponentType.Container,
                components: [
                  {
                    type: ComponentType.Section,
                    components: [
                      {
                        type: ComponentType.TextDisplay,
                        content: `## ${emoji('Slash')} Command Browser\n-# Search results for **${query}**`,
                      },
                    ],
                    accessory: {
                      type: ComponentType.Button,
                      custom_id: 'commands-browser',
                      emoji: toComponentEmoji('Search'),
                      style: ButtonStyle.Secondary,
                    },
                  },
                ],
              },
              {
                type: ComponentType.Container,
                components: [
                  {
                    type: ComponentType.TextDisplay,
                    content: result,
                  },
                  {
                    type: ComponentType.Separator,
                  },
                  {
                    type: ComponentType.TextDisplay,
                    content: `-# Page **${pages.pointer + 1}** of **${pages.length}**`,
                  },
                  {
                    type: ComponentType.ActionRow,
                    components: [
                      {
                        type: ComponentType.Button,
                        custom_id: 'commands-prev',
                        emoji: toComponentEmoji('Previous'),
                        style: ButtonStyle.Secondary,
                      },
                      {
                        type: ComponentType.Button,
                        custom_id: 'commands-back',
                        emoji: toComponentEmoji('Home'),
                        style: ButtonStyle.Secondary,
                      },
                      {
                        type: ComponentType.Button,
                        custom_id: 'commands-next',
                        emoji: toComponentEmoji('Next'),
                        style: ButtonStyle.Secondary,
                      },
                    ],
                  },
                ],
              },
            ],
            flags: MessageFlags.IsComponentsV2,
          })

          break
        }
        case 'commands-back': {
          await client.api.interactions.deferMessageUpdate(i.id, i.token)

          pages = list
          query = null

          result = (pages.current ?? [])
            .map(
              (command, index) =>
                `**${pages.pointer * limit + index + 1}.** </${command.name}:${command.id}>${
                  command.description ? `\n-# ${command.description}` : ''
                }`,
            )
            .join('\n\n')

          await client.api.interactions.respond(i.application_id, i.id, i.token, {
            components: [
              {
                type: ComponentType.Container,
                components: [
                  {
                    type: ComponentType.Section,
                    components: [
                      {
                        type: ComponentType.TextDisplay,
                        content: `## ${emoji('Slash')} Command Browser\n-# Browse all available commands using pagination, or search for a specific command`,
                      },
                    ],
                    accessory: {
                      type: ComponentType.Button,
                      custom_id: 'commands-browser',
                      emoji: toComponentEmoji('Search'),
                      style: ButtonStyle.Secondary,
                    },
                  },
                ],
              },
              {
                type: ComponentType.Container,
                components: [
                  {
                    type: ComponentType.TextDisplay,
                    content: result,
                  },
                  {
                    type: ComponentType.Separator,
                  },
                  {
                    type: ComponentType.TextDisplay,
                    content: `-# Page **${pages.pointer + 1}** of **${pages.length}**`,
                  },
                  {
                    type: ComponentType.ActionRow,
                    components: [
                      {
                        type: ComponentType.Button,
                        custom_id: 'commands-prev',
                        emoji: toComponentEmoji('Previous'),
                        style: ButtonStyle.Secondary,
                      },
                      {
                        type: ComponentType.Button,
                        custom_id: 'commands-next',
                        emoji: toComponentEmoji('Next'),
                        style: ButtonStyle.Secondary,
                      },
                    ],
                  },
                ],
              },
            ],
            flags: MessageFlags.IsComponentsV2,
          })

          break
        }
      }
    })

    collector.once('end', () => {
      void client.api.interactions
        .respond(interaction.application_id, interaction.id, interaction.token, {
          components: [
            {
              type: ComponentType.Container,
              components: [
                {
                  type: ComponentType.Section,
                  components: [
                    {
                      type: ComponentType.TextDisplay,
                      content: query
                        ? `## ${emoji('Slash')} Command Browser\n-# Search results for **${query}**`
                        : `## ${emoji('Slash')} Command Browser\n-# Browse all available commands using pagination, or search for a specific command`,
                    },
                  ],
                  accessory: {
                    type: ComponentType.Button,
                    custom_id: 'commands-browser',
                    emoji: toComponentEmoji('Search'),
                    style: ButtonStyle.Secondary,
                    disabled: true,
                  },
                },
              ],
            },
            {
              type: ComponentType.Container,
              components: [
                {
                  type: ComponentType.TextDisplay,
                  content: result,
                },
                {
                  type: ComponentType.Separator,
                },
                {
                  type: ComponentType.TextDisplay,
                  content: `-# Page **${pages.pointer + 1}** of **${pages.length}**`,
                },
                {
                  type: ComponentType.ActionRow,
                  components: [
                    {
                      type: ComponentType.Button,
                      custom_id: 'commands-prev',
                      emoji: toComponentEmoji('Previous'),
                      style: ButtonStyle.Secondary,
                      disabled: true,
                    },
                    ...(query
                      ? ([
                          {
                            type: ComponentType.Button,
                            custom_id: 'commands-back',
                            emoji: toComponentEmoji('Home'),
                            style: ButtonStyle.Secondary,
                            disabled: true,
                          },
                        ] satisfies APIComponentInActionRow[])
                      : []),
                    {
                      type: ComponentType.Button,
                      custom_id: 'commands-next',
                      emoji: toComponentEmoji('Next'),
                      style: ButtonStyle.Secondary,
                      disabled: true,
                    },
                  ],
                },
              ],
            },
          ],
          flags: MessageFlags.IsComponentsV2,
        })
        .catch(() => null)
    })
  },
})
