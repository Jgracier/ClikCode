/** `/undo`: put back the files the conversation's last turn changed.
 *
 * Two sources, by who made the edits:
 *  - ClikCode's own agent snapshots every file before its tools write it
 *    (agent/file-checkpoints.ts), on disk, so the worker that ran the turn
 *    and the window that types /undo need not be the same process.
 *  - A vendor harness's edits are known only as the diffs its event stream
 *    reported (session/turn-changes.ts); they are reversed hunk by hunk with
 *    the same code VS Code's "Undo all" uses (agent/diff-unwind.ts).
 *
 * Either way a file is only written when it is still as the turn left it:
 * one changed since is named and left alone, never overwritten. */

import fs from 'node:fs/promises';
import path from 'node:path';
import { FileCheckpointStore } from '../agent/file-checkpoints.js';
import { turnChanges, unwindChanges } from '../agent/diff-unwind.js';
import type { HarnessSession } from './model.js';
import { isClikCodeAgent } from './route.js';
import { readTurnChanges, writeTurnChanges } from './turn-changes.js';

export interface TurnUndo {
  /** Files put back as they were before the turn. */
  restored: string[];
  /** Files the turn created, removed again. */
  removed: string[];
  /** Files left alone, and why. */
  conflicts: Array<{ path: string; reason: string }>;
  text: string;
}

const SHELL_CAVEAT = 'Only edits made through file-editing tools are tracked: anything a shell command changed (generated files, installs, git operations) is not undone.';

function shown(file: string, workspace: string): string {
  const relative = path.relative(workspace, file);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : file;
}

function describe(result: Omit<TurnUndo, 'text'>, workspace: string, emptyText: string): string {
  const done = result.restored.length + result.removed.length;
  if (!done && !result.conflicts.length) return emptyText;
  const lines = [done
    ? `Undid the last turn's changes to ${done} file${done === 1 ? '' : 's'}.`
    : `Could not undo the last turn: every file it changed has changed since.`];
  for (const file of result.restored) lines.push(`  restored  ${shown(file, workspace)}`);
  for (const file of result.removed) lines.push(`  removed   ${shown(file, workspace)} (the turn created it)`);
  for (const item of result.conflicts) lines.push(`  kept      ${shown(item.path, workspace)}: ${item.reason}`);
  if (result.conflicts.length) lines.push('', 'Files kept were not touched. Run /undo again once they are back as the turn left them, or revert them with git.');
  lines.push('', SHELL_CAVEAT);
  return lines.join('\n');
}

/** ClikCode's own agent: restore the pre-image snapshots. */
async function undoAgentTurn(stateDir: string, session: HarnessSession, workspace: string): Promise<TurnUndo> {
  const store = new FileCheckpointStore(stateDir);
  const outcome = await store.undoTurn(session.id);
  const result = {
    restored: outcome.restored, removed: outcome.deleted,
    conflicts: outcome.failed.map((item) => ({ path: item.path, reason: item.reason })),
  };
  return { ...result, text: describe(result, workspace, 'Nothing to undo: ClikCode\'s agent has recorded no file edits in this conversation.') };
}

function conflictReason(current: string | undefined, changes: ReadonlyArray<{ change?: string; omitted?: number; priorUnknown?: boolean }>): string {
  if (changes.some((change) => change.priorUnknown)) return 'the harness reported only what it wrote here, not what the file held before, so it cannot be put back';
  if (changes.some((change) => change.omitted)) return 'the harness reported this change only in part, so it cannot be reversed exactly';
  if (current === undefined) return changes.some((change) => change.change === 'delete') ? 'the turn deleted it and the harness did not report its content' : 'it no longer exists';
  return 'changed since that turn; not overwritten';
}

/** A vendor harness: reverse the diffs its calls reported, newest first. */
async function undoReportedTurn(stateDir: string, session: HarnessSession, workspace: string, who: string): Promise<TurnUndo> {
  const records = await readTurnChanges(stateDir, session.id);
  const last = records.at(-1);
  const result: Omit<TurnUndo, 'text'> = { restored: [], removed: [], conflicts: [] };
  if (!last) {
    return { ...result, text: `Nothing to undo: ${who} has reported no file edits in this conversation. /undo reverses the edits a harness reports with their content; ${who}'s edits made any other way (a shell command, a tool that reports no diff) are not seen by ClikCode -- use /diff and git for those.` };
  }
  const kept = [];
  for (const [file, changes] of turnChanges([{ kind: 'tool-done', diff: last.changes }])) {
    const target = path.isAbsolute(file) ? file : path.resolve(workspace, file);
    const current = await fs.readFile(target, 'utf8').catch(() => undefined);
    const unwound = unwindChanges(current, changes);
    if (!unwound.whole) {
      result.conflicts.push({ path: target, reason: conflictReason(current, changes) });
      kept.push(...changes);
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
  // Done files leave the record; what could not be undone stays for a retry.
  await writeTurnChanges(stateDir, session.id, kept.length ? [...records.slice(0, -1), { ...last, changes: kept }] : records.slice(0, -1));
  return { ...result, text: describe(result, workspace, 'Nothing to undo.') };
}

export async function undoLastTurn(session: HarnessSession, options: { stateDir: string; who: string }): Promise<TurnUndo> {
  const workspace = session.workspace ?? process.cwd();
  return isClikCodeAgent(session)
    ? undoAgentTurn(options.stateDir, session, workspace)
    : undoReportedTurn(options.stateDir, session, workspace, options.who);
}
