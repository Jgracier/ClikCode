import fs from 'fs';
import os from 'os';
import path from 'path';

export type LifecycleLock = {
  release: () => void;
  path: string;
};

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code !== 'ESRCH';
  }
}

export function acquireLifecycleLock(scope = 'global'): LifecycleLock {
  const lockPath = path.join(os.tmpdir(), `clikdeploy-cli-${scope}.lock`);
  const pid = process.pid;

  if (fs.existsSync(lockPath)) {
    const raw = fs.readFileSync(lockPath, 'utf8').trim();
    const existingPid = Number.parseInt(raw, 10);
    if (Number.isFinite(existingPid) && existingPid > 0 && isPidAlive(existingPid)) {
      throw new Error(
        `Another clikdeploy lifecycle command is already running (pid=${existingPid}).`
      );
    }
  }

  fs.writeFileSync(lockPath, String(pid), { encoding: 'utf8', flag: 'w' });

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      const raw = fs.existsSync(lockPath) ? fs.readFileSync(lockPath, 'utf8').trim() : '';
      if (raw === String(pid)) fs.unlinkSync(lockPath);
    } catch {
      // best effort
    }
  };

  return { release, path: lockPath };
}

