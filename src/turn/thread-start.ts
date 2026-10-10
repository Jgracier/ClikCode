/** The one way a provider takes up a conversation it has no live thread for.
 *
 * Every route there -- a provider switch, switching back to one used before,
 * a fork, "Resume in", an account failover whose thread could not be carried,
 * a thread the vendor no longer knows -- ends here, and one rule decides:
 *
 *   (a) the target harness has a native-thread writer (NativeSessionStore
 *       `writer`) that accepts the installed vendor build: the whole canonical
 *       record is written as the vendor's own thread, in the taking-over
 *       account's profile, and the turn resumes it by id. The vendor then
 *       holds the conversation exactly as if it had been there all along.
 *   (b) otherwise: the transfer prompt (turn/transfer.ts), sized to the model
 *       that receives it.
 *
 * A writer that declines, fails or throws is (b) for that turn: the transfer
 * always works, so nothing here can fail the turn. So is a model route that
 * keeps no history (keepsNoHistory): a written thread would be resumed into
 * a provider that never sees it. */

import type { AiLocalHarnessDefinition } from '../harness/definition.js';
import { markProviderBoundaries, type CanonicalRecord, type CanonicalTurn } from '../session/canonical.js';
import { summarizedRecord, summaryNote, type ConversationSummary } from '../session/conversation-summary.js';
import type { NativeSessionEnvironment, NativeThreadWriter, NativeThreadWritten } from '../session/discovery/stores.js';
import { modelProvider } from '../runtime/lazy-bridge.js';
import { BYTES_PER_TOKEN, transferBudget, transferPrompt } from './transfer.js';

/** The model runs behind a provider that keeps no history between one-shot
 * turns (catalog `turn.statelessProviders`: Goose's `claude-code`). Its
 * thread is forgotten after every turn, and no thread is written for it:
 * only the transfer reaches the model. */
export function keepsNoHistory(harness: AiLocalHarnessDefinition, model: string | null): boolean {
  const stateless = harness.turn?.statelessProviders;
  return Boolean(model && stateless?.length && stateless.includes(modelProvider(harness, model) ?? ''));
}

export type ThreadStart =
  /** Resume `written.nativeId`; send `prompt` (the request itself). */
  | { kind: 'native'; written: NativeThreadWritten; prompt: string; omitted: number }
  /** A fresh thread; send `prompt` (the transfer, ending in the request). */
  | { kind: 'transfer'; prompt: string; budget: number };

export interface ThreadStartInput {
  record: CanonicalRecord;
  /** What to answer now: the user's request as the turn would send it, or
   * INTERRUPTED_TURN_REQUEST (+ what the interrupted request carried). */
  request: string;
  /** The record's newest turn was cut off and `request` continues it. */
  interrupted: boolean;
  harness: AiLocalHarnessDefinition;
  workspace: string;
  /** The taking-over account's environment for this harness. */
  environment: NativeSessionEnvironment;
  model: string | null;
  /** The receiving model's context window in tokens, where known. */
  contextWindow?: number;
  /** Bytes a prompt may take when it travels in argv; absent when the turn's
   * transport passes it another way (stdin, ACP, app-server). */
  argvLimit?: number;
  /** The writer for this harness, if any (registry: nativeSessionStore). */
  writer?: NativeThreadWriter;
  /** The conversation's summary (conversation-summary.ts): it stands for the
   * turns it covers, written the way the receiving harness keeps its own. */
  summary?: ConversationSummary;
  /** The installed vendor build (first line of `--version`). */
  version?: () => Promise<string | undefined>;
  displayName?: (harness: string) => string | undefined;
  /** Told why a writer was not used, for the lifecycle log. */
  onFallback?: (reason: string) => void;
}

/** Share of the receiving model's context window a written thread may take:
 * the conversation itself, so more than a transfer's retelling, and the rest
 * for the vendor's system prompt, tools and the work. A whole conversation
 * written regardless overflowed the model (365K tokens into a 262K one) or a
 * free plan's whole day (Grok: 603K of 500K tokens) before the turn began. */
export const NATIVE_WINDOW_SHARE = 0.5;
/** The budget when nothing has reported the model's window. */
export const NATIVE_DEFAULT_BYTES = 400 * 1024;

export function nativeThreadBudget(contextWindow?: number): number {
  return contextWindow && contextWindow > 0 ? Math.floor(contextWindow * NATIVE_WINDOW_SHARE * BYTES_PER_TOKEN) : NATIVE_DEFAULT_BYTES;
}

/** What a writer serializes of a turn: the request and the ordered parts.
 * `assistant` and `tools` repeat what the parts hold, so counting the whole
 * object measured every turn about twice over. */
function writtenBytes(turn: CanonicalTurn): number {
  return Buffer.byteLength(turn.user, 'utf8') + Buffer.byteLength(JSON.stringify(turn.parts), 'utf8');
}

/** Calls named in an older turn's summary line, at most. */
const BRIEF_CALLS = 12;

/** An older turn as its words and one line saying what its calls did
 * ("Did: $ npm test · Edit src/a.ts"), with no call records: the detail of
 * old work is what a model needs least, and in a long chat it was nearly all
 * the bytes -- 5 MB of tool output and arguments in one 256-turn
 * conversation, against 0.8 MB of words. */
