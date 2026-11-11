/**
 * The terminal process cannot load a new build in place. At a quiet moment
 * it re-execs onto the same chat: one redraw, the conversation unchanged.
 */
import { spawnSync } from 'node:child_process';
import { stdout } from 'node:process';
import { fileLocksIdle, fileLocksHeld } from '../../session/store/locks.js';
import { historyDump, REEXEC_TERMINAL_ENV, reexecHandover } from '../../tui/restore.js';
import { popReadModes } from '../../tui/modes.js';
import { REEXEC_DRAFT_ENV, REEXEC_TYPED_ENV } from '../../session/ephemeral.js';
import type { HarnessSession } from '../../session/model.js';
import { swallowed } from '../../runtime/lifecycle-log.js';

/** argv after the node binary: this CLI, and the chat to reopen. */
export function relaunchArgv(entry: string, sessionId?: string): string[] {
  return sessionId ? [entry, 'sessions', 'resume', sessionId] : [entry];
}

interface BuildReplace {
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
  /** What the composer holds now, asked for after release() and handed to the new process: the window was idle when this began, and
   * what was typed while it let go is not lost with it. */
  typed?: () => string;
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
    try { await input.release(); } catch (error) { /* the new process is the point */ swallowed('commands/ai/build-replace', error); }
    // Released now, so there is no going back. Locks release() took end on
    // their own: every lock wait is bounded (locks.ts).
    // Asked as late as the awaits allow: release() takes a while, and the keys typed meanwhile went into a composer that is about to go.
    const handOverTyped = (): void => {
      let text = '';
      try { text = input.typed?.() ?? ''; } catch { /* fail-open-ok: without it the draft is simply not carried */ }
      if (text) process.env[REEXEC_TYPED_ENV] = text; else delete process.env[REEXEC_TYPED_ENV];
    };
    // On POSIX, replace this process itself. The terminal keeps its current
    // frame until the new build paints, and repeated builds do not leave a
    // chain of blocked parent processes behind. Flush the last answer first.
    if (typeof process.execve === 'function') {
      // This process's kitty keyboard entry is popped before it is replaced: the stack belongs to the terminal, and the new process
      // pushes its own, so each re-exec left one more entry on it (and a shell's Ctrl+C arriving as CSI-u after enough of them).
      await new Promise<void>((resolve) => stdout.write(popReadModes(), () => resolve()));
      // Nothing may await between the idle check and the exec.
      await fileLocksIdle();
      handOverTyped();
      try {
        process.execve(process.execPath, [process.execPath, ...relaunchArgv(entry, sessionId)],
          { ...process.env, [REEXEC_TERMINAL_ENV]: reexecHandover() });
      } catch (error) { /* The existing child path restores the terminal on failure. */ swallowed('commands/ai/build-replace', error); }
    }
    // The copy started below writes the whole conversation when it ends; this one writes none, or it would be there twice.
    historyDump.suppressed = true;
    try { input.closeUi(); } catch (error) { /* the terminal is still handed over */ swallowed('commands/ai/build-replace', error); }
    // Nothing may await between this and the spawnSync.
    await fileLocksIdle();
    handOverTyped();
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
