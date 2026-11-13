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

import { quiet } from '../runtime/lifecycle-log.js';
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
export function keepsNoHistory(
  harness: AiLocalHarnessDefinition, model: string | null, session?: { statelessRoutes?: readonly string[] },
): boolean {
  if (harness.turn?.stateless) return true;
  // What an earlier turn of this chat found out (see rememberStatelessRoute).
  if (session?.statelessRoutes?.includes(statelessRouteKey(harness, model))) return true;
  if (!model) return false;
  // Both catalog declarations name providers that forget the thread: Goose's
  // `statelessProviders`, OpenClaw's `statelessRoute.values` (the route its
  // result reports, which is also the provider prefix of the model).
  const stateless = [...(harness.turn?.statelessProviders ?? []), ...(harness.turn?.statelessRoute?.values ?? [])];
  return stateless.length > 0 && stateless.includes(modelProvider(harness, model) ?? '');
}

const statelessRouteKey = (harness: Pick<AiLocalHarnessDefinition, 'command'>, model: string | null): string => `${harness.command}:${model ?? ''}`;

/** A turn's result said its route keeps no history (catalog
 * `turn.statelessRoute`). OpenClaw answers `anthropic/claude-opus-5` through
 * the `claude` program, and nothing in that name says so: the second turn of
 * such a chat resumed a thread the provider had never seen and answered "this
 * session has no prior messages". */
export function rememberStatelessRoute(
  session: { statelessRoutes?: string[] }, harness: Pick<AiLocalHarnessDefinition, 'command'>, model: string | null,
): void {
  const key = statelessRouteKey(harness, model);
  if (!session.statelessRoutes?.includes(key)) session.statelessRoutes = [...session.statelessRoutes ?? [], key];
}

type ThreadStart =
  /** Resume `written.nativeId`; send `prompt` (the request itself). */
  | { kind: 'native'; written: NativeThreadWritten; prompt: string; omitted: number; summarised: number }
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
  /** The chat, for what its earlier turns learnt about this model's route. */
  session?: { statelessRoutes?: readonly string[] };
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

/** An older turn as its words, with what its calls did told on the USER side
 * of the same turn ("ClikCode note: ... ran: $ npm test; Edit src/a.ts"), and
 * no call records: the detail of old work is what a model needs least, and in
 * a long chat it was nearly all the bytes -- 5 MB of tool output and
 * arguments in one 256-turn conversation, against 0.8 MB of words. It was
 * once a `[Did: ...]` line at the end of the assistant's words; models took it
 * for their own style and wrote it under their answers (recap-line.ts). */
function briefTurn(turn: CanonicalTurn): CanonicalTurn {
  const labels = [...new Set(turn.tools.map((call) => call.label))];
  const ran = labels.length
    ? `\n\n(ClikCode note, not the user's words: answering this, the assistant ran ${labels.slice(0, BRIEF_CALLS).join('; ')}${labels.length > BRIEF_CALLS ? `; and ${labels.length - BRIEF_CALLS} more` : ''}.)`
    : '';
  return { ...turn, user: `${turn.user}${ran}`, parts: turn.assistant ? [{ type: 'text', text: turn.assistant }] : [], tools: [] };
}

function clipMiddle(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (Buffer.byteLength(flat, 'utf8') <= limit) return flat;
  if (limit < 24) return Buffer.from(flat).subarray(0, Math.max(0, limit)).toString('utf8').replace(/�+$/g, '');
  const marker = ' … ';
  const room = Math.max(0, limit - Buffer.byteLength(marker));
  const head = Buffer.from(flat).subarray(0, Math.ceil(room * 0.65)).toString('utf8').replace(/�+$/g, '');
  const tail = Buffer.from(flat).subarray(-Math.floor(room * 0.35)).toString('utf8').replace(/^�+/g, '');
  return `${head}${marker}${tail}`;
}

/** A compact, attributable account of one old turn. Keeping its request,
 * outcome and work done means a long handoff loses detail gradually instead
 * of dropping whole chunks of history before the current request. */
function compactTurn(turn: CanonicalTurn, maxBytes: number, recordPath?: string): CanonicalTurn {
  const recordNote = turn.index === 0 && recordPath ? ` Full transcript: ${recordPath}.` : '';
  const lead = `[ClikCode history, turn ${turn.index + 1}] Request:${recordNote} `;
  const room = Math.max(0, maxBytes - Buffer.byteLength(lead, 'utf8') - 44);
  const requestLimit = Math.floor(room * 0.46);
  const summaryLimit = Math.floor(room * 0.34);
  const actionsLimit = Math.max(0, room - requestLimit - summaryLimit);
  const request = clipMiddle(turn.user || '(continued work)', requestLimit);
  const prose = turn.assistant.replace(/```[\s\S]*?```/g, ' ').replace(/\s+/g, ' ').trim();
  const sentences = prose.split(/(?<=[.!?])\s+/).filter(Boolean);
  const outcome = clipMiddle(sentences.length > 1 ? `${sentences[0]} … ${sentences.at(-1)}` : prose, summaryLimit);
  const actionText = [...new Set([
    ...turn.tools.map((tool) => `${tool.label}${tool.status === 'failed' ? ' (failed)' : ''}`),
    ...turn.touchedFiles.map((file) => `changed ${file}`),
  ])].join('; ');
  const actions = actionText ? clipMiddle(actionText, actionsLimit) : '';
  const user = `${lead}${request}${actions ? `\nWork: ${actions}` : ''}`;
  const assistant = outcome || (turn.interrupted ? '[The turn was interrupted before a response.]' : '');
  return {
    ...turn, user, assistant,
    parts: assistant ? [{ type: 'text', text: assistant }] : [],
    tools: [], touchedFiles: turn.touchedFiles.slice(0, 8),
  };
}

