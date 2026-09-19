/** `child_process.spawn` cannot launch Windows `.cmd`/`.bat` npm shims
 * directly without unsafe shell interpolation. cross-spawn preserves argv as
 * distinct values while resolving shebangs and PATHEXT on every platform. */
import crossSpawn from 'cross-spawn';
import type { ChildProcess } from 'node:child_process';

export const spawnPortable = crossSpawn;

export function terminatePortable(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== 'win32' || !child.pid) {
    child.kill(signal);
    return;
  }
  // Windows has no POSIX process groups and npm `.cmd` shims commonly own a
  // second Node process. taskkill /T prevents an interrupted harness from
  // surviving behind ClikCode; /F matches Node's effective Windows kill.
  const killer = crossSpawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
    stdio: 'ignore', windowsHide: true,
  });
  killer.once('error', () => { if (child.exitCode === null) child.kill(); });
}

/** Signal the whole process tree. A child spawned `detached` on POSIX leads
 * its own process group, so a negative pid reaches grandchildren (MCP servers,
 * shells) that would otherwise survive their parent. Windows already gets tree
 * semantics from taskkill in terminatePortable. */
export function killProcessTreePortable(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM', detached = false): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (detached && process.platform !== 'win32' && child.pid) {
    try { process.kill(-child.pid, signal); return; } catch { /* fall back to the direct child */ }
  }
  terminatePortable(child, signal);
}
