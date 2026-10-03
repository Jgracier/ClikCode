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
