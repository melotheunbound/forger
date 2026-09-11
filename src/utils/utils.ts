import fs from 'fs';
import path, { join } from 'path';
import { pathToFileURL } from 'url';
import CallStack from 'libs/stack';
import { readdir } from 'fs/promises';
import { Emoji } from 'core/emojis';

export const readableFileSizeUnits = ['kB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];

export function readableFileSize(bytes: number, micro: boolean = false, precision = 1): string {
  const thresh = micro ? 1000 : 1024;

  if (Math.abs(bytes) < thresh) {
    return `${bytes} B`;
  }

  let unit = -1;
  const round = 10 ** precision;

  do {
    bytes /= thresh;
    ++unit;
  } while (Math.round(Math.abs(bytes) * round) / round >= thresh && unit < readableFileSizeUnits.length - 1);

  return `${bytes.toFixed(precision)} ${readableFileSizeUnits[unit]}`;
}

export function buildQueryString(params: Record<string, any>): string {
  return new URLSearchParams(params).toString();
}

export function debounce(fn: any, delay: number) {
  let timeout: any;

  return function (...args: any) {
    clearTimeout(timeout);
    timeout = setTimeout(fn.bind(null, ...args), delay);
  };
}

const table = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  table[i] = c;
}

export function closestMatch(input: string, strings: readonly string[]): string | null {
  if (typeof input !== 'string') throw new TypeError('Input must be a string.');
  if (!Array.isArray(strings)) throw new TypeError('Strings must be an array.');
  for (const s of strings) {
    if (typeof s !== 'string') throw new TypeError('Strings must only contain strings.');
  }

  if (strings.length === 0) return null;
  if (strings.length === 1) {
    const [only] = strings;
    return only ?? null;
  }

  let minDistance = Number.MAX_VALUE;
  let best: string | null = null;

  for (const candidate of strings) {
    const distance = levenshteinDistance(input, candidate);
    if (distance < minDistance) {
      minDistance = distance;
      best = candidate;
    }
  }

  return best;
}

export function levenshteinDistance(a: string, b: string): number {
  if (typeof a !== 'string' || typeof b !== 'string') {
    throw new TypeError('Levenshtein Distance expects two strings.');
  }

  if (a === b) return 0;
  const n = a.length;
  const m = b.length;
  if (n === 0) return m;
  if (m === 0) return n;

  let prev: Uint32Array = new Uint32Array(m + 1);
  let curr: Uint32Array = new Uint32Array(m + 1);

  for (let j = 0; j <= m; j++) {
    prev[j] = j;
  }

  for (let i = 1; i <= n; i++) {
    curr[0] = i;
    const ai = a.charCodeAt(i - 1);

    for (let j = 1; j <= m; j++) {
      const cost = ai === b.charCodeAt(j - 1) ? 0 : 1;

      const del = (prev[j] as number) + 1;
      const ins = (curr[j - 1] as number) + 1;
      const sub = (prev[j - 1] as number) + cost;

      curr[j] = Math.min(del, ins, sub);
    }

    const tmp = prev;
    prev = curr;
    curr = tmp;
  }

  return prev[m] as number;
}

export async function readDirectory(folder: string): Promise<void> {
  const files = await readdir(folder, { recursive: true });

  for (const filename of files) {
    const normalizedFilename = filename.replaceAll('\\', '/').toLowerCase();

    if (!normalizedFilename.endsWith('.ts')) continue;
    if (
      normalizedFilename.endsWith('.test.ts') ||
      normalizedFilename.endsWith('.spec.ts') ||
      normalizedFilename.endsWith('.d.ts') ||
      normalizedFilename.split('/').includes('__tests__')
    ) {
      continue;
    }

    const fullPath = join(folder, filename);

    await import(pathToFileURL(fullPath).href).catch((e) =>
      console.log(`Cannot import file (${fullPath}) for reason:`, e),
    );
  }
}

export default function or<Value1 = any, Value2 = any>(ifExists: Value1, ifNot: Value2): NonNullable<Value1> | Value2 {
  return ifExists !== null && ifExists !== undefined && !Number.isNaN(ifExists)
    ? (ifExists as NonNullable<Value1>)
    : ifNot;
}

export function toEmoji(name: keyof typeof Emoji) {
  const emoji = Emoji[name];

  if (!emoji) {
    throw new Error(`Emoji "${name}" not found`);
  }

  return {
    id: emoji.replace(/<a?:[a-z0-9_]*:([0-9]*)>/g, '$1'),
    name: 'e',
    animated: emoji.startsWith('<a:'),
  };
}
