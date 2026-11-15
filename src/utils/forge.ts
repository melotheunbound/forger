type ChestOdds = { tier: string | number; chance_percent: number }

type OreInformation = {
  chance?: string | null
  multiplier: string
  price?: string | null
  unique_price_multiplier?: string | null
  multiplier_note?: string
  neutral_multiplier?: boolean
  acquisition_chances?: ChestOdds[]
  shop_offers?: {
    shop: string
    price: number
    currency: string
    min_guild_level?: number
    monthly_limit?: number
  }[]
  display?: { chest_odds?: ChestOdds[]; multiplier_note?: string }
}

export function formatOreInformation(ore: OreInformation): string {
  const odds = ore.acquisition_chances ?? ore.display?.chest_odds
  return [
    odds?.length
      ? `Guardian Chest: ${odds.map(row => `${typeof row.tier === 'number' ? `T${row.tier}` : row.tier}: **${row.chance_percent}%**`).join(' · ')}`
      : `Base chance: **${ore.chance ?? 'Not specified'}**`,
    `Multiplier: **${ore.multiplier}×**`,
    ore.multiplier_note ?? ore.display?.multiplier_note,
    `Price: **${ore.price ?? 'Not confirmed'}**`,
    ...(ore.unique_price_multiplier != null ? [`Unique Price Multiplier: **${ore.unique_price_multiplier}×**`] : []),
    ...(ore.shop_offers ?? []).map(
      offer =>
        `${offer.shop}: **${offer.price} ${offer.currency}**${offer.min_guild_level ? ` · guild level ${offer.min_guild_level}` : ''}${offer.monthly_limit ? ` · ${offer.monthly_limit}/month` : ''}`,
    ),
  ]
    .filter(Boolean)
    .join('\n')
}

export function formatForgeLocations(equipment: {
  from?: string[]
  station_chances?: Record<string, number>
  station_requirements?: Record<string, { level?: number }>
}): string {
  return [...new Set(equipment.from ?? [])]
    .map(world => {
      const chance = equipment.station_chances?.[world]
      const level = equipment.station_requirements?.[world]?.level
      return `> - ${world}${chance != null ? ` · ${(chance * 100).toLocaleString('en-US', { maximumFractionDigits: 4 })}% configured chance` : ''}${level != null ? ` · level ${level}` : ''}`
    })
    .join('\n')
}

export function formatRewardRange(range?: { min?: string | number | null; max?: string | number | null }): string {
  return range?.min == null || range.max == null ? 'Configured at runtime' : `${range.min} - ${range.max}`
}