function writtenRecordBytes(turns: readonly CanonicalTurn[]): number {
  return turns.reduce((sum, turn) => sum + writtenBytes(turn), 0);
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
export function fitRecord(record: CanonicalRecord, maxBytes: number, options: { recordPath?: string } = {}): { record: CanonicalRecord; omitted: number; summarised: number } {
  const turns = record.turns;
  const brief = turns.map(briefTurn);
  let totalBytes = writtenRecordBytes(brief);
  let compacted = 0;
  const compactedIndices = new Set<number>();
  // Compact oldest turns first, preserving the most recent full exchanges.
  // A previous fitter simply omitted these turns; long-running conversations
  // consequently reached a new provider with only an outline of old requests.
  if (totalBytes > maxBytes && turns.length > 1) {
    const perTurn = Math.floor((maxBytes - (options.recordPath ? Buffer.byteLength(options.recordPath, 'utf8') + 48 : 0)) / turns.length);
    if (perTurn >= 192) {
      for (let index = 0; index < turns.length - 1 && totalBytes > maxBytes; index += 1) {
        const compact = compactTurn(turns[index]!, perTurn, options.recordPath);
        const before = writtenBytes(brief[index]!);
        const after = writtenBytes(compact);
        if (after < before) {
          brief[index] = compact;
          totalBytes += after - before;
          compacted += 1;
          compactedIndices.add(index);
        }
      }
    }
  }
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
  /** Kept turns that went in as their words and a line of what their calls did. */
  const summarisedIn = (): number => kept.filter((turn, index) =>
    !compactedIndices.has(first + index) && turn !== turns[first + index] && turns[first + index]!.tools.length > 0,
  ).length;
  if (first === 0 && compacted === 0 && kept.every((turn, index) => turn === turns[index])) return { record, omitted: 0, summarised: 0 };
  if (first === 0) return { record: { ...record, turns: kept }, omitted: 0, summarised: compacted + summarisedIn() };
  // Something is left out, so the note that says what comes out of the same
  // budget as the turns: fitted again with its room held back, never on top.
  const outlineRoom = Math.floor(maxBytes * OUTLINE_SHARE);
  ({ first, kept } = select(Math.max(0, maxBytes - outlineRoom - NOTE_FIXED_BYTES)));
  const summarised = compacted + summarisedIn();
  const outline = requestsOutline(turns.slice(0, first), outlineRoom);
  const note = `[ClikCode: the ${first} earlier turn${first === 1 ? ' is' : 's are'} left out to fit this model.${options.recordPath ? ` ${fullRecordNote(options.recordPath)}` : ''}${outline ? `\nWhat was asked in them, oldest first:\n${outline}` : ''}]\n\n`;
  return { record: { ...record, turns: [{ ...kept[0]!, user: `${note}${kept[0]!.user}` }, ...kept.slice(1)] }, omitted: first, summarised };
}

async function written(input: ThreadStartInput): Promise<{ written: NativeThreadWritten; omitted: number; summarised: number } | undefined> {
  const writer = input.writer;
  if (!writer || !input.record.turns.length) return undefined;
  if (keepsNoHistory(input.harness, input.model, input.session)) {
    input.onFallback?.(`${input.model} keeps no history: a written ${input.harness.command} thread would not reach it`);
    return undefined;
  }
  try {
    const context = {
      harness: input.harness, workspace: input.workspace, environment: input.environment, model: input.model,
      version: await input.version?.().catch(quiet('turn/thread-start')),
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
    return result?.nativeId ? { written: result, omitted: fitted.omitted, summarised: fitted.summarised } : undefined;
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

/** What a person is told when a conversation is taken up by a provider and anything of it did not
 * go in whole: how many turns arrived, and how. Undefined when all of it went in as it was. */
export function carriedLine(turns: number, start: ThreadStart, provider: string, recordPath?: string): string | undefined {
  if (!turns) return undefined;
  const where = recordPath ? ` The whole conversation is saved at ${recordPath}.` : '';
  if (start.kind === 'transfer') {
    return `Carried ${turns} of ${turns} turns to ${provider}, ${turns} summarised: ${provider} could not be given the conversation as its own thread, so it was retold.${where}`;
  }
  if (!start.omitted && !start.summarised) return undefined;
  const parts = [`Carried ${turns - start.omitted} of ${turns} turns to ${provider}`];
  if (start.summarised) parts.push(`${start.summarised} summarised`);
  const left = start.omitted ? `; the ${start.omitted} earliest ${start.omitted === 1 ? 'is' : 'are'} left out to fit its window` : '';
  return `${parts.join(', ')}${left}.${where}`;
}
