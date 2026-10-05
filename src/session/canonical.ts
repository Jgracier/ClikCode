/** The conversation as ClikCode owns it, independent of any provider.
 *
 * A ClikCode conversation is one session whose provider can change in place
 * (commands/ai/conversations.ts moveToProvider). The canonical record is its
 * history read back as ONE list of turns, in order, with one numbering, each
 * turn knowing which provider and model produced it -- stamped on its
 * messages (MessageOrigin); an unstamped one is the session's current
 * provider's.
 *
 * It is what a provider taking the conversation up is given -- written as its
 * own native thread where a writer for it exists (discovery/stores.ts
 * NativeThreadWriter), otherwise retold as a transfer prompt
 * (turn/transfer.ts). Both read only this, so the two can never disagree about
 * what the conversation was.
 *
 * Built from what is stored, never from a vendor's files: those belong to the
 * vendor, and the session's messages already hold everything its native
 * threads said that ClikCode saw (synchronizeNativeTranscript pulls in what
 * was said in the vendor's own CLI, when the conversation is opened). */

import type { FileDiff } from '../agent/line-diff.js';
import { asFileDiffs } from '../agent/line-diff.js';
import type { HarnessActivityEvent, ToolCategory } from '../harness/prompter.js';
import type { HarnessPlanEntry } from '../harness/events/turn-observer.js';
import type { HarnessSession, TranscriptMessage } from './model.js';
import { messageOrigin, sessionTranscriptMessages, touchedFilesFromActivity, type PendingTurnWithHints } from '../turn/checkpoint.js';
import { readTurnActivities } from '../turn/turn-activities.js';
import { providerBoundaryNote } from '../turn/failover-prompt.js';
import { conversationIdFor } from './options.js';

export const CANONICAL_RECORD_VERSION = 1;

export type CanonicalToolStatus = 'done' | 'failed' | 'unfinished';

/** One tool call, as recorded. */
export interface CanonicalToolCall {
  /** The vendor's own call id, when it sent one. */
  id?: string;
  /** ClikCode's classifier's verdict (harness/protocol/tools.ts); absent when
   * the evidence did not settle it. A writer maps this to its own tool. */
  category?: ToolCategory;
  /** The vendor's tool name when it was recorded (`Bash`, `shell`,
   * `apply_patch`, `mcp__github__create_issue`), else the verb of the row
   * (`Read`, `Edit`, `shell` for a `$` row). */
  name: string;
  /** The arguments as the vendor sent them, bounded (CALL_INPUT_MAX_CHARS).
   * Absent on calls recorded before inputs were kept. */
  input?: Record<string, unknown>;
  /** The row ClikCode drew: `Edit src/a.ts`, `$ npm test`. */
  label: string;
  /** What the call acted on, from the row: a path, the first line of a
   * command, a pattern, a URL. */
  target?: string;
  status: CanonicalToolStatus;
  /** Bounded output (turn/turn-activities.ts MAX_OUTPUT_LINES). `outputTail`:
   * these are its LAST lines; `outputOmitted` counts what was left out. */
  output?: string[];
  outputOmitted?: number;
  outputTail?: boolean;
  exitCode?: number;
  /** The change, where the vendor's stream carried it (bounded). */
  diff?: FileDiff[];
  /** Files this call changed. */
  files: string[];
  /** A sub-agent ran this call. */
  agent?: boolean;
}

/** An assistant turn in the order it happened: text and calls interleaved. */
export type CanonicalPart = { type: 'text'; text: string } | { type: 'tool'; call: CanonicalToolCall };

/** Which session, harness and model produced a turn. */
export interface CanonicalOrigin {
  sessionId: string;
  /** Native harness command (`claude`, `codex`); absent on ClikCode's own
   * agent routes. */
  harness?: string;
  route: HarnessSession['route'];
  provider: string | null;
  model: string | null;
}

export interface CanonicalTurn {
  /** 0-based position in the conversation. */
  index: number;
  /** The request as typed. '' for answer text with no request before it (a
   * continuation of an interrupted turn, or a transcript that began so). */
  user: string;
  /** Files attached to the request, by path. */
  attachments: string[];
  /** Text and calls, in order. */
  parts: CanonicalPart[];
  /** The text parts, joined. */
  assistant: string;
  /** The calls, in order. */
  tools: CanonicalToolCall[];
  /** Files the turn changed, first-touched first. */
  touchedFiles: string[];
  /** The newest turn of a conversation whose answer was cut off (a turn
   * still in its journal). Whoever takes it over continues it. */
  interrupted: boolean;
  origin: CanonicalOrigin;
  /** Set only on a record about to be written as a native thread, at a
   * provider boundary (markProviderBoundaries): the line a writer puts before
   * this turn's request (withProviderNote). */
  providerNote?: string;
}

