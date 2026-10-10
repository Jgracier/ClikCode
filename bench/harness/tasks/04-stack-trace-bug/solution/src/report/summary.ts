import type { Ticket } from '../data/types.ts';
import { ticketLine } from './format.ts';

export interface Summary {
  total: number;
  untagged: number;
  byTag: Record<string, number>;
  longestTitle: number;
}

export function summarize(tickets: Ticket[]): Summary {
  const byTag: Record<string, number> = {};
  let untagged = 0;
  let longestTitle = 0;
  for (const ticket of tickets) {
    const tags = ticket.tags ?? [];
    longestTitle = Math.max(longestTitle, ticket.title.length);
    if (tags.length === 0) untagged += 1;
    for (const tag of tags) byTag[tag] = (byTag[tag] ?? 0) + 1;
  }
  return { total: tickets.length, untagged, byTag, longestTitle };
}

export function renderReport(tickets: Ticket[]): string {
  const summary = summarize(tickets);
  const lines = tickets.map((ticket) => ticketLine(ticket, summary.longestTitle));
  const tags = Object.entries(summary.byTag)
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .map(([tag, count]) => `${tag}: ${count}`);
  return [...lines, '', `Total: ${summary.total}`, `Untagged: ${summary.untagged}`, ...tags].join('\n');
}
