/** The transfer: how a conversation is handed to a provider that cannot be
 * given it as its own native thread (no writer for its harness, or one that
 * declined -- turn/thread-start.ts).
 *
 * Built from the canonical record (session/canonical.ts) with no extra model
 * call, and sized to the model that receives it. What a provider needs to
 * carry on is, in order of how much it matters per byte:
 *
 *   1. every request the user made, in order -- they carry the intent, and
 *      they are short;
 *   2. what was DONE: a digest of every turn's tool calls (kind, target,
 *      outcome), and every file the conversation changed;
 *   3. what was attached earlier, by path, and the todos still open;
 *   4. the newest turns in full -- text, calls and their output -- as the
 *      budget allows, and the older answers condensed to their first and
 *      last sentences (what was set out to do, and where it ended up).
 *
 * It is plumbing, never a message: what is stored and shown is the user's
 * request alone (failover-prompt.ts normalizeImportedTranscript reads it back
 * out of a vendor's copy, by the preamble and the closing current_request). */

import { readFile } from 'node:fs/promises';
import type { CanonicalRecord, CanonicalToolCall, CanonicalTurn } from '../session/canonical.js';
import type { HarnessSession } from '../session/model.js';
import { escapeFailoverContent, FAILOVER_PREAMBLE } from './failover-prompt.js';

/** Smallest budget: what every handoff had before it was sized to a model. */
export const TRANSFER_MIN_BYTES = 48 * 1024;
/** Largest budget. A retelling is not the conversation; past this the
 * newest turns are already whole and older ones add little but cost. */
export const TRANSFER_MAX_BYTES = 200 * 1024;
/** Share of the receiving model's context window the transfer may take,
 * leaving the rest for the vendor's own system prompt, tools and the work. */
export const TRANSFER_WINDOW_SHARE = 0.2;
/** UTF-8 bytes per token, for English prose and code alike (a conservative
 * average: tokenizers run 3.5-4.5). */
const BYTES_PER_TOKEN = 4;
/** Room argv needs beside the prompt (flags, ids, paths). */
const ARGV_HEADROOM_BYTES = 4 * 1024;

const bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

/** How many bytes a transfer may take.
 *
 * - `contextWindow` (tokens), when known: TRANSFER_WINDOW_SHARE of it,
 *   between TRANSFER_MIN_BYTES and TRANSFER_MAX_BYTES. Unknown: the minimum.
 * - `argvLimit`: the harness takes its prompt as a command-line argument
 *   (maxPromptArgvBytes, 96 KB: Linux caps one argument at 128 KiB), so the
 *   whole prompt has to fit there or the turn fails before it starts. */
export function transferBudget(input: { contextWindow?: number; argvLimit?: number }): number {
  const fromWindow = input.contextWindow && input.contextWindow > 0
    ? Math.floor(input.contextWindow * TRANSFER_WINDOW_SHARE * BYTES_PER_TOKEN)
    : TRANSFER_MIN_BYTES;
  const sized = Math.min(TRANSFER_MAX_BYTES, Math.max(TRANSFER_MIN_BYTES, fromWindow));
  return input.argvLimit ? Math.min(sized, Math.max(8 * 1024, input.argvLimit - ARGV_HEADROOM_BYTES)) : sized;
}

/** The receiving model's context window in tokens, where something has
 * reported it -- never a compiled-in table (vendor facts go stale):
 *
 * 1. what the vendor itself said on a turn of that harness and model
 *    (`lastUsage.contextWindow`, the newest such session);
 * 2. the models.dev catalog ClikCode or OpenCode already keeps on disk
 *    (read, never fetched here: this runs before a turn). */
export async function targetContextWindow(
  sessions: readonly HarnessSession[], harness: string, model: string | null | undefined,
  catalogFiles: readonly string[] = [],
): Promise<number | undefined> {
  if (!model) return undefined;
  const reported = sessions
    .filter((session) => session.nativeHarness === harness && (session.model === model || session.reported?.model === model)
      && (session.lastUsage?.contextWindow ?? 0) > 0)
    .sort((left, right) => Date.parse(right.lastUsage?.at ?? '') - Date.parse(left.lastUsage?.at ?? ''))[0];
  if (reported) return reported.lastUsage!.contextWindow;
  const bare = model.replace(/\[.*\]$/, '').split('/').at(-1)!;
  for (const file of catalogFiles) {
    const text = await readFile(file, 'utf8').catch(() => '');
    if (!text) continue;
    try {
      const catalog = JSON.parse(text) as Record<string, { models?: Record<string, { limit?: { context?: unknown } }> }>;
      for (const provider of Object.values(catalog)) {
        const context = (provider?.models?.[model] ?? provider?.models?.[bare])?.limit?.context;
        if (typeof context === 'number' && context > 0) return context;
      }
    } catch { /* fail-open-ok: an unreadable catalog only means the minimum budget */ }
  }
  return undefined;
}

