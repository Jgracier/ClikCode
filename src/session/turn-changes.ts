/** One record per turn that ran, kept on disk per conversation, so `/undo`
 * acts on the conversation's actual last turn from any window -- the turn ran
 * in a worker or a script, `/undo` runs wherever it is typed.
 *
 * Every turn is recorded where every turn path goes through (the turn
 * journal, turn/turn-journal.ts), a turn with no edits too: otherwise /undo
 * after a turn that changed nothing reached back to an older one while saying
 * "the last turn". Each record names the store that owns its edits, fixed when
 * the turn ran, so a conversation that switched harness undoes each turn with
 * the store that recorded it:
 *  - `agent`: ClikCode's own agent; real pre-image snapshots
 *    (agent/file-checkpoints.ts) taken between `startedAt` and `at`.
 *  - `reported`: a vendor harness; only the diffs its event stream reported
 *    (`changes`). A record without `store` predates this and is `reported`. */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FileDiff } from '../agent/line-diff.js';
import type { HarnessActivityEvent } from '../harness/prompter.js';
import { withFileLock } from './store/locks.js';
import { safeRecordFileName } from './store/paths.js';

export type TurnChangeStore = 'agent' | 'reported';

export interface TurnChangeRecord {
  /** When the turn ended. */
  at: string;
  startedAt?: string;
  /** What the user sent, to name the turn /undo acts on. */
  prompt?: string;
  store?: TurnChangeStore;
  /** Every finished call's reported diffs, in the order made. */
  changes: FileDiff[];
}

/** Turns kept per conversation; /undo walks back through them. */
const KEEP_TURNS = 20;

function logPath(stateDir: string, sessionId: string): string {
  return path.join(stateDir, 'turn-changes', `${safeRecordFileName(sessionId)}.json`);
}

/** The log's own cross-process lock: a turn recording itself and an /undo's
 * read-modify-write never interleave, whichever processes they run in. Not
 * the session or state lock -- neither is needed, and an /undo must not wait
 * on a turn's transcript writes. */
export function withTurnChangesLock<T>(stateDir: string, sessionId: string, run: () => Promise<T>): Promise<T> {
  return withFileLock(`${logPath(stateDir, sessionId)}.lock`, run);
}

export async function readTurnChanges(stateDir: string, sessionId: string): Promise<TurnChangeRecord[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(logPath(stateDir, sessionId), 'utf8')) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is TurnChangeRecord => Boolean(item) && Array.isArray((item as TurnChangeRecord).changes)) : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return [];
    throw error;
  }
}

/** Replace the log. Call inside withTurnChangesLock. */
export async function writeTurnChanges(stateDir: string, sessionId: string, records: readonly TurnChangeRecord[]): Promise<void> {
  const file = logPath(stateDir, sessionId);
  if (!records.length) { await fs.rm(file, { force: true }); return; }
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(records.slice(-KEEP_TURNS)), { mode: 0o600 });
  await fs.rename(temporary, file);
}

/** Add one turn's record, under the log's lock. */
export function appendTurnChanges(stateDir: string, sessionId: string, record: TurnChangeRecord): Promise<void> {
  return withTurnChangesLock(stateDir, sessionId, async () => {
    const records = await readTurnChanges(stateDir, sessionId);
    await writeTurnChanges(stateDir, sessionId, [...records, { ...record, changes: [...record.changes] }]);
  });
}

/** One turn being recorded: fed the turn's activity, written when it ends. */
export class TurnRecorder {
  private readonly collector = new TurnChangeCollector();
  private startedAt: string | undefined;

  constructor(private readonly prompt: string, private readonly store: TurnChangeStore) {}

  /** The turn really started (its journal opened): from here it is a turn
   * of the conversation, and is recorded however it ends. */
  start(): void { this.startedAt ??= new Date().toISOString(); }

  add(event: HarnessActivityEvent): void { this.collector.add(event); }

  /** Write the record; nothing for a turn that never started. */
  async finish(stateDir: string, sessionId: string): Promise<void> {
    if (!this.startedAt) return;
    const startedAt = this.startedAt;
    this.startedAt = undefined;
    await appendTurnChanges(stateDir, sessionId, {
      at: new Date().toISOString(), startedAt, prompt: this.prompt, store: this.store, changes: this.collector.take(),
    });
  }
}

