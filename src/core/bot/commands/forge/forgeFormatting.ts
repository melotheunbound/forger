import type { StoredRuneRollMeta } from './forgeTypes';

export function formatRuneRollValue(rune: any, key: string, rawValue: unknown): string {
  const value = Number(rawValue);
  const meta: StoredRuneRollMeta | undefined = rune?.roll_meta?.[key];
  if (meta && Number.isFinite(value)) {
    const scale = Number(meta.input_scale || 1);
    const display = Number((value / scale).toFixed(6));
    if (meta.unit === '%') return `${display}%`;
    if (meta.unit === 'seconds') return `${display}s`;
    if (meta.unit === 'studs') return `${display} studs`;
    return String(display);
  }
  if (/chance|percent|damage|lifesteal|reduction|boost/i.test(key)) return `${rawValue}%`;
  if (/duration|cooldown/i.test(key)) return `${rawValue}s`;
  return String(rawValue);
}

export function normalizeUiText(value: unknown): string {
  return String(value ?? '').replace(/[—–]/g, '-');
}

function humanizeIdentifier(value: string): string {
  return normalizeUiText(value)
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

export function formatRenderedTrait(rawTrait: unknown): string {
  let text = normalizeUiText(rawTrait).trim();
  if (!text) return '';

  let suffix = '';
  const suffixIndex = text.indexOf(' (conditional;');
  if (suffixIndex >= 0) {
    suffix = text.slice(suffixIndex);
    text = text.slice(0, suffixIndex);
  }

  const separatorIndex = text.indexOf(' - ');
  if (separatorIndex < 0) return `${humanizeIdentifier(text)}${suffix}`;

  const rawTraitName = text.slice(0, separatorIndex).trim();
  const traitName = humanizeIdentifier(rawTraitName);
  const rawEffects = text.slice(separatorIndex + 3).trim();
  const effects = rawEffects
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const colonIndex = part.indexOf(':');
      if (colonIndex < 0) return { rawKey: '', label: humanizeIdentifier(part), value: '' };
      const rawKey = part.slice(0, colonIndex).trim();
      return {
        rawKey,
        label: humanizeIdentifier(rawKey),
        value: normalizeUiText(part.slice(colonIndex + 1).trim()),
      };
    });

  if (effects.length === 1) {
    const effect = effects[0]!;
    const sameName =
      humanizeIdentifier(effect.rawKey).replace(/\s+/g, '').toLowerCase() ===
      traitName.replace(/\s+/g, '').toLowerCase();

    if (sameName && effect.value) return `${traitName}: ${effect.value}${suffix}`;
    if (effect.value) return `${traitName} - ${effect.label}: ${effect.value}${suffix}`;
  }

  const renderedEffects = effects
    .map((effect) => (effect.value ? `${effect.label}: ${effect.value}` : effect.label))
    .join(', ');
  return `${traitName}${renderedEffects ? ` - ${renderedEffects}` : ''}${suffix}`;
}
