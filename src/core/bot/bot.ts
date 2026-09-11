import {
  ApplicationCommandOptionTypes,
  Collection,
  createBot,
  createDesiredPropertiesObject,
  createLogger,
  DesiredPropertiesBehavior,
  MessageComponentTypes,
  MessageFlags,
} from 'discordeno';
import type {
  ManagerGetShardInfoFromGuildId,
  ShardInfo,
  WorkerPresenceUpdate,
  WorkerShardPayload,
} from 'gateway/worker/types';
import { GATEWAY_URL, REST_URL, BOT_TOKEN, DEV_SERVER } from 'core/variables';
import { RequestMethod, ResponseType, type ApplicationCommand, type ApplicationCommandOption } from 'types/types';
import { makeRequest } from 'utils/request';
import { hyperlink } from 'utils/markdown';
import { redis } from 'utils/redis';

export const logger = createLogger({ name: 'BOT' });

const desiredProperties = createDesiredPropertiesObject({
  attachment: {
    contentType: true,
    filename: true,
    url: true,
  },
  channel: {
    guildId: true,
    id: true,
    parentId: true,
    type: true,
  },
  component: {
    component: true,
    components: true,
    customId: true,
    value: true,
    values: true,
  },
  guild: {
    channels: true,
    roles: true,
    id: true,
    ownerId: true,
  },
  interaction: {
    channelId: true,
    data: true,
    guildId: true,
    id: true,
    message: true,
    member: true,
    token: true,
    type: true,
    user: true,
  },
  message: {
    id: true,
  },
  member: {
    communicationDisabledUntil: true,
    id: true,
    roles: true,
  },
  role: {
    guildId: true,
    id: true,
    permissions: true,
  },
  user: {
    id: true,
    username: true,
  },
});

const rawBot = createBot({
  token: BOT_TOKEN,
  desiredProperties,
  desiredPropertiesBehavior: DesiredPropertiesBehavior.ChangeType,
  rest: {
    proxy: {
      baseUrl: REST_URL,
      authorization: BOT_TOKEN,
    },
  },
});

export type CustomBot = typeof rawBot & {
  commands: Collection<string, ApplicationCommand>;
};

export const bot = rawBot as CustomBot;

bot.commands = new Collection<string, ApplicationCommand>();

overrideGatewayImplementations(bot);

function overrideGatewayImplementations(bot: CustomBot): void {
  bot.gateway.sendPayload = async (shardId, payload) => {
    await makeRequest(GATEWAY_URL, {
      method: RequestMethod.POST,
      response: ResponseType.JSON,
      headers: { Authorization: BOT_TOKEN },
      body: {
        type: 'ShardPayload',
        shardId,
        payload,
      } satisfies WorkerShardPayload,
    });
  };

  bot.gateway.editBotStatus = async (payload) => {
    await makeRequest(GATEWAY_URL, {
      method: RequestMethod.POST,
      response: ResponseType.JSON,
      headers: { Authorization: BOT_TOKEN },
      body: {
        type: 'EditShardsPresence',
        payload,
      } satisfies WorkerPresenceUpdate,
    });
  };
}

export async function getShardInfoFromGuild(guildId?: bigint): Promise<Omit<ShardInfo, 'nonce'>> {
  const res = (await makeRequest(GATEWAY_URL, {
    method: RequestMethod.POST,
    response: ResponseType.JSON,
    headers: { Authorization: BOT_TOKEN },
    body: {
      type: 'ShardInfoFromGuild',
      guildId: guildId?.toString(),
    } as ManagerGetShardInfoFromGuildId,
  })) as Omit<ShardInfo, 'nonce'>;

  if (!res) {
    throw new Error('Failed to get shard info: response is null or invalid');
  }

  return res;
}

const normalizeDescription = (value: unknown) => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 100) : undefined;
};

const normalizeDisplayText = (value: string) =>
  value.replace(/\bundefined\b/gi, 'Not available').replace(/\bnull\b/gi, 'Not available');

