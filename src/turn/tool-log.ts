/** One line in the lifecycle log for a finished tool call, the same fields whichever path ran it.
 *
 * A vendor reports a call twice -- it starts (with its name and arguments), then it ends (often
 * with only an id and a result) -- and the log used to read the name off the ending, which does
 * not have it: 48 failed calls in one turn were all called `tool`. The start is kept by id and
 * joined to the end here, so the record has what the call was, whether it was a sub-agent's, how
 * long it took, how it ended and, when it failed, the first line of why. Never the arguments or
 * the output: what a tool read or wrote is the user's, not the log's. */
import { redactForLog } from '../runtime/redact.js';
import type { HarnessActivityEvent } from '../harness/prompter.js';

const MAX_OPEN = 400;
const ERROR_LINE = 160;

/** The first line that says something, with secrets masked, cut to one short line. */
export function firstErrorLine(output: string | readonly string[] | undefined): string | undefined {
  const text = typeof output === 'string' ? output : output?.join('\n');
  const line = text?.split(/\r?\n/).map((part) => part.trim()).find((part) => part && !/^```/.test(part));
  return line ? redactForLog(line).slice(0, ERROR_LINE) : undefined;
}

export interface ToolLogFields {
  name: string;
  ok: boolean;
  id?: string;
  category?: string;
  /** A sub-agent's call, not the turn's own. */
  child?: true;
  ms?: number;
  exit?: number;
  state?: string;
  err?: string;
}

/** What a vendor's calls looked like when they began, by call id. */
export function createToolLog(now: () => number = Date.now): {
  note(event: HarnessActivityEvent): void;
  finished(event: HarnessActivityEvent): ToolLogFields;
} {
  const open = new Map<string, { name: string; category?: string; child: boolean; at: number }>();
  const nameOf = (event: HarnessActivityEvent): string | undefined => event.call?.name || undefined;
  return {
    note(event) {
      if (event.kind !== 'tool-start' || !event.id || open.has(event.id)) return;
      if (open.size >= MAX_OPEN) open.delete(open.keys().next().value as string);
      open.set(event.id, { name: nameOf(event) || event.category || 'tool', ...(event.category ? { category: event.category } : {}), child: Boolean(event.parentId), at: now() });
    },
    finished(event) {
      const start = event.id ? open.get(event.id) : undefined;
      if (event.id) open.delete(event.id);
      const ok = event.kind === 'tool-done';
      const category = event.category ?? start?.category;
      const ms = event.durationMs ?? (start ? now() - start.at : undefined);
      const err = ok ? undefined : firstErrorLine(event.output);
      return {
        name: (nameOf(event) || start?.name || category || 'tool').slice(0, 80),
        ok,
        ...(event.id ? { id: event.id.slice(-8) } : {}),
        ...(category ? { category } : {}),
        ...(event.parentId || start?.child ? { child: true as const } : {}),
        ...(ms !== undefined ? { ms } : {}),
        ...(event.exitCode !== undefined ? { exit: event.exitCode } : {}),
        ...(err ? { err } : {}),
      };
    },
  };
}