function sliceBytes(text: string, maxBytes: number, from: 'start' | 'end'): string {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return text;
  const part = from === 'start' ? buffer.subarray(0, Math.max(0, maxBytes)) : buffer.subarray(buffer.length - Math.max(0, maxBytes));
  // Drop the partial code point a byte cut can leave at either edge.
  return part.toString('utf8').replace(/^�+|�+$/g, '');
}

/** Head and tail of an over-long text: how it began and where it ended. */
function truncateMiddle(text: string, maxBytes: number): string {
  const total = bytes(text);
  if (total <= maxBytes) return text;
  const room = Math.max(64, maxBytes - 64);
  const head = sliceBytes(text, Math.ceil(room * 0.6), 'start');
  const tail = sliceBytes(text, Math.floor(room * 0.4), 'end');
  return `${head}\n[… ${total - bytes(head) - bytes(tail)} bytes left out …]\n${tail}`;
}

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

function clipLine(text: string, max: number): string {
  const flat = oneLine(text);
  return flat.length > max ? `${flat.slice(0, Math.max(1, max - 1))}…` : flat;
}

/** An answer condensed to its first and last sentences, code left out:
 * what it set out to do and where it ended up. */
export function extractiveSummary(text: string, maxChars = 400): string {
  const prose = text.replace(/```[\s\S]*?(```|$)/g, '\n').trim();
  const sentences = prose.split(/(?<=[.!?])\s+|\n+/).map(oneLine).filter(Boolean);
  if (!sentences.length) return '';
  const half = Math.floor(maxChars / 2) - 4;
  const first = clipLine(sentences[0]!, sentences.length > 1 ? half : maxChars);
  if (sentences.length === 1) return first;
  const last = clipLine(sentences.at(-1)!, half);
  return sentences.length === 2 ? `${first} ${last}` : `${first} … ${last}`;
}

function outcome(call: CanonicalToolCall): string {
  if (call.status === 'failed') return call.exitCode !== undefined ? ` (failed, exit ${call.exitCode})` : ' (failed)';
  if (call.status === 'unfinished') return ' (not finished)';
  return '';
}

/** `edit src/a.ts`, `run npm test (failed, exit 1)`, `github › create_issue`. */
function callDigest(call: CanonicalToolCall, max = 100): string {
  const kind = call.agent ? 'agent' : call.category ?? call.name;
  const target = call.target ?? (call.files[0] || '');
  return `${kind}${target ? ` ${clipLine(target, max)}` : ''}${outcome(call)}`;
}

/** A turn's calls in one line, or (`compact`) counted by kind with the
 * files it changed. */
function turnDigest(turn: CanonicalTurn, compact: boolean): string {
  const label = `T${turn.index + 1}${turn.origin.harness ? ` (${turn.origin.harness})` : ''}: `;
  if (!compact) return `${label}${turn.tools.map((call) => callDigest(call)).join('; ')}`;
  const counts = new Map<string, { all: number; failed: number }>();
  for (const call of turn.tools) {
    const kind = call.agent ? 'agent' : call.category ?? 'other';
    const entry = counts.get(kind) ?? { all: 0, failed: 0 };
    entry.all += 1;
    if (call.status === 'failed') entry.failed += 1;
    counts.set(kind, entry);
  }
  const parts = [...counts].map(([kind, { all, failed }]) => `${all} ${kind}${failed ? ` (${failed} failed)` : ''}`);
  const files = turn.touchedFiles.length ? ` changed ${turn.touchedFiles.slice(0, 4).join(', ')}${turn.touchedFiles.length > 4 ? ` +${turn.touchedFiles.length - 4}` : ''}` : '';
  return `${label}${parts.join(', ')}${files}`;
}

/** Lines that fit `budget`, newest kept first, each in its fuller form while
 * there is room for it. Returns them oldest first, with what had to go. */
function fitNewestFirst(rows: Array<{ full: string; compact?: string }>, budget: number): { lines: string[]; dropped: number } {
  const lines: string[] = [];
  let room = budget;
  let index = rows.length - 1;
  for (; index >= 0; index -= 1) {
    const row = rows[index]!;
    const line = bytes(row.full) + 1 <= room ? row.full : row.compact && bytes(row.compact) + 1 <= room ? row.compact : undefined;
    if (line === undefined) break;
    lines.unshift(line);
    room -= bytes(line) + 1;
  }
  return { lines, dropped: index + 1 };
}

