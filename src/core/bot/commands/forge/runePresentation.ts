import { MessageComponentTypes, type MessageComponents } from 'discordeno';

const text = (value: unknown) => String(value ?? '').trim();
const unique = <T>(items: T[], key: (item: T) => string): T[] => {
  const seen = new Set<string>();
  return items.filter((item) => {
    const id = key(item).trim().toLowerCase();
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
};

export function formatRuneRange(min: number, max: number, unit = '%'): string {
  const number = (value: number) => value.toLocaleString('en-US', { maximumFractionDigits: 3 });
  const suffix = unit === '%' ? '%' : unit === 'seconds' ? 's' : unit === 'studs' ? ' studs' : '';
  return `${number(min)}${min === max ? '' : `–${number(max)}`}${suffix}`;
}

const secondaryMeaning: Record<string, string> = {
  Lethality: 'weapon damage',
  Fracture: 'stun damage',
  Surge: 'dash cooldown reduction',
  Stride: 'dash distance',
  Phase: 'dash invulnerability',
  Vitality: 'maximum health',
  Swiftness: 'movement speed',
  Endurance: 'stamina',
};

const displayStatLabel = (trait: any): string => {
  const name = text(trait.name);
  const meaning = secondaryMeaning[name] ?? '';
  return meaning ? `${name} (${meaning})` : name;
};

/** Player-facing information only; calculator provenance remains in the API. */
export function buildRuneComponents(rune: any): MessageComponents {
  const source = rune.source ?? {};
  const rolls = unique<any>(Array.isArray(rune.roll_fields) ? rune.roll_fields : [], (field) =>
    text(field.key || field.label),
  );
  const secondary = unique<any>(
    Object.entries(rune.subtraits ?? {}).map(([name, trait]) => ({ ...(trait as object), name })),
    (trait) => text(trait.name),
  );
  const obtainment = unique<string>(Array.isArray(rune.obtainment) ? rune.obtainment : [], text);
  const mechanics = unique<string>(rune.display?.mechanics ?? [], text);
  const primaryNames = unique<string>(
    (rune.primary_traits ?? []).map((trait: any) => text(trait.name)),
    text,
  );
  const primaryIds = Array.isArray(source.primary_ids) ? source.primary_ids : [];
  const pickaxeExtrasOnly = rune.type === 'Pickaxe' && primaryIds.length === 0;
  const summary = text(rune.display?.summary) || primaryNames.join(' · ');
  const tier = Number(source.tier) || (/ III$/.test(rune.name) ? 3 : / II$/.test(rune.name) ? 2 : 1);
  const header = `## ${text(rune.name)}\n-# Tier ${tier} · ${text(rune.rarity)} · ${text(rune.type)}`;
  const components: Extract<MessageComponents[number], { type: MessageComponentTypes.Container }>['components'] = [];
  if (rune.image) {
    components.push({
      type: MessageComponentTypes.Section,
      components: [{ type: MessageComponentTypes.TextDisplay, content: header }],
      accessory: { type: MessageComponentTypes.Thumbnail, media: { url: rune.image } },
    });
  } else {
    components.push({ type: MessageComponentTypes.TextDisplay, content: header });
  }

  if (summary) components.push({ type: MessageComponentTypes.TextDisplay, content: summary });
  if (rolls.length) {
    components.push({ type: MessageComponentTypes.Separator });
    components.push({
      type: MessageComponentTypes.TextDisplay,
      content: `**${pickaxeExtrasOnly ? 'Possible extra traits' : 'Primary stats'}**${pickaxeExtrasOnly ? ` · ${formatRuneRange(Number(source.min_subtraits ?? 0), Number(source.max_subtraits ?? 0), 'count')} ${Number(source.max_subtraits ?? 0) === 1 ? 'roll' : 'different rolls'}` : ''}\n${rolls.map((field) => `- ${displayStatLabel({ ...field, name: field.label })}: **${formatRuneRange(field.min, field.max, field.unit)}**`).join('\n')}`,
    });
  } else if (pickaxeExtrasOnly) {
    const minimum = Number(source.min_subtraits ?? 0);
    const maximum = Number(source.max_subtraits ?? 0);
    components.push({ type: MessageComponentTypes.Separator });
    components.push({
      type: MessageComponentTypes.TextDisplay,
      content: `**Extra traits** · ${formatRuneRange(minimum, maximum, 'count')} ${maximum === 1 ? 'roll' : 'different rolls'}\n-# The available game-code snapshot does not contain complete numeric definitions for this extra-trait pool.`,
    });
  }
  if (mechanics.length) {
    components.push({
      type: MessageComponentTypes.TextDisplay,
      content: mechanics.map((entry) => `- ${text(entry)}`).join('\n'),
    });
  }

  const maxSecondary = Number(source.max_subtraits ?? rune.max_subtraits ?? 0);
  const minSecondary = Number(source.min_subtraits ?? 0);
  if (!pickaxeExtrasOnly && maxSecondary > 0 && secondary.length) {
    const count = formatRuneRange(minSecondary, maxSecondary, 'count');
    components.push({ type: MessageComponentTypes.Separator });
    components.push({
      type: MessageComponentTypes.TextDisplay,
      content: `**Secondary traits** · ${count} ${maxSecondary === 1 ? 'roll' : 'different rolls'}\n${secondary.map((trait) => `- ${displayStatLabel(trait)}: **${formatRuneRange(trait.min, trait.max, trait.unit ?? '%')}**`).join('\n')}`,
    });
  } else if (rune.type === 'Pickaxe' && !pickaxeExtrasOnly && maxSecondary > 0) {
    components.push({
      type: MessageComponentTypes.TextDisplay,
      content: `**Extra traits** · ${formatRuneRange(minSecondary, maxSecondary, 'count')} ${maxSecondary === 1 ? 'roll' : 'different rolls'}\n-# The available game-code snapshot does not contain complete numeric definitions for this extra-trait pool.`,
    });
  } else if (maxSecondary === 0) {
    components.push({ type: MessageComponentTypes.TextDisplay, content: '-# This rune has no secondary traits.' });
  }

  if (obtainment.length) {
    components.push({ type: MessageComponentTypes.Separator });
    components.push({
      type: MessageComponentTypes.TextDisplay,
      content: `**Obtained from**\n${obtainment.join(' · ')}`,
    });
  }

  const notes: string[] = [];
  if (source.configuration_supported === false) notes.push('Calculator configuration is unavailable for this rune.');
  if (
    rolls.some((field) => field.source_verified === false) ||
    secondary.some((trait) => trait.source_verified === false)
  ) {
    notes.push('Some roll ranges are not verified against the available game data.');
  }
  if (notes.length) components.push({ type: MessageComponentTypes.TextDisplay, content: `-# ${notes.join(' ')}` });

  return [{ type: MessageComponentTypes.Container, components }];
}
