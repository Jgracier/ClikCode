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
import { type CanonicalRecord, type CanonicalTurn } from '../session/canonical.js';
import { fullRecordNote } from '../session/full-record.js';
import type { NativeSessionEnvironment, NativeThreadWriter, NativeThreadWritten } from '../session/discovery/stores.js';
import { modelProvider } from '../runtime/lazy-bridge.js';
import { BYTES_PER_TOKEN, transferBudget, transferPrompt } from './transfer.js';

/** The model runs behind a provider that keeps no history between one-shot
 * turns (catalog `turn.statelessProviders`: Goose's `claude-code`). Its
 * thread is forgotten after every turn, and no thread is written for it:
 * only the transfer reaches the model. */
export function keepsNoHistory(harness: AiLocalHarnessDefinition, model: string | null): boolean {
  if (harness.turn?.stateless) return true;
  if (!model) return false;
  // Both catalog declarations name providers that forget the thread: Goose's
  // `statelessProviders`, OpenClaw's `statelessRoute.values` (the route its
  // result reports, which is also the provider prefix of the model).
  const stateless = [...(harness.turn?.statelessProviders ?? []), ...(harness.turn?.statelessRoute?.values ?? [])];
  return stateless.length > 0 && stateless.includes(modelProvider(harness, model) ?? '');
}

type ThreadStart =
  /** Resume `written.nativeId`; send `prompt` (the request itself). */
  | { kind: 'native'; written: NativeThreadWritten; prompt: string; omitted: number }
  /** A fresh thread; send `prompt` (the transfer, ending in the request). */
  | { kind: 'transfer'; prompt: string; budget: number };

export interface ThreadStartInput {
  record: CanonicalRecord;
  /** What to answer now: the user's request as the turn would send it, or
   * the interrupted turn's own request, sent again. */
  request: string;
  /** The record's newest turn was cut off; `request` is that turn's request again. */
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
  /** Where the whole conversation is saved as a file (session/full-record.ts):
   * named in whatever a handoff leaves out, so nothing is out of reach. A
   * summary a provider made is never put in place of turns: it is the
   * provider's own, and a handoff carries the conversation itself. */
  recordPath?: string;
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
const NATIVE_WINDOW_SHARE = 0.5;
/** The budget when nothing has reported the model's window. */
const NATIVE_DEFAULT_BYTES = 400 * 1024;

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

/** Share of a fitted thread's budget the outline of left-out requests may take. */
const OUTLINE_SHARE = 0.1;
/** What the note's own sentences and the file's path take, apart from the outline. */
const NOTE_FIXED_BYTES = 600;

/** What was asked in turns that did not fit, one clipped line each, oldest
 * first: the arc of the conversation when its words cannot all come. Every
 * request is listed, each clipped harder rather than any dropped, until even
 * the shortest line cannot fit; then the oldest are counted instead. */
function requestsOutline(turns: readonly CanonicalTurn[], maxBytes: number): string {
  const asked = turns.filter((turn) => turn.user.trim());
  if (!asked.length || maxBytes < 256) return '';
  const per = Math.max(40, Math.min(240, Math.floor(maxBytes / asked.length) - 12));
  const lines = asked.map((turn) => {
    const text = turn.user.replace(/\s+/g, ' ').trim();
    return `${turn.index + 1}. ${text.length > per ? `${text.slice(0, per - 1)}…` : text}`;
  });
  let used = lines.reduce((sum, line) => sum + Buffer.byteLength(line, 'utf8') + 1, 0);
  let dropped = 0;
  while (used > maxBytes && dropped < lines.length - 1) { used -= Buffer.byteLength(lines[dropped]!, 'utf8') + 1; dropped += 1; }
  return `${dropped ? `(${dropped} earlier request${dropped === 1 ? '' : 's'} not listed)\n` : ''}${lines.slice(dropped).join('\n')}`;
}

/** The most of the conversation that fits `maxBytes`: first as many turns
 * as fit with only their words and what their calls did (newest first, and
 * the newest always), then, with what room is left, the newest of those get
 * their tool output back. Turns are left out only when even their words do
 * not fit, and the first kept turn then says what was left out: a line for
 * each request, and the file that holds the whole conversation. ClikCode's
 * record keeps every turn; nothing is deleted by being left out here. */
export function fitRecord(record: CanonicalRecord, maxBytes: number, options: { recordPath?: string } = {}): { record: CanonicalRecord; omitted: number } {
  const turns = record.turns;
  const brief = turns.map(briefTurn);
  /** The newest turns that fit `room`: how many of the oldest are out, and the rest. */
  const select = (room: number): { first: number; kept: CanonicalTurn[] } => {
    let used = 0;
    let first = turns.length;
    while (first > 0 && (first === turns.length || used + writtenBytes(brief[first - 1]!) <= room)) {
      used += writtenBytes(brief[first - 1]!);
      first -= 1;
    }
    const kept = brief.slice(first);
    for (let index = kept.length - 1; index >= 0; index -= 1) {
      const full = turns[first + index]!;
      const extra = writtenBytes(full) - writtenBytes(kept[index]!);
      if (used + extra > room) break;
      used += extra;
      kept[index] = full;
    }
    return { first, kept };
  };
  let { first, kept } = select(maxBytes);
  if (first === 0 && kept.every((turn, index) => turn === turns[index])) return { record, omitted: 0 };
  if (first === 0) return { record: { ...record, turns: kept }, omitted: 0 };
  // Something is left out, so the note that says what comes out of the same
  // budget as the turns: fitted again with its room held back, never on top.
  const outlineRoom = Math.floor(maxBytes * OUTLINE_SHARE);
  ({ first, kept } = select(Math.max(0, maxBytes - outlineRoom - NOTE_FIXED_BYTES)));
  const outline = requestsOutline(turns.slice(0, first), outlineRoom);
  const note = `[ClikCode: the ${first} earlier turn${first === 1 ? ' is' : 's are'} left out to fit this model.${options.recordPath ? ` ${fullRecordNote(options.recordPath)}` : ''}${outline ? `\nWhat was asked in them, oldest first:\n${outline}` : ''}]\n\n`;
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
    // No note of which provider ran which turns is written into the vendor's
    // thread: it is the vendor's own. Only what was left out is said.
    const fitted = fitRecord(input.record, nativeThreadBudget(input.contextWindow), input.recordPath ? { recordPath: input.recordPath } : {});
    const result = await writer.write(fitted.record, context);
    if (!result?.nativeId) input.onFallback?.(`${input.harness.command} thread writer declined`);
    return result?.nativeId ? { written: result, omitted: fitted.omitted } : undefined;
  } catch (error) {
    // fail-open-ok: a transfer always works; a writer is an improvement on it.
    input.onFallback?.(`${input.harness.command} thread writer failed: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

export async function startConversationThread(input: ThreadStartInput): Promise<ThreadStart> {
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
      ...(input.recordPath ? { recordPath: input.recordPath } : {}),
    }),
  };
}