/** A turn in full: the request, then the answer with its calls where they
 * happened. The newest turns (`withOutput`) show what their calls printed. */
function verbatimTurn(turn: CanonicalTurn, withOutput: boolean): string {
  const blocks: string[] = [];
  if (turn.user.trim() || turn.attachments.length) {
    const attached = turn.attachments.length ? `\n[attached: ${turn.attachments.join(', ')}]` : '';
    blocks.push(`<message role="user">\n${escapeFailoverContent(turn.user)}${escapeFailoverContent(attached)}\n</message>`);
  }
  const answer = turn.parts.map((part) => {
    if (part.type === 'text') return part.text;
    const output = withOutput && part.call.output?.length
      ? `\n${part.call.outputTail && part.call.outputOmitted ? `  … ${part.call.outputOmitted} earlier lines\n` : ''}${part.call.output.slice(-12).map((line) => `  ${line}`).join('\n')}${!part.call.outputTail && part.call.outputOmitted ? `\n  … ${part.call.outputOmitted} more lines` : ''}`
      : '';
    return `\n[tool: ${part.call.label}${outcome(part.call)}]${output}\n`;
  }).join('').trim();
  const interrupted = turn.interrupted ? '\n[interrupted here: this answer was cut off]' : '';
  if (answer || interrupted) blocks.push(`<message role="assistant">\n${escapeFailoverContent(answer)}${interrupted}\n</message>`);
  return blocks.join('\n');
}

/** An older turn condensed: its request and the first and last sentences
 * of its answer. The calls are in the digest. */
function condensedTurn(turn: CanonicalTurn): string {
  const user = turn.user.trim() ? `<message role="user">\n${escapeFailoverContent(clipLine(turn.user, 300))}\n</message>\n` : '';
  const summary = extractiveSummary(turn.assistant);
  const calls = turn.tools.length ? ` [${turn.tools.length} tool call${turn.tools.length === 1 ? '' : 's'}]` : '';
  return `${user}<message role="assistant" condensed="true">\n${escapeFailoverContent(summary || '(no text)')}${calls}\n</message>`;
}

export interface TransferOptions {
  /** Total UTF-8 budget (transferBudget). */
  maxBytes?: number;
  /** The newest turn's answer was cut off and the request continues it. */
  interrupted?: boolean;
  /** Harness command -> display name, for the header. */
  displayName?: (harness: string) => string | undefined;
}

/** The transfer prompt: `record` retold within `maxBytes`, ending in the
 * request to answer now. */
