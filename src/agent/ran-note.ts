const BRIEF_CALLS = 12;

/** The note that tells a model, on the USER side of a turn, which calls ran while it was answered. Never on the
 * assistant side: a weak model copies any line it finds in its own past answers and then prints it instead of
 * calling the tool (measured on qwen4-max: 2 of 4 replies at 100k tokens of history were a fake `[Tool calls: ...]`
 * report, none with this note). */
export function ranNote(labels: readonly string[]): string {
  const unique = [...new Set(labels)];
  return unique.length
    ? `\n\n(ClikCode note, not the user's words: answering this, the assistant ran ${unique.slice(0, BRIEF_CALLS).join('; ')}${unique.length > BRIEF_CALLS ? `; and ${unique.length - BRIEF_CALLS} more` : ''}.)`
    : '';
}

const OLD_CALLS_LINE = /^\[Tool calls: ([\s\S]*?)\](?:\n\n|$)/;

/** A memory seeded before calls moved to the user side holds `[Tool calls: ...]` lines in the assistant's own words.
 * Rewrite them as the note on the request they answered, so the pattern is gone from every memory, old and new. */
export function callsAsUserNotes<T extends { type: string; role?: string; text?: string }>(items: readonly T[]): T[] {
  const out: T[] = [];
  for (const item of items) {
    const match = item.type === 'text' && item.role === 'assistant' && typeof item.text === 'string' ? OLD_CALLS_LINE.exec(item.text) : null;
    const before = out.at(-1);
    if (!match || !before || before.type !== 'text' || before.role !== 'user' || typeof before.text !== 'string') { out.push(item); continue; }
    out[out.length - 1] = { ...before, text: `${before.text}${ranNote([match[1]!])}` };
    out.push({ ...item, text: item.text!.slice(match[0].length) || '(no reply)' });
  }
  return out;
}
