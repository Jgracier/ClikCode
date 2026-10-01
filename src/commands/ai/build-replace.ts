/**
 * The terminal process cannot load a new build in place. At a quiet moment
 * it re-execs onto the same chat: one redraw, the conversation unchanged.
 */
import { spawnSync } from 'node:child_process';

/** argv after the node binary: this CLI, and the chat to reopen. */
export function relaunchArgv(entry: string, sessionId?: string): string[] {
  return sessionId ? [entry, 'sessions', 'resume', sessionId] : [entry];
}

export interface BuildReplace {
  /** The chat the new process reopens. Absent, it starts the way a bare
   * `clikcode` does. */
  sessionId?: string;
  /** The script this process is running. Defaults to argv[1], which is the
   * file a rebuild replaces. */
  entry?: string;
  closeUi: () => void;
  /** Drop this process's claim and transports before the new one attaches. */
  release: () => Promise<void>;
}

let replacing: Promise<void> | undefined;

/** Re-exec this CLI. The promise ends in process.exit. A second call joins
 * the same exit. Undefined when there is no script to exec. */
export function replaceCliWithNewBuild(input: BuildReplace): Promise<void> | undefined {
  if (replacing) return replacing;
  const entry = input.entry ?? process.argv[1];
  if (!entry) return undefined;
  const sessionId = input.sessionId || undefined;
  replacing = (async () => {
    try { await input.release(); } catch { /* the new process is the point */ }
    try { input.closeUi(); } catch { /* the terminal is still handed over */ }
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
