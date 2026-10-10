/** Put back the files the conversation's last turn changed (/redo's rewind).
 *
 * Two sources, by who made the edits:
 *  - ClikCode's own agent snapshots every file before its tools write it
 *    (agent/file-checkpoints.ts), on disk, so the worker that ran the turn
 *    and the window that runs /redo need not be the same process.
 *  - A vendor harness's edits are known only as the diffs its event stream
 *    reported (session/turn-changes.ts); they are reversed hunk by hunk with
 *    the same code VS Code's "Undo all" uses (agent/diff-unwind.ts).
 *
 * Either way a file is only written when it is still as the turn left it:
 * one changed since is named and left alone, never overwritten; and only
 * inside the conversation's workspace, symlinks resolved.
 *
 * It acts on the conversation's actual last turn (every turn is recorded,
 * session/turn-changes.ts), with the store that turn recorded its edits in,
 * names that turn by its prompt, and says so when it made no edits rather
 * than reaching back. Repeated, it walks back one turn at a time. It is
 * refused while a turn is running in the conversation. */

import fs from 'node:fs/promises';
import path from 'node:path';
import { FileCheckpointStore } from '../agent/file-checkpoints.js';
import { turnChanges, unwindChanges } from '../agent/diff-unwind.js';
import { realpathNearest } from '../agent/security.js';
import type { HarnessSession } from './model.js';
import { loadSessionFile } from './store/records.js';
import { conversationHolder } from '../worker/registry.js';
import { readTurnChanges, withTurnChangesLock, writeTurnChanges, type TurnChangeRecord } from './turn-changes.js';

export interface TurnUndo {
  /** Files put back as they were before the turn. */
  restored: string[];
  /** Files the turn created, removed again. */
  removed: string[];
  /** Files left alone, and why. */
  conflicts: Array<{ path: string; reason: string }>;
  text: string;
}

const SHELL_CAVEAT = 'Tracked: edits made through file-editing tools, and (ClikCode\'s agent) files a shell command changed in the git repository. Anything else a shell command changed (ignored or generated files, installs, git operations) is not undone.';
const OUTSIDE_WORKSPACE = 'outside this conversation\'s workspace; not touched';

function shown(file: string, workspace: string): string {
  const relative = path.relative(workspace, file);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : file;
}

/** The turn as the user knows it: what they sent, on one short line. */
function turnName(record: TurnChangeRecord | undefined): string {
  const prompt = record?.prompt?.replace(/\s+/g, ' ').trim();
  if (!prompt) return 'the last turn';
  return `the turn "${prompt.length > 60 ? `${prompt.slice(0, 59)}\u2026` : prompt}"`;
}

function describe(result: Omit<TurnUndo, 'text'>, workspace: string, name: string): string {
  const done = result.restored.length + result.removed.length;
  const lines = [done
    ? `Undid ${name}: its changes to ${done} file${done === 1 ? '' : 's'}.`
    : `Could not undo ${name}: no file it changed could be put back.`];
  for (const file of result.restored) lines.push(`  restored  ${shown(file, workspace)}`);
  for (const file of result.removed) lines.push(`  removed   ${shown(file, workspace)} (the turn created it)`);
  for (const item of result.conflicts) lines.push(`  kept      ${shown(item.path, workspace)}: ${item.reason}`);
  if (result.conflicts.length) lines.push('', 'Files kept were not touched: revert them with git.');
  lines.push('', SHELL_CAVEAT);
  return lines.join('\n');
}

