/** Search results and conversation blocks as compact text for an agent:
 * a few hundred tokens a call, every string masked. */

import type { ConversationView, MessageDoc } from './corpus.js';
import type { ConversationHit, Mention } from './engine.js';
import { maskSecrets } from './secrets.js';

const SNIPPET_LINE_CHARS = 160;

export function shortId(id: string): string {
  return id.slice(0, 8);
}

/** `<conversation>:<message number>`, the number in the conversation's
 * merged numbering: what read_conversation's `at` takes. */
export function anchorOf(conversationId: string, position: number): string {
  return `${shortId(conversationId)}:${position}`;
}

export function parseAnchor(value: unknown): { session?: string; messageIndex: number } | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return { messageIndex: value };
  if (typeof value !== 'string') return undefined;
  const match = /^@?(?:([A-Za-z0-9._-]{6,}):)?#?(\d+)$/.exec(value.trim());
  if (!match) return undefined;
  return { ...(match[1] ? { session: match[1] } : {}), messageIndex: Number(match[2]) };
}

export function ago(atMs: number, now = Date.now()): string {
  if (!Number.isFinite(atMs)) return 'unknown';
  const seconds = Math.max(0, Math.round((now - atMs) / 1000));
  if (seconds < 90) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days < 60 ? `${days}d ago` : new Date(atMs).toISOString().slice(0, 10);
}

/** How long, compactly: `40s`, `12m`, `3h 5m`, `2d 4h`. */
export function duration(ms: number): string {
  if (!Number.isFinite(ms)) return 'unknown';
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

/** `claude · sonnet`: who ran it. */
export function runsOn(item: { provider: string | null; model: string | null; harness?: string }): string {
  return [item.harness ?? item.provider ?? 'no provider', item.model].filter(Boolean).join(' · ');
}

function clipAround(line: string, at: number, width = SNIPPET_LINE_CHARS): string {
  if (line.length <= width) return line;
  const start = Math.max(0, Math.min(line.length - width, at - Math.floor(width / 3)));
  return `${start > 0 ? '…' : ''}${line.slice(start, start + width)}${start + width < line.length ? '…' : ''}`;
}

/** The line a mention is on, with up to `context` lines either side, each
 * clipped, masked. A tool call's text is marked as such. */
export function snippet(message: MessageDoc, mention: Pick<Mention, 'offset'>, context = 1): string {
  const text = message.text;
  const lines = text.split('\n');
  let at = mention.offset;
  let lineIndex = 0;
  for (; lineIndex < lines.length - 1 && at > lines[lineIndex]!.length; lineIndex += 1) at -= lines[lineIndex]!.length + 1;
  const picked: string[] = [];
  for (let index = Math.max(0, lineIndex - context); index <= Math.min(lines.length - 1, lineIndex + context); index += 1) {
    const line = lines[index]!.trim();
    if (!line && index !== lineIndex) continue;
    picked.push(index === lineIndex ? clipAround(lines[index]!.trimEnd(), at) : clipAround(line, 0));
  }
  const where = mention.offset >= message.contentLength ? `${message.role} (tool call)` : message.role;
  return `${where}: ${maskSecrets(picked.join(' ⏎ ').replace(/\s+/g, ' ').trim())}`;
}

/** Snippets for a hit: its first mentions, one per message. They are of
 * the kind counted -- phrase matches when it has any (engine.ts). */
export function hitSnippets(hit: ConversationHit, view: ConversationView, count = 3): string[] {
  const out: string[] = [];
  let last = -1;
  for (const mention of hit.mentions) {
    if (out.length >= count) break;
    if (mention.position === last) continue;
    last = mention.position;
    const message = view.entries[mention.position]?.message;
    if (message) out.push(`@${anchorOf(hit.conversationId, mention.position)} ${snippet(message, mention)}`);
  }
  return out;
}

/** "12 mentions of the phrase", "3 messages with all the words (not the
 * phrase)": what was counted, said. */
export function mentionCount(hit: Pick<ConversationHit, 'mentions' | 'exactCount'>, words: number): string {
  const count = hit.mentions.length;
  if (hit.exactCount) return `${count} mention${count === 1 ? '' : 's'}${words > 1 ? ' of the phrase' : ''}`;
  if (!count) return 'no mentions in its messages';
  return `${count} message${count === 1 ? '' : 's'} with all the words (not the phrase)`;
}

/** One message for read_conversation: what was said, then its tool calls
 * compacted to a label and two lines of output, within `budget`
 * characters. Over budget, the middle goes -- unless `focus` says where the
 * part that matters is, and then the text around it stays. */
export function renderMessage(index: number, message: MessageDoc, budget: number, focus?: number): { text: string; shortened: boolean } {
  const head = `[#${index} ${message.role}]`;
  const content = message.text.slice(0, message.contentLength).trim();
  const calls = message.text.slice(message.contentLength).split('\n').filter(Boolean);
  // A call's own line plus at most two of its output lines.
  const compactCalls: string[] = [];
  let outputKept = 0;
  let dropped = false;
  for (const line of calls) {
    if (line.startsWith('  ⏺')) { compactCalls.push(line); outputKept = 0; continue; }
    if (outputKept < 2) { compactCalls.push(line); outputKept += 1; } else { dropped = true; if (outputKept === 2) { compactCalls.push('    …'); outputKept += 1; } }
  }
  let body = content;
  let callText = compactCalls.join('\n');
  let shortened = dropped;
  const room = Math.max(200, budget - head.length - 2);
  if (body.length + callText.length + 1 > room) {
    shortened = true;
    const callRoom = Math.min(callText.length, Math.floor(room * 0.3));
    if (callText.length > callRoom) {
      const kept = callText.slice(0, callRoom);
      callText = `${kept.slice(0, kept.lastIndexOf('\n') > 0 ? kept.lastIndexOf('\n') : kept.length)}\n  … ${calls.filter((line) => line.startsWith('  ⏺')).length} tool calls in all`;
    }
    const bodyRoom = Math.max(100, room - callText.length - 1);
    if (body.length > bodyRoom) {
      if (focus !== undefined && focus < message.contentLength) {
        const start = Math.max(0, Math.min(body.length - bodyRoom, focus - Math.floor(bodyRoom / 3)));
        body = `${start > 0 ? `[… ${start} chars] ` : ''}${body.slice(start, start + bodyRoom)}${start + bodyRoom < body.length ? ` [… ${body.length - start - bodyRoom} chars]` : ''}`;
      } else {
        const half = Math.floor(bodyRoom / 2);
        body = `${body.slice(0, half)} [… ${body.length - bodyRoom} chars] ${body.slice(body.length - half)}`;
      }
    }
  }
  return { text: maskSecrets([`${head} ${body}`.trimEnd(), ...(callText ? [callText] : [])].join('\n')), shortened };
}

/** One message whole -- what was said and every tool call with all the
 * output it kept -- cut only at `budget` characters. */
export function renderFullMessage(index: number, message: MessageDoc, budget: number): string {
  const text = `[#${index} ${message.role}] ${message.text.trim()}`;
  if (text.length <= budget) return maskSecrets(text);
  return maskSecrets(`${text.slice(0, budget)} [… ${text.length - budget} more chars; raise maxChars]`);
}
