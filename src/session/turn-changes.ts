/** The file changes each turn's tool calls REPORTED, kept on disk per
 * conversation, so `/undo` can reverse a vendor harness's edits from any
 * window -- the turn ran in the worker, `/undo` runs wherever it is typed.
 *
 * ClikCode's own agent has real pre-image snapshots (agent/file-checkpoints.ts)
 * and /undo uses those for it; this log is what there is for a vendor, whose
 * edits ClikCode only sees as the diffs in its event stream. */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FileDiff } from '../agent/line-diff.js';
import type { HarnessActivityEvent } from '../harness/prompter.js';
import { safeRecordFileName } from './store/paths.js';

export interface TurnChangeRecord {
  at: string;
  /** Every finished call's diffs, in the order made. */
  changes: FileDiff[];
}

/** Turns kept per conversation; /undo walks back through them. */
const KEEP_TURNS = 20;

function logPath(stateDir: string, sessionId: string): string {
  return path.join(stateDir, 'turn-changes', `${safeRecordFileName(sessionId)}.json`);
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

export async function writeTurnChanges(stateDir: string, sessionId: string, records: readonly TurnChangeRecord[]): Promise<void> {
  const file = logPath(stateDir, sessionId);
  if (!records.length) { await fs.rm(file, { force: true }); return; }
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(records.slice(-KEEP_TURNS)), { mode: 0o600 });
  await fs.rename(temporary, file);
}

/** One read-modify-write at a time in this process: two turns ending close
 * together must not drop one another's record. */
let appending: Promise<unknown> = Promise.resolve();

export function appendTurnChanges(stateDir: string, sessionId: string, changes: readonly FileDiff[]): Promise<void> {
  if (!changes.length) return Promise.resolve();
  const record = { at: new Date().toISOString(), changes: [...changes] };
  const next = appending.then(async () => {
    const records = await readTurnChanges(stateDir, sessionId);
    await writeTurnChanges(stateDir, sessionId, [...records, record]);
  });
  appending = next.catch(() => undefined);
  return next;
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
