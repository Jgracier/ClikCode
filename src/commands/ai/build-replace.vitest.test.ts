import { describe, expect, it } from 'vitest';
import { relaunchArgv } from './build-replace';

describe('relaunch argv', () => {
  it('reopens the same chat', () => {
    expect(relaunchArgv('/usr/bin/clikcode', 'chat-1')).toEqual(['/usr/bin/clikcode', 'sessions', 'resume', 'chat-1']);
  });

  it('starts fresh when there is no chat to reopen', () => {
    expect(relaunchArgv('/usr/bin/clikcode')).toEqual(['/usr/bin/clikcode']);
    expect(relaunchArgv('/usr/bin/clikcode', '')).toEqual(['/usr/bin/clikcode']);
  });
});

describe('file locks before a re-exec', () => {
  it('waits until this process holds no lock, including one queued behind it', async () => {
    const { mkdtemp, rm, stat } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { fileLocksIdle, withFileLock } = await import('../../session/store/locks');
    const dir = await mkdtemp(join(tmpdir(), 'clikcode-lock-idle-'));
    const lock = join(dir, 'state.lock');
    try {
      let release!: () => void;
      const held = withFileLock(lock, () => new Promise<void>((resolve) => { release = resolve; }));
      const queued = withFileLock(lock, async () => undefined);
      let idle = false;
      const waiting = fileLocksIdle().then(() => { idle = true; });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(idle).toBe(false);
      release();
      await waiting;
      await Promise.all([held, queued]);
      await expect(stat(lock)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