export function transferPrompt(record: CanonicalRecord, request: string, options: TransferOptions = {}): string {
  const maxBytes = Math.max(4 * 1024, options.maxBytes ?? TRANSFER_MIN_BYTES);
  const turns = record.turns.map((turn, index) => (
    options.interrupted && index === record.turns.length - 1 ? { ...turn, interrupted: true } : turn));
  // The request is never dropped, only (pathologically) trimmed so the frame
  // itself still fits.
  const current = truncateMiddle(escapeFailoverContent(request), Math.floor(maxBytes * 0.5));
  const fixed = bytes(FAILOVER_PREAMBLE) + bytes(current) + 400;
  const room = Math.max(1024, maxBytes - fixed);
  const sections: string[] = [];
  let used = 0;
  const add = (text: string): void => { sections.push(text); used += bytes(text) + 2; };

  // What this is: how long, and who produced which part.
  const runs: string[] = [];
  for (const turn of turns) {
    const name = turn.origin.harness ? options.displayName?.(turn.origin.harness) ?? turn.origin.harness : turn.origin.route ?? 'ClikCode';
    const who = `${name}${turn.origin.model ? ` (${turn.origin.model})` : ''}`;
    const last = runs.at(-1);
    const range = (from: number, to: number): string => (from === to ? `turn ${from}` : `turns ${from}-${to}`);
    const match = last && /^(.*): turns? (\d+)(?:-\d+)?$/.exec(last);
    if (match && match[1] === who) runs[runs.length - 1] = `${who}: ${range(Number(match[2]), turn.index + 1)}`;
    else runs.push(`${who}: ${range(turn.index + 1, turn.index + 1)}`);
  }
  if (turns.length) {
    add(`This chat has ${turns.length} earlier turn${turns.length === 1 ? '' : 's'} (${runs.join('; ')}). Below: every request in order, a digest of the tool calls and the files changed, then the most recent turns in full and older answers condensed.`);
  }

  // 1. Every request, compact. All of them, however many: each is clipped
  // harder rather than any dropped.
  const asked = turns.filter((turn) => turn.user.trim());
  if (asked.length) {
    const share = Math.floor(room * 0.25);
    const per = Math.max(60, Math.min(600, Math.floor(share / asked.length) - 12));
    const lines = asked.map((turn) => `${turn.index + 1}. ${escapeFailoverContent(clipLine(turn.user, per))}${turn.attachments.length ? ` [attached: ${escapeFailoverContent(turn.attachments.join(', '))}]` : ''}`);
    add(`<requests>\n${lines.join('\n')}\n</requests>`);
  }

  // 2. What was done: every turn's calls, newest in full, older counted.
  const called = turns.filter((turn) => turn.tools.length);
  if (called.length) {
    const fit = fitNewestFirst(called.map((turn) => ({ full: escapeFailoverContent(turnDigest(turn, false)), compact: escapeFailoverContent(turnDigest(turn, true)) })), Math.floor(room * 0.15));
    const note = fit.dropped ? `(${fit.dropped} earlier turn${fit.dropped === 1 ? '' : 's'} with tool calls not listed)\n` : '';
    add(`<tool_digest>\n${note}${fit.lines.join('\n')}\n</tool_digest>`);
  }
  if (record.touchedFiles.length) {
    const last = turns.at(-1);
    const partial = options.interrupted && last?.touchedFiles.length
      ? `\nThe interrupted turn had started changing ${last.touchedFiles.map(escapeFailoverContent).join(', ')}; they may be partially edited. Check each before editing again.`
      : '';
    const fit = fitNewestFirst(record.touchedFiles.map((file) => ({ full: `- ${escapeFailoverContent(file)}` })), Math.floor(room * 0.06));
    const note = fit.dropped ? `(+${fit.dropped} more)\n` : '';
    add(`<touched_files>\nFiles changed in this chat:\n${note}${fit.lines.join('\n')}${partial}\n</touched_files>`);
  }

  // 3. Earlier attachments by path, and what is still open.
  if (record.attachments.length) {
    const fit = fitNewestFirst(record.attachments.map((file) => ({ full: `- ${escapeFailoverContent(file)}` })), Math.floor(room * 0.04));
    add(`<attachments>\nFiles attached to earlier requests (read them if they matter now):\n${fit.dropped ? `(+${fit.dropped} more)\n` : ''}${fit.lines.join('\n')}\n</attachments>`);
  }
  if (record.openTodos.length) {
    const fit = fitNewestFirst(record.openTodos.map((todo) => ({ full: `- [${todo.status ?? 'pending'}] ${escapeFailoverContent(clipLine(todo.content, 200))}` })), Math.floor(room * 0.04));
    add(`<open_todos>\n${fit.lines.join('\n')}\n</open_todos>`);
  }

  // 4. The newest turns in full as the budget allows, older ones condensed.
  // Once one turn does not fit whole, every older one is condensed: a full
  // turn behind a condensed one would read out of order. Up to a third of
  // the room is kept for the condensed ones, so a few long recent turns
  // cannot crowd out the arc of the whole conversation.
  let remaining = room - used;
  const condensed = turns.map(condensedTurn);
  const reserve = Math.min(Math.floor(remaining * 0.35), condensed.reduce((sum, text) => sum + bytes(text) + 1, 0));
  let wholeRoom = remaining - reserve;
  const told: string[] = [];
  let whole = true;
  let index = turns.length - 1;
  for (; index >= 0; index -= 1) {
    const turn = turns[index]!;
    const age = turns.length - 1 - index;
    let text = whole ? verbatimTurn(turn, age < 3) : undefined;
    if (text !== undefined && bytes(text) + 1 > wholeRoom) {
      // The newest turn is the one most worth having: cut its middle rather
      // than condense it.
      if (age === 0 && wholeRoom > 2048) text = truncateMiddle(text, wholeRoom - 64);
      else { whole = false; text = undefined; }
    }
    if (text !== undefined) wholeRoom -= bytes(text) + 1;
    text ??= condensed[index]!;
    if (bytes(text) + 1 > remaining) break;
    told.unshift(text);
    remaining -= bytes(text) + 1;
  }
  const omitted = index + 1;
  const note = omitted > 0 ? `\n(${omitted} earlier turn${omitted === 1 ? '' : 's'} not retold; their requests are listed above.)` : '';
  const conversation = turns.length ? `\n\n<conversation>${note}\n${told.join('\n')}\n</conversation>` : '';
  const head = sections.length ? `\n\n${sections.join('\n\n')}` : '';
  return `${FAILOVER_PREAMBLE}${head}${conversation}\n\n<current_request>\n${current}\n</current_request>`;
}
