/**
 * The terminal process cannot load a new build in place. At a quiet moment
 * it re-execs onto the same chat: one redraw, the conversation unchanged.
 */
import { spawnSync } from 'node:child_process';
import { stdout } from 'node:process';
import { fileLocksIdle, fileLocksHeld } from '../../session/store/locks.js';
import { REEXEC_TERMINAL_ENV } from '../../tui/restore.js';
import { REEXEC_DRAFT_ENV } from '../../session/ephemeral.js';
import type { HarnessSession } from '../../session/model.js';

/** argv after the node binary: this CLI, and the chat to reopen. */
export function relaunchArgv(entry: string, sessionId?: string): string[] {
  return sessionId ? [entry, 'sessions', 'resume', sessionId] : [entry];
}

export interface BuildReplace {
  /** The chat the new process reopens. Absent, it starts the way a bare
   * `clikcode` does. */
  sessionId?: string;
  /** That chat when it is a draft -- held in this process only, never on
   * disk -- for the new process to hold in its place. */
  draft?: HarnessSession;
  /** The script this process is running. Defaults to argv[1], which is the
   * file a rebuild replaces. */
  entry?: string;
  closeUi: () => void;
  /** Drop this process's claim and transports before the new one attaches. */
  release: () => Promise<void>;
}

let replacing: Promise<void> | undefined;

/** Re-exec this CLI. The promise ends in process.exit. A second call joins
 * the same exit. Undefined when there is no script to exec, or when this
 * process holds or awaits a file lock right now: exec keeps this pid and
 * spawnSync blocks this event loop for the child's whole life, so a lock held
 * across either is never released and reads as live to every other
 * ClikCode. Such a process carries on, still whole, and the next quiet
 * moment asks again. */
export function replaceCliWithNewBuild(input: BuildReplace): Promise<void> | undefined {
  if (replacing) return replacing;
  const entry = input.entry ?? process.argv[1];
  if (!entry || fileLocksHeld()) return undefined;
  const sessionId = input.sessionId || undefined;
  // Inherited by the exec'd and the spawned process alike.
  if (input.draft && input.draft.id === sessionId) process.env[REEXEC_DRAFT_ENV] = JSON.stringify(input.draft);
  replacing = (async () => {
    try { await input.release(); } catch { /* the new process is the point */ }
    // Released now, so there is no going back. Locks release() took end on
    // their own: every lock wait is bounded (locks.ts).
    // On POSIX, replace this process itself. The terminal keeps its current
    // frame until the new build paints, and repeated builds do not leave a
    // chain of blocked parent processes behind. Flush the last answer first.
    if (typeof process.execve === 'function') {
      await new Promise<void>((resolve) => stdout.write('', () => resolve()));
      // Nothing may await between the idle check and the exec.
      await fileLocksIdle();
      try {
        process.execve(process.execPath, [process.execPath, ...relaunchArgv(entry, sessionId)],
          { ...process.env, [REEXEC_TERMINAL_ENV]: '1' });
      } catch { /* The existing child path restores the terminal on failure. */ }
    }
    try { input.closeUi(); } catch { /* the terminal is still handed over */ }
    // Nothing may await between this and the spawnSync.
    await fileLocksIdle();
    let status = 1;
    try {
      const result = spawnSync(process.execPath, relaunchArgv(entry, sessionId), { stdio: 'inherit' });
      status = result.status ?? 1;
    } finally {
      process.exit(status);
    }
  })();
  return replacing;
}