/**
 * Keep Discord component payloads inside API limits, avoid literal missing-value
 * strings in user-facing text, and render passive page indicators as small text.
 */
function normalizeComponents(components: any[]): any[] {
  const output: any[] = [];

  for (const original of components ?? []) {
    if (!original || typeof original !== 'object') {
      output.push(original);
      continue;
    }

    const component: any = { ...original };

    if (component.type === MessageComponentTypes.TextDisplay && typeof component.content === 'string') {
      component.content = normalizeDisplayText(component.content);
    }

    if ('description' in component) {
      const description = normalizeDescription(component.description);
      if (description === undefined) delete component.description;
      else component.description = description;
    }

    if (Array.isArray(component.options)) {
      component.options = component.options.map((option: any) => {
        if (!option || typeof option !== 'object') return option;
        const next = { ...option };
        if ('description' in next) {
          const description = normalizeDescription(next.description);
          if (description === undefined) delete next.description;
          else next.description = description;
        }
        return next;
      });
    }

    if (component.component && typeof component.component === 'object') {
      component.component = normalizeComponents([component.component])[0] ?? component.component;
    }

    if (Array.isArray(component.components)) {
      if (component.type === MessageComponentTypes.ActionRow) {
        const pageLabel = component.components.find(
          (child: any) =>
            child?.type === MessageComponentTypes.Button &&
            typeof child?.customId === 'string' &&
            child.customId.includes('page-label'),
        );

        if (pageLabel) {
          const remaining = component.components.filter((child: any) => child !== pageLabel);
          if (remaining.length) {
            output.push({ ...component, components: normalizeComponents(remaining) });
          }
          output.push({
            type: MessageComponentTypes.TextDisplay,
            content: `-# ${String(pageLabel.label ?? 'Page')}`,
          });
          continue;
        }
      }

      component.components = normalizeComponents(component.components);
    }

    if (component.accessory && typeof component.accessory === 'object') {
      component.accessory = { ...component.accessory };
      if (Array.isArray(component.accessory.components)) {
        component.accessory.components = normalizeComponents(component.accessory.components);
      }
    }

    output.push(component);
  }

  return output;
}

// Override interaction methods to add top.gg link
const sendInteractionResponse = bot.helpers.sendInteractionResponse;

bot.helpers.sendInteractionResponse = async (interactionId, token, options) => {
  if (options.data) {
    if (Array.isArray(options.data.components)) {
      options.data.components = normalizeComponents(options.data.components);
    }

    const isComponentsV2 = Boolean((options.data.flags ?? 0) & MessageFlags.IsComponentsV2);

    if (isComponentsV2) {
      options.data.components ??= [];

      const hasVoteInComponents = (components: any[]): boolean => {
        return components.some((component: any) => {
          const hasVoteText =
            component?.type === MessageComponentTypes.TextDisplay &&
            typeof component?.content === 'string' &&
            component.content.includes('top.gg/bot/1461873695688491190/vote');

          if (hasVoteText) return true;

          if (Array.isArray(component?.components) && component.components.length > 0) {
            return hasVoteInComponents(component.components);
          }

          if (component?.accessory && Array.isArray(component.accessory?.components)) {
            return hasVoteInComponents(component.accessory.components);
          }

          return false;
        });
      };

      const alreadyHasVote = Array.isArray(options.data.components)
        ? hasVoteInComponents(options.data.components)
        : false;

      if (!alreadyHasVote) {
        options.data.components.unshift({
          type: MessageComponentTypes.TextDisplay,
          content: `-# Consider voting for us on **${hyperlink('https://top.gg/bot/1461873695688491190/vote', 'top.gg')}**!`,
        });
      }
    } else if (options.data.content) {
      const currentContent =
        typeof options.data.content === 'string' ? options.data.content : String(options.data.content);

      if (!currentContent.includes('top.gg/bot/1461873695688491190/vote')) {
        options.data.content = `-# Consider voting for us on **${hyperlink('https://top.gg/bot/1461873695688491190/vote', 'top.gg')}**!\n${currentContent}`;
      }
    }
  }

  return sendInteractionResponse(interactionId, token, options);
};

