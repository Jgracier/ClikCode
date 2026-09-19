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