export interface CanonicalRecord {
  version: typeof CANONICAL_RECORD_VERSION;
  conversationId: string;
  /** The session the record was read from. */
  sessionId: string;
  workspace: string;
  turns: CanonicalTurn[];
  /** Every file changed anywhere in the conversation, first-touched first. */
  touchedFiles: string[];
  /** Every file attached anywhere in the conversation, in order, once each. */
  attachments: string[];
  /** Files attached for the request about to be sent (not yet a turn). */
  pendingAttachments: string[];
  /** The plan the provider last published, if any. */
  plan?: HarnessPlanEntry[];
  /** Plan entries not completed. */
  openTodos: HarnessPlanEntry[];
}

/** A row's verb and target, from formatToolRow's shape (`Verb target`,
 * `$ command`, `server › tool args`, or a legacy `name(detail)`). */
function rowParts(label: string): { name: string; target?: string } {
  const text = label.trim();
  if (text.startsWith('$ ')) return { name: 'shell', target: text.slice(2) };
  const mcp = /^(\S+) › (\S+)(?: (.*))?$/.exec(text);
  if (mcp) return { name: `mcp__${mcp[1]}__${mcp[2]}`, ...(mcp[3] ? { target: mcp[3] } : {}) };
  const row = /^(Web search|Read|List|Grep|Glob|Search|Fetch|Edit|Write|Agent) ([\s\S]+)$/.exec(text);
  if (row) return { name: row[1]!, target: row[2]! };
  const call = /^([\w.:-]+)\(([\s\S]*)\)$/.exec(text);
  if (call) return { name: call[1]!, ...(call[2]!.trim() ? { target: call[2]!.trim() } : {}) };
  const [first, ...rest] = text.split(' ');
  return { name: first || 'tool', ...(rest.length ? { target: rest.join(' ') } : {}) };
}

function canonicalCall(event: HarnessActivityEvent): CanonicalToolCall {
  const row = rowParts(event.label);
  const diff = asFileDiffs(event.diff);
  const files = unique([
    ...(diff ?? []).flatMap((file) => (file.path ? [file.path] : [])),
    ...touchedFilesFromActivity(event),
  ]);
  return {
    ...(event.id ? { id: event.id } : {}),
    ...(event.category ? { category: event.category } : {}),
    name: event.call?.name ?? row.name,
    ...(event.call?.input ? { input: event.call.input } : {}),
    label: event.label,
    ...(row.target ? { target: row.target } : {}),
    status: event.kind === 'tool-error' ? 'failed' : event.kind === 'tool-start' ? 'unfinished' : 'done',
    ...(event.output?.length ? { output: [...event.output] } : {}),
    ...(event.outputOmitted ? { outputOmitted: event.outputOmitted } : {}),
    ...(event.outputTail ? { outputTail: true } : {}),
    ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
    ...(diff?.length ? { diff } : {}),
    files,
    ...(event.agent ? { agent: true } : {}),
  };
}

function unique(items: Iterable<string>): string[] {
  return [...new Set([...items].map((item) => item.trim()).filter(Boolean))];
}

/** An assistant message's text and calls, in order: each call sits at the
 * offset into the text where it began. */
function assistantParts(message: TranscriptMessage): CanonicalPart[] {
  const activities = readTurnActivities(message.activities, message.content.length);
  const parts: CanonicalPart[] = [];
  let at = 0;
  const text = (end: number): void => {
    const slice = message.content.slice(at, end);
    if (slice.trim()) parts.push({ type: 'text', text: slice });
    at = Math.max(at, end);
  };
  for (const activity of [...activities].sort((left, right) => left.responseOffset - right.responseOffset)) {
    text(Math.min(message.content.length, Math.max(0, activity.responseOffset)));
    parts.push({ type: 'tool', call: canonicalCall(activity.event) });
  }
  text(message.content.length);
  return parts;
}

function originOf(session: HarnessSession): CanonicalOrigin {
  return { sessionId: session.id, ...messageOrigin(session) };
}

