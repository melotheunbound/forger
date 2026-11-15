import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { ComponentType, type APIChatInputApplicationCommandInteraction, type Client } from '@discordjs/core'
import { commands } from '../src/builders/command'
import type { ChatInputCommand } from '../src/types/types'
import { formatForgeLocations, formatOreInformation, formatRewardRange } from '../src/utils/forge'

mock.module('../src/utils/env', () => ({ default: { get: () => ({ toString: () => 'test-key' }) } }))

await import('../src/bot/commands/chatInput/ore')
await import('../src/bot/commands/chatInput/weapon')
await import('../src/bot/commands/chatInput/armor')
await import('../src/bot/commands/chatInput/mob')
await import('../src/bot/commands/chatInput/race')

afterEach(() => mock.restore())

describe('Forge presentation', () => {
  test('Bismuth uses tier odds, qualified multiplier and unknown price', () => {
    const text = formatOreInformation({
      chance: null,
      multiplier: '8',
      price: null,
      multiplier_note: 'Inherits other ores in a mixed recipe.',
      acquisition_chances: [{ tier: 2, chance_percent: 7.5 }],
      shop_offers: [{ shop: 'Guild Shop', price: 800, currency: 'Guild Coins', min_guild_level: 8, monthly_limit: 1 }],
    })
    expect(text).toContain('T2: **7.5%**')
    expect(text).toContain('Inherits other ores')
    expect(text).toContain('Not confirmed')
    expect(text).toContain('800 Guild Coins')
    expect(text).not.toContain('null')
  })

  test('existing Bismuth display payload remains supported', () => {
    expect(
      formatOreInformation({ multiplier: '8', display: { chest_odds: [{ tier: 'Tier I', chance_percent: 3 }] } }),
    ).toContain('Tier I: **3%**')
  })

  test('station odds and level gates stay distinct from base odds', () => {
    const text = formatForgeLocations({
      from: ['Abyss', 'Abyss'],
      station_chances: { Abyss: 1 / 64 },
      station_requirements: { Abyss: { level: 200 } },
    })
    expect(text).toContain('1.5625%')
    expect(text).toContain('level 200')
    expect(text.match(/Abyss/g)).toHaveLength(1)
    expect(formatForgeLocations({ from: [] })).toBe('')
  })

  test('unknown kill rewards are not displayed as discovery rewards', () => {
    expect(formatRewardRange({ min: null, max: null })).toBe('Configured at runtime')
    expect(formatRewardRange({ min: 0, max: 0 })).toBe('0 - 0')
  })
})

type Component = {
  type: number
  content?: string
  components?: Component[]
  options?: { label: string; description?: string; value: string }[]
}

function validateComponents(components: Component[]): void {
  for (const component of components) {
    if (component.type === ComponentType.TextDisplay) {
      expect(component.content?.length).toBeGreaterThan(0)
      expect(component.content!.length).toBeLessThanOrEqual(4000)
    }
    if (component.type === ComponentType.StringSelect) {
      expect(component.options!.length).toBeGreaterThan(0)
      expect(component.options!.length).toBeLessThanOrEqual(25)
      for (const option of component.options!) {
        expect(typeof option.value).toBe('string')
        if (option.description !== undefined) {
          expect(typeof option.description).toBe('string')
          expect(option.description.length).toBeLessThanOrEqual(100)
        }
      }
    }
    if (component.components) validateComponents(component.components)
  }
}

test.each([
  [
    'ore',
    {
      name: 'Bismuth',
      rarity: 'Divine',
      multiplier: '8',
      chance: null,
      price: null,
      description: 'Neutral ore.',
      from: [{ source: 'Enemy', enemy: ['Fallen Guardian'] }],
      acquisition_chances: [{ tier: 1, chance_percent: 3 }],
    },
    'Guardian Chest',
  ],
  [
    'ore',
    {
      name: 'Echotite',
      rarity: 'Mythic',
      multiplier: '22',
      chance: '1/40',
      price: null,
      description: 'Raid ore.',
      from: [{ source: 'Raid', raid: ['Tower of Hell'] }],
    },
    'Tower of Hell',
  ],
  [
    'weapon',
    {
      name: "Devil's Deed",
      type: 'Colossal Sword',
      damage: '30.8',
      real_speed: '1.4',
      damage_per_second: '22',
      attack_range: '15',
      chance: '1/128',
      base_price: '$2506.75',
      min_ores: '19',
      molds: 165,
      from: ['Abyss'],
      station_chances: { Abyss: 1 / 64 },
    },
    '1.5625%',
  ],
  [
    'armor',
    {
      name: "Dreadhorn's Chestplate",
      type: 'Heavy Chestplate',
      health: '55',
      chance: '1/6',
      base_price: '$2168',
      min_ores: '27',
      from: ['Abyss'],
      station_chances: { Abyss: 1 / 8 },
      station_requirements: { Abyss: { level: 210 } },
    },
    'level 210',
  ],
  [
    'mob',
    {
      name: 'Abyss Mage',
      description: 'Mage.',
      level_range: { min: '1', max: '1' },
      health: { min: '1000', max: '1000' },
      damage: { min: '18', max: '30' },
      gold: { min: null, max: null },
      experience: { min: null, max: null },
      drops: [],
      location: [],
      reward_note: 'Kill rewards depend on runtime configuration.',
      discovery_rewards: { gold: 3000, experience: 1500 },
    },
    'Discovery:',
  ],
  [
    'race',
    { name: 'Dragon', rarity: 'Unobtainable', drop_rate: '0%', roll_note: 'No ordinary roll chance.', perks: [] },
    'Not in ordinary rolls',
  ],
] as const)('%s command handles updated API responses', async (name, response, expected) => {
  spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(response))
  const respond = mock(async (..._args: unknown[]) => {})
  const client = { api: { interactions: { respond } } } as unknown as Client
  const command = commands.get(name) as ChatInputCommand
  await command.run(
    { id: '1', application_id: '2', token: 'test' } as APIChatInputApplicationCommandInteraction,
    { name: response.name },
    client,
  )
  expect(respond).toHaveBeenCalledTimes(1)
  const payload = respond.mock.calls[0]![3] as { components: Component[] }
  validateComponents(payload.components)
  expect(JSON.stringify(payload)).toContain(expected)
})
