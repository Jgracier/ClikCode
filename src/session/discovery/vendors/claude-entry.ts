/** Which entries of a Claude Code thread a person typed.
 *
 * Claude writes one JSON line per entry, and several kinds of line carry `role: user` text that nobody typed: a tool's
 * result, a sub-agent's exchange (`isSidechain`), a compaction's summary (`isCompactSummary`), and notes Claude Code
 * writes to its own model (`isMeta`: "Your response above was stopped by a safety classifier", a slash command's caveat).
 * And one kind that IS typed is not a `user` entry at all: a message sent while a turn runs is taken into that turn
 * as a `queued_command` attachment.
 *
 * Three readers each had their own version of this rule, and disagreed. The one that copies a thread into the
 * conversation skipped nothing, so Claude's notes appeared in the chat as the person's own messages; the one that
 * measures a thread against the conversation never saw a message sent mid-turn, so a steered turn made the thread
 * look behind and the whole conversation was retold. This is the one rule; a reader that needs it asks here.
 *
 * Imports nothing: it is read on every turn's start. */

export interface ClaudeThreadEntry {
  type?: unknown;
  isSidechain?: unknown;
  isMeta?: unknown;
  isCompactSummary?: unknown;
  timestamp?: unknown;
  origin?: unknown;
  message?: unknown;
  attachment?: unknown;
}

/** A Claude message's text: a string, or its text blocks (a tool's result has none). */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap((block) => (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text' ? [String((block as { text?: unknown }).text ?? '')] : [])).join('\n');
}

/** Cheap test before parsing a line: only these two kinds of line can hold a typed request. */
export function mayHoldClaudeRequest(line: string): boolean {
  return line.includes('"type":"user"') || line.includes('"queued_command"');
}

/** What the person typed in this entry, with when; undefined for every entry nobody typed. The text is as Claude holds
 * it: a caller that shows it still removes the envelopes a client wraps around a request (visibleNativeUserText). */
export function claudeTypedRequest(entry: ClaudeThreadEntry): { text: string; at?: string } | undefined {
  if (entry.isSidechain) return undefined;
  let text: string;
  let at = typeof entry.timestamp === 'string' ? entry.timestamp : undefined;
  if (entry.type === 'user') {
    if (entry.isMeta || entry.isCompactSummary) return undefined;
    if ((entry.origin as { kind?: unknown } | undefined)?.kind === 'task-notification') return undefined;
    text = textOf((entry.message as { content?: unknown } | undefined)?.content);
  } else if (entry.type === 'attachment') {
    const attachment = entry.attachment as { type?: unknown; prompt?: unknown; commandMode?: unknown; timestamp?: unknown } | undefined;
    if (attachment?.type !== 'queued_command' || attachment.commandMode !== 'prompt') return undefined;
    text = textOf(attachment.prompt);
    if (typeof attachment.timestamp === 'string') at = attachment.timestamp;
  } else return undefined;
  if (!text.trim()) return undefined;
  return { text, ...(at ? { at } : {}) };
}