/** Inside the workspace, as the write would land now (symlinks resolved). */
function inside(target: string, workspace: string): boolean {
  const relative = path.relative(realpathNearest(path.resolve(workspace)), realpathNearest(path.resolve(target)));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** ClikCode's own agent: restore the pre-image snapshots its tools took
 * during that turn. True when nothing of the turn is left to undo. */
async function undoAgentTurn(stateDir: string, sessionId: string, record: TurnChangeRecord, workspace: string, result: Omit<TurnUndo, 'text'>): Promise<boolean | undefined> {
  const store = new FileCheckpointStore(stateDir);
  const from = record.startedAt ?? record.at;
  const turnIds = (await store.listTurns(sessionId))
    .filter((turn) => turn.createdAt >= from && turn.createdAt <= record.at)
    .map((turn) => turn.turnId);
  if (!turnIds.length) return undefined;
  const outcome = await store.undo(sessionId, 1, { turnIds, roots: [workspace] });
  result.restored.push(...outcome.restored);
  result.removed.push(...outcome.deleted);
  result.conflicts.push(...outcome.failed.map((item) => ({ path: item.path, reason: /outside the allowed roots/.test(item.reason) ? OUTSIDE_WORKSPACE : item.reason })));
  const left = new Set((await store.listTurns(sessionId)).map((turn) => turn.turnId));
  return !turnIds.some((id) => left.has(id));
}

/** Why a reported change was not reversed, and whether trying again later
 * could ever succeed. */
function conflictReason(current: string | undefined, changes: ReadonlyArray<{ change?: string; omitted?: number; priorUnknown?: boolean }>): { reason: string; retry: boolean } {
  if (changes.some((change) => change.priorUnknown)) return { reason: 'the harness reported only what it wrote here, not what the file held before, so it cannot be put back', retry: false };
  if (changes.some((change) => change.omitted)) return { reason: 'the harness reported this change only in part, so it cannot be reversed exactly', retry: false };
  if (current === undefined) {
    return changes.some((change) => change.change === 'delete')
      ? { reason: 'the turn deleted it and the harness did not report its content', retry: false }
      : { reason: 'it no longer exists', retry: true };
  }
  return { reason: 'changed since that turn; not overwritten', retry: true };
}

/** A vendor harness: reverse the diffs its calls reported, newest first.
 * Returns what is left to retry. */
async function undoReportedTurn(record: TurnChangeRecord, workspace: string, result: Omit<TurnUndo, 'text'>): Promise<TurnChangeRecord['changes']> {
  const kept = [];
  for (const [file, changes] of turnChanges([{ kind: 'tool-done', diff: record.changes }])) {
    const target = path.isAbsolute(file) ? file : path.resolve(workspace, file);
    if (!inside(target, workspace)) {
      result.conflicts.push({ path: target, reason: OUTSIDE_WORKSPACE });
      continue;
    }
    const current = await fs.readFile(target, 'utf8').catch(() => undefined);
    const unwound = unwindChanges(current, changes);
    if (!unwound.whole) {
      const why = conflictReason(current, changes);
      result.conflicts.push({ path: target, reason: why.reason });
      if (why.retry) kept.push(...changes);
      continue;
    }
    try {
      if (unwound.created) { await fs.rm(target, { force: true }); result.removed.push(target); }
      else { await fs.writeFile(target, unwound.before); result.restored.push(target); }
    } catch (error) {
      result.conflicts.push({ path: target, reason: error instanceof Error ? error.message : String(error) });
      kept.push(...changes);
    }
  }
  return kept;
}

/** A turn is running in the conversation now: a scripted turn holds it, or
 * the worker holding it has a turn in flight (its journal, read fresh). */
export async function turnIsRunning(sessionId: string): Promise<boolean> {
  const holder = await conversationHolder(sessionId).catch(() => undefined);
  if (!holder) return false;
  if (holder.kind === 'turn') return true;
  return Boolean((await loadSessionFile(sessionId).catch(() => undefined))?.pendingTurn);
}

export async function undoLastTurn(
  session: HarnessSession,
  options: { stateDir: string; who: string; turnIsRunning?: (sessionId: string) => Promise<boolean> },
): Promise<TurnUndo> {
  const workspace = session.workspace ?? process.cwd();
  const result: Omit<TurnUndo, 'text'> = { restored: [], removed: [], conflicts: [] };
  if (await (options.turnIsRunning ?? turnIsRunning)(session.id)) {
    return { ...result, text: 'Not undone: a turn is running in this conversation. Its edits are still being made -- wait for it to finish, or stop it first.' };
  }
  return withTurnChangesLock(options.stateDir, session.id, async () => {
    const records = await readTurnChanges(options.stateDir, session.id);
    const last = records.at(-1);
    if (!last) {
      return { ...result, text: `Nothing to undo: no turn in this conversation has recorded file edits. ClikCode reverses the edits it saw a turn make through file-editing tools; edits made any other way (a shell command, a tool that reports no diff) are not seen -- use /diff and git for those.` };
    }
    const earlier = records.slice(0, -1);
    const name = turnName(last);
    // Each turn is undone by the store that recorded it: the route it ran
    // on, not the one the conversation is on now.
    let kept: TurnChangeRecord | undefined;
    let saw: boolean;
    if (last.store === 'agent') {
      const finished = await undoAgentTurn(options.stateDir, session.id, last, workspace, result);
      saw = finished !== undefined;
      if (finished === false) kept = last;
    } else {
      saw = last.changes.length > 0;
      const left = saw ? await undoReportedTurn(last, workspace, result) : [];
      if (left.length) kept = { ...last, changes: left };
    }
    // Done (or never possible) leaves the log, so a repeated /undo walks back
    // to the turn before; what can still be undone stays for a retry.
    await writeTurnChanges(options.stateDir, session.id, kept ? [...earlier, kept] : earlier);
    if (!saw) {
      const before = earlier.at(-1);
      const who = last.store === 'agent' ? 'ClikCode\'s agent' : options.who;
      return { ...result, text: [
        `Nothing undone: ${name} made no edits ClikCode saw.`,
        `${who}'s edits made any other way (a shell command, a tool that reports no diff) are not seen -- use /diff and git for those.`,
        ...(before ? [`The turn before it is ${turnName(before)}.`] : []),
      ].join('\n') };
    }
    return { ...result, text: describe(result, workspace, name) };
  });
}

/** The last N turns (1 = the last, as /changes numbers them),
 * newest first, each by the same rules as undoLastTurn -- and it stops at the first
 * turn that left a file alone: undoing an older turn under it would put back
 * a file the newer turn's kept change still depends on. */
export async function undoTurnsBack(
  session: HarnessSession, n: number,
  options: { stateDir: string; who: string; turnIsRunning?: (sessionId: string) => Promise<boolean> },
): Promise<TurnUndo> {
  if (n <= 1) return undoLastTurn(session, options);
  const total: Omit<TurnUndo, 'text'> = { restored: [], removed: [], conflicts: [] };
  const texts: string[] = [];
  let undone = 0;
  let check = options.turnIsRunning;
  for (; undone < n; undone += 1) {
    const recorded = await readTurnChanges(options.stateDir, session.id);
    if (!recorded.length) break;
    const step = await undoLastTurn(session, { ...options, ...(check ? { turnIsRunning: check } : {}) });
    // Asked once: what runs next would be this conversation's own new turn.
    check = async () => false;
    if (step.text.startsWith('Not undone:')) return step;
    total.restored.push(...step.restored);
    total.removed.push(...step.removed);
    total.conflicts.push(...step.conflicts);
    texts.push(step.text.replace(`\n\n${SHELL_CAVEAT}`, '').replace(/\nThe turn before it is .*$/, ''));
    if (step.conflicts.length) { undone += 1; break; }
  }
  if (!texts.length) return undoLastTurn(session, options);
  const stopped = total.conflicts.length && undone < n ? [`Stopped after ${undone} of ${n} turns: a file was left alone, so older turns were not undone.`] : [];
  const short = !total.conflicts.length && undone < n ? [`Only ${undone} turn${undone === 1 ? ' was' : 's were'} recorded to undo.`] : [];
  return { ...total, text: [...texts, ...stopped, ...short, SHELL_CAVEAT].join('\n\n') };
}
