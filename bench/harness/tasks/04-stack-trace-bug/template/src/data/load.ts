import { readFileSync } from 'node:fs';
import type { Ticket } from './types.ts';

/** One JSON ticket per line; blank lines are skipped. */
export function loadTickets(path: string): Ticket[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Ticket);
}
