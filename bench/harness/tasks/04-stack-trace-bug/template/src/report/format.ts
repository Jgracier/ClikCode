import type { Ticket } from '../data/types.ts';

export function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

/** "T-12  Login fails  [auth, urgent]" */
export function ticketLine(ticket: Ticket, titleWidth: number): string {
  return `${pad(ticket.id, 8)}${pad(ticket.title, titleWidth)}  [${ticket.tags.join(', ')}]`;
}