/** The canonical record of `session`'s conversation. A turn still in the
 * session's journal is the last turn, marked interrupted, with the files it
 * had started changing. */
export function canonicalRecord(session: HarnessSession): CanonicalRecord {
  const messages = sessionTranscriptMessages(session);
  const own = originOf(session);
  const turns: CanonicalTurn[] = [];
  let current: CanonicalTurn | undefined;
  const open = (user: string, attachments: readonly string[], origin: CanonicalOrigin): CanonicalTurn => {
    current = {
      index: turns.length, user, attachments: [...attachments], parts: [], assistant: '', tools: [], touchedFiles: [],
      interrupted: false, origin,
    };
    turns.push(current);
    return current;
  };
  messages.forEach((message) => {
    const origin = message.origin ? { sessionId: session.id, ...message.origin } : own;
    if (message.role === 'user') {
      open(message.content, message.attachments ?? [], origin);
      return;
    }
    const turn = current ?? open('', [], origin);
    // The answer's producer, not the request's: a request typed on one
    // provider and answered on the next (the first turn after a switch) is the
    // second provider's turn.
    turn.origin = origin;
    turn.parts.push(...assistantParts(message));
  });
  for (const turn of turns) {
    turn.assistant = turn.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('').trim();
    turn.tools = turn.parts.flatMap((part) => (part.type === 'tool' ? [part.call] : []));
    turn.touchedFiles = unique(turn.tools.flatMap((call) => call.files));
  }
  const pending = session.pendingTurn as PendingTurnWithHints | undefined;
  const last = turns.at(-1);
  if (pending && last) {
    last.interrupted = true;
    last.touchedFiles = unique([...last.touchedFiles, ...(pending.touchedFiles ?? [])]);
  }
  const plan = session.plan?.entries?.length ? session.plan.entries.map((entry) => ({ ...entry })) : undefined;
  return {
    version: CANONICAL_RECORD_VERSION,
    conversationId: conversationIdFor(session),
    sessionId: session.id,
    workspace: session.workspace ?? process.cwd(),
    turns,
    touchedFiles: unique(turns.flatMap((turn) => turn.touchedFiles)),
    attachments: unique(turns.flatMap((turn) => turn.attachments)),
    pendingAttachments: [...(session.attachments ?? [])],
    ...(plan ? { plan } : {}),
    openTodos: (plan ?? []).filter((entry) => !/^(completed|done|complete|finished|cancelled|canceled)$/i.test(entry.status?.trim() ?? '')),
  };
}

/** Who produced a turn, as a note names it: `Kilo Code CLI
 * (kilo/cohere/north-mini-code:free)`. */
export function originLabel(origin: CanonicalOrigin, displayName?: (harness: string) => string | undefined): string {
  const name = origin.harness ? displayName?.(origin.harness) ?? origin.harness : origin.route ?? origin.provider ?? 'ClikCode';
  return `${name}${origin.model ? ` (${origin.model})` : ''}`;
}

function originKey(origin: CanonicalOrigin): string {
  return origin.harness ?? `${origin.route}:${origin.provider ?? ''}`;
}

/** `record` with a providerNote on every turn where the provider changes:
 * the first turn when it ran somewhere other than `receiving` (the harness
 * command taking the thread up), and every later turn whose provider differs
 * from the one before it -- including the switch back to `receiving`. A
 * native thread reads as the receiving model's own history, so without these
 * it took another provider's turns for its own and denied the other existed;
 * one line per switch keeps the rest of the history its own. */
export function markProviderBoundaries(
  record: CanonicalRecord, receiving: string, displayName?: (harness: string) => string | undefined,
): CanonicalRecord {
  let previous = receiving;
  const turns = record.turns.map((turn) => {
    const key = originKey(turn.origin);
    const boundary = key !== previous;
    previous = key;
    const { providerNote: _stale, ...rest } = turn;
    return boundary ? { ...rest, providerNote: providerBoundaryNote(originLabel(turn.origin, displayName)) } : rest;
  });
  return { ...record, turns };
}

/** A turn's request as a writer puts it in the user message: the provider
 * note, if the turn has one, on its own line first. */
export function withProviderNote(turn: Pick<CanonicalTurn, 'providerNote'>, request: string): string {
  if (!turn.providerNote) return request;
  return request.trim() ? `${turn.providerNote}\n\n${request}` : turn.providerNote;
}
