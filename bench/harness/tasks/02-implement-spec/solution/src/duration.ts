import { UNIT_MS } from './units.ts';

const ORDER = Object.keys(UNIT_MS).sort((a, b) => UNIT_MS[b] - UNIT_MS[a]);

export function parseDuration(text: string): number {
  const trimmed = text.trim();
  const invalid = () => new RangeError(`invalid duration: ${JSON.stringify(text)} (${text})`);
  if (!trimmed) throw invalid();
  let total = 0;
  let last = -1;
  let rest = trimmed;
  while (rest) {
    const match = /^(\d+)(ms|[wdhms])/.exec(rest);
    if (!match) throw invalid();
    const index = ORDER.indexOf(match[2]);
    if (index <= last) throw invalid();
    last = index;
    total += Number(match[1]) * UNIT_MS[match[2]];
    rest = rest.slice(match[0].length);
  }
  return total;
}

export function formatDuration(ms: number): string {
  if (!Number.isInteger(ms) || ms < 0) throw new RangeError(`invalid milliseconds: ${ms}`);
  if (ms === 0) return '0ms';
  let rest = ms;
  let out = '';
  for (const unit of ORDER) {
    const count = Math.floor(rest / UNIT_MS[unit]);
    if (count) out += `${count}${unit}`;
    rest -= count * UNIT_MS[unit];
  }
  return out;
}