const editOriginalInteractionResponse = bot.helpers.editOriginalInteractionResponse;

bot.helpers.editOriginalInteractionResponse = async (token, options) => {
  if (options) {
    if (Array.isArray(options.components)) {
      options.components = normalizeComponents(options.components);
    }

    const isComponentsV2 = Boolean((options.flags ?? 0) & MessageFlags.IsComponentsV2);

    if (isComponentsV2) {
      options.components ??= [];

      const hasVoteInComponents = (components: any[]): boolean => {
        return components.some((component: any) => {
          const hasVoteText =
            component?.type === MessageComponentTypes.TextDisplay &&
            typeof component?.content === 'string' &&
            component.content.includes('top.gg/bot/1461873695688491190/vote');

          if (hasVoteText) return true;

          if (Array.isArray(component?.components) && component.components.length > 0) {
            return hasVoteInComponents(component.components);
          }

          if (component?.accessory && Array.isArray(component.accessory?.components)) {
            return hasVoteInComponents(component.accessory.components);
          }

          return false;
        });
      };

      const alreadyHasVote = Array.isArray(options.components) ? hasVoteInComponents(options.components) : false;

      if (!alreadyHasVote) {
        options.components.unshift({
          type: MessageComponentTypes.TextDisplay,
          content: `-# Consider voting for us on **${hyperlink('https://top.gg/bot/1461873695688491190/vote', 'top.gg')}**!`,
        });
      }
    } else {
      const currentContent =
        typeof options.content === 'string' ? options.content : options.content == null ? '' : String(options.content);

      if (!currentContent.includes('top.gg/bot/1461873695688491190/vote')) {
        options.content = currentContent
          ? `-# Consider voting for us on **${hyperlink('https://top.gg/bot/1461873695688491190/vote', 'top.gg')}**!\n${currentContent}`
          : `-# Consider voting for us on **${hyperlink('https://top.gg/bot/1461873695688491190/vote', 'top.gg')}**!`;
      }
    }
  }

  return editOriginalInteractionResponse(token, options);
};

export async function updateCommands(): Promise<void> {
  bot.logger.info('Refreshing application (/) commands');

  const commands = bot.commands.array().map((cmd) => {
    if (!cmd.options) cmd.options = [];

    const incognitoOption: ApplicationCommandOption = {
      type: ApplicationCommandOptionTypes.Boolean,
      name: 'incognito',
      description: 'Whether the response should only be visible to you',
    };

    let hasSubOrGroup = false;

    for (const option of cmd.options) {
      if (option.type === ApplicationCommandOptionTypes.SubCommandGroup && option.options) {
        hasSubOrGroup = true;
        for (const sub of option.options) {
          if (sub.type === ApplicationCommandOptionTypes.SubCommand) {
            if (!sub.options) sub.options = [];
            sub.options.push(incognitoOption);
          }
        }
      } else if (option.type === ApplicationCommandOptionTypes.SubCommand) {
        hasSubOrGroup = true;
        if (!option.options) option.options = [];
        option.options.push(incognitoOption);
      }
    }

    if (!hasSubOrGroup) {
      cmd.options.push(incognitoOption);
    }

    return { ...cmd, dev: !!cmd.dev };
  });

  const globalCommands = commands.filter((cmd) => !cmd.dev);
  const devCommands = commands.filter((cmd) => !!cmd.dev);

  const registeredGlobal = await bot.rest.upsertGlobalApplicationCommands(globalCommands);
  const registeredDevGuild = await bot.rest.upsertGuildApplicationCommands(DEV_SERVER, devCommands);

  // Save command IDs to Redis
  const commandIds: Record<string, string> = {};
  for (const cmd of registeredGlobal) {
    commandIds[cmd.name] = cmd.id;
  }
  for (const cmd of registeredDevGuild) {
    commandIds[cmd.name] = cmd.id;
  }

  await redis.hSet('commands:ids', commandIds);

  bot.logger.info('Successfully refreshed application (/) commands');
}