/** Collects one turn's reported changes from its activity events. A call
 * reported finished more than once (an update after the result) counts
 * once, with its last diff: reversing the same edit twice would fail. */
export class TurnChangeCollector {
  private readonly byCall = new Map<string, FileDiff[]>();
  private readonly order: Array<string | FileDiff[]> = [];

  add(event: HarnessActivityEvent): void {
    if (event.kind !== 'tool-done' || !event.diff?.length) return;
    const files = event.diff.filter((file) => file.path);
    if (!files.length) return;
    if (!event.id) { this.order.push(files); return; }
    const key = `${event.parentId ?? ''}\0${event.id}`;
    if (!this.byCall.has(key)) this.order.push(key);
    this.byCall.set(key, files);
  }

  /** The turn's changes, and a fresh start for the next turn. */
  take(): FileDiff[] {
    const out = this.order.flatMap((item) => typeof item === 'string' ? this.byCall.get(item) ?? [] : item);
    this.byCall.clear();
    this.order.length = 0;
    return out;
  }
}

// ---------------------------------------------------------------------------
// /changes: the recorded turns, newest first, numbered as turns ago -- 1 is
// the last turn, the same N `/undo N` undoes back through.
// ---------------------------------------------------------------------------

function promptLine(record: TurnChangeRecord, width = 60): string {
  const prompt = record.prompt?.replace(/\s+/g, ' ').trim() || '(no prompt recorded)';
  return prompt.length > width ? `${prompt.slice(0, width - 1)}…` : prompt;
}

function shownPath(file: string, workspace: string | undefined): string {
  if (!workspace || !path.isAbsolute(file)) return file;
  const relative = path.relative(workspace, file);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : file;
}

/** The record `n` turns ago (1 = the last), or undefined. */
export function turnChangesAgo(records: readonly TurnChangeRecord[], n: number): TurnChangeRecord | undefined {
  return Number.isInteger(n) && n >= 1 ? records[records.length - n] : undefined;
}

/** `/changes`: one line per recorded turn, newest first -- its prompt, the
 * files it edited, and the lines added and removed. */
export function turnChangesList(records: readonly TurnChangeRecord[], workspace?: string): string {
  if (!records.length) return 'No turns recorded yet in this conversation. Each turn\'s file edits are listed here once it has run.';
  const rows = [...records].reverse().map((record, index) => {
    const files = [...new Set(record.changes.flatMap((change) => (change.path ? [shownPath(change.path, workspace)] : [])))];
    const added = record.changes.reduce((sum, change) => sum + change.additions, 0);
    const removed = record.changes.reduce((sum, change) => sum + change.removals, 0);
    const what = files.length
      ? `${files.slice(0, 3).join(', ')}${files.length > 3 ? ` +${files.length - 3} more` : ''} · +${added} -${removed}`
      : 'no edits seen';
    return `  ${String(index + 1).padStart(2)}  ${promptLine(record)}\n      ${what}`;
  });
  return [...rows, '', '/changes N shows that turn\'s diff; /undo N undoes the turns back through it.'].join('\n');
}

/** `/changes N`: that turn's diff, file by file. */
export function turnChangesDiff(record: TurnChangeRecord, n: number, workspace?: string): string {
  const head = `Turn ${n} · ${promptLine(record, 80)}`;
  if (!record.changes.length) return `${head}\n\nNo edits seen: edits made by a shell command, or by a tool that reports no diff, are not recorded.`;
  const files = record.changes.map((change) => {
    const title = `${change.path ? shownPath(change.path, workspace) : '(unnamed file)'}  +${change.additions} -${change.removals}${change.change === 'add' ? ' (new)' : change.change === 'delete' ? ' (deleted)' : ''}`;
    const lines = change.lines.map((line) => line.kind === 'gap' ? '  …' : `${line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' '} ${line.text}`);
    return [title, ...lines, ...(change.omitted ? [`  … ${change.omitted} more lines not recorded`] : [])].join('\n');
  });
  return [head, ...files].join('\n\n');
}