function briefTurn(turn: CanonicalTurn): CanonicalTurn {
  const labels = [...new Set(turn.tools.map((call) => call.label))];
  const did = labels.length
    ? `[Did: ${labels.slice(0, BRIEF_CALLS).join(' · ')}${labels.length > BRIEF_CALLS ? ` · and ${labels.length - BRIEF_CALLS} more` : ''}]`
    : '';
  const text = [turn.assistant, did].filter(Boolean).join('\n\n');
  return { ...turn, parts: text ? [{ type: 'text', text }] : [], tools: [] };
}

/** The most of the conversation that fits `maxBytes`: first as many turns
 * as fit with only their words and what their calls did (newest first, and
 * the newest always), then, with what room is left, the newest of those get
 * their tool output back. Turns are left out only when even their words do
 * not fit, and the first kept turn then says what was left out and where to
 * read it: ClikCode's record keeps every turn, and its conversation tools
 * read this conversation too. */
export function fitRecord(record: CanonicalRecord, maxBytes: number): { record: CanonicalRecord; omitted: number } {
  const turns = record.turns;
  const brief = turns.map(briefTurn);
  let used = 0;
  let first = turns.length;
  while (first > 0 && (first === turns.length || used + writtenBytes(brief[first - 1]!) <= maxBytes)) {
    used += writtenBytes(brief[first - 1]!);
    first -= 1;
  }
  const kept = brief.slice(first);
  for (let index = kept.length - 1; index >= 0; index -= 1) {
    const full = turns[first + index]!;
    const extra = writtenBytes(full) - writtenBytes(kept[index]!);
    if (used + extra > maxBytes) break;
    used += extra;
    kept[index] = full;
  }
  if (first === 0 && kept.every((turn, index) => turn === turns[index])) return { record, omitted: 0 };
  if (first === 0) return { record: { ...record, turns: kept }, omitted: 0 };
  const note = `[ClikCode: the ${first} earlier turn${first === 1 ? ' is' : 's are'} left out to fit this model. search_conversations with in: "${record.conversationId}" and read_conversation("${record.conversationId}") read them.]\n\n`;
  return { record: { ...record, turns: [{ ...kept[0]!, user: `${note}${kept[0]!.user}` }, ...kept.slice(1)] }, omitted: first };
}

async function written(input: ThreadStartInput): Promise<{ written: NativeThreadWritten; omitted: number } | undefined> {
  const writer = input.writer;
  if (!writer || !input.record.turns.length) return undefined;
  if (keepsNoHistory(input.harness, input.model)) {
    input.onFallback?.(`${input.model} keeps no history: a written ${input.harness.command} thread would not reach it`);
    return undefined;
  }
  try {
    const context = {
      harness: input.harness, workspace: input.workspace, environment: input.environment, model: input.model,
      version: await input.version?.().catch(() => undefined),
    };
    if (!await writer.versionOk(context)) {
      input.onFallback?.(`${input.harness.command} ${context.version ?? '(version unknown)'} is not a build its thread writer was verified against (${writer.testedVersions.join(', ') || 'none'})`);
      return undefined;
    }
    // Which provider ran which turns, said once per switch (the transfer
    // says it in its own preamble). A summary takes its room first.
    const summary = input.record.summary;
    const fitted = fitRecord(input.record, nativeThreadBudget(input.contextWindow) - (summary ? Buffer.byteLength(summary.text, 'utf8') : 0));
    const marked = markProviderBoundaries(fitted.record, input.harness.command, input.displayName);
    const result = await writer.write(summary && !writer.writesSummary ? withSummaryNote(marked, summary) : marked, context);
    if (!result?.nativeId) input.onFallback?.(`${input.harness.command} thread writer declined`);
    return result?.nativeId ? { written: result, omitted: fitted.omitted } : undefined;
  } catch (error) {
    // fail-open-ok: a transfer always works; a writer is an improvement on it.
    input.onFallback?.(`${input.harness.command} thread writer failed: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

/** The summary opening the first kept request, for a writer whose vendor has
 * no compaction of its own to hold it. */
function withSummaryNote(record: CanonicalRecord, summary: NonNullable<CanonicalRecord['summary']>): CanonicalRecord {
  const [first, ...rest] = record.turns;
  if (!first) return record;
  const note = summaryNote(summary);
  return { ...record, summary: undefined, turns: [{ ...first, providerNote: first.providerNote ? `${note}\n\n${first.providerNote}` : note }, ...rest] };
}

export async function startConversationThread(input: ThreadStartInput): Promise<ThreadStart> {
  input = { ...input, record: summarizedRecord(input.record, input.summary) };
  const native = await written(input);
  if (native) return { kind: 'native', ...native, prompt: input.request };
  const budget = transferBudget({
    ...(input.contextWindow ? { contextWindow: input.contextWindow } : {}),
    ...(input.argvLimit ? { argvLimit: input.argvLimit } : {}),
  });
  return {
    kind: 'transfer', budget,
    prompt: transferPrompt(input.record, input.request, {
      maxBytes: budget, interrupted: input.interrupted, ...(input.displayName ? { displayName: input.displayName } : {}),
    }),
  };
}
