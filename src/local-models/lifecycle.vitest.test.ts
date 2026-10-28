import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { heldByLiveProcess, removeLeases, removeTurnLeases, serverDir, sessionHeldElsewhere, writeLease, writeTurnLease } from './lifecycle';

const previous = process.env.CLIKCODE_LOCAL_MODELS_HOME;
beforeEach(() => { process.env.CLIKCODE_LOCAL_MODELS_HOME = mkdtempSync(join(tmpdir(), 'cc-leases-')); });
afterEach(() => {
  if (previous === undefined) delete process.env.CLIKCODE_LOCAL_MODELS_HOME;
  else process.env.CLIKCODE_LOCAL_MODELS_HOME = previous;
});

function leaseFrom(pid: number, sessionId: string): void {
  const directory = join(serverDir('qwen3.5-4b'), 'leases');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${pid}-${sessionId}.json`), '{}');
}

describe('whether another process holds a session', () => {
  it('counts a live other process, and neither this one nor a dead one', async () => {
    await writeLease('qwen3.5-4b', 'abc-123');
    expect(await sessionHeldElsewhere('qwen3.5-4b', 'abc-123')).toBe(false);
    // pid 1 is always alive; a pid far past pid_max never is.
    leaseFrom(99_999_999, 'abc-123');
    expect(await sessionHeldElsewhere('qwen3.5-4b', 'abc-123')).toBe(false);
    leaseFrom(1, 'other-session');
    expect(await sessionHeldElsewhere('qwen3.5-4b', 'abc-123')).toBe(false);
    leaseFrom(1, 'abc-123');
    expect(await sessionHeldElsewhere('qwen3.5-4b', 'abc-123')).toBe(true);
    expect(await sessionHeldElsewhere('gpt-oss-20b', 'abc-123')).toBe(false);
  });
});

describe('a turn\'s lease', () => {
  const leases = () => join(serverDir('qwen3.5-4b'), 'leases');

  it('is its own file, kept apart from the lease of whoever shows the chat', async () => {
    await writeLease('qwen3.5-4b', 'abc-123');
    await writeTurnLease('qwen3.5-4b', 'abc-123');
    expect(existsSync(join(leases(), `${process.pid}-abc-123.json`))).toBe(true);
    expect(existsSync(join(leases(), `${process.pid}-turn-abc-123.json`))).toBe(true);
    // Letting go of the chat does not let go of the turn, and the turn ending does not let go of the chat.
    await removeLeases('abc-123');
    expect(existsSync(join(leases(), `${process.pid}-abc-123.json`))).toBe(false);
    expect(existsSync(join(leases(), `${process.pid}-turn-abc-123.json`))).toBe(true);
    await writeLease('qwen3.5-4b', 'abc-123');
    await removeTurnLeases('abc-123');
    expect(existsSync(join(leases(), `${process.pid}-turn-abc-123.json`))).toBe(false);
    expect(existsSync(join(leases(), `${process.pid}-abc-123.json`))).toBe(true);
  });

  it('holds the model, but is not a window showing the chat', async () => {
    await writeTurnLease('qwen3.5-4b', 'abc-123');
    expect(await heldByLiveProcess('qwen3.5-4b')).toBe(true);
    // Another process running a turn does not make a window think someone shows the chat: it would not take its own hold.
    mkdirSync(leases(), { recursive: true });
    writeFileSync(join(leases(), '1-turn-abc-123.json'), '{}');
    expect(await sessionHeldElsewhere('qwen3.5-4b', 'abc-123')).toBe(false);
    writeFileSync(join(leases(), '1-abc-123.json'), '{}');
    expect(await sessionHeldElsewhere('qwen3.5-4b', 'abc-123')).toBe(true);
  });

  it('keeps a running turn\'s model up when the window leaves the chat, and lets it go when the turn ends', async () => {
    const { startSupervisor } = await import('./lifecycle');
    const dir = serverDir('lease-test');
    // The window shows the chat; a turn is running on the model.
    await writeLease('lease-test', 's');
    await writeTurnLease('lease-test', 's');
    const record = await startSupervisor({
      modelId: 'lease-test', dir, command: process.execPath, port: 1, alias: 'x', context: 1024,
      args: ['-e', 'setInterval(() => {}, 1000)'], env: {}, idleMs: 0, pollMs: 100, leaseGraceMs: 400,
    } as never);
    const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
    try {
      // The window leaves the chat (found live 2026-10-28: the supervisor stopped the model 22 s after, mid-request).
      await removeLeases('s');
      await new Promise((done) => setTimeout(done, 1500));
      expect(alive(record.supervisorPid)).toBe(true);
      expect(alive(record.serverPid)).toBe(true);
      expect(readFileSync(join(dir, 'supervisor.log'), 'utf8')).not.toContain('stopped');
      // The turn ends with nobody showing the chat: the model goes.
      await removeTurnLeases('s');
      for (let waited = 0; waited < 8_000 && alive(record.supervisorPid); waited += 100) await new Promise((done) => setTimeout(done, 100));
      expect(alive(record.supervisorPid)).toBe(false);
      expect(readFileSync(join(dir, 'supervisor.log'), 'utf8')).toContain('no live ClikCode process holds a lease');
    } finally {
      try { process.kill(record.serverPid, 'SIGKILL'); } catch { /* gone */ }
      try { process.kill(record.supervisorPid, 'SIGKILL'); } catch { /* gone */ }
    }
  }, 20_000);
});

describe('measured footprints', () => {
  it('are read per machine and model, keyed by configuration', async () => {
    const { footprintKey, readFootprints } = await import('./measure');
    const { footprintsFile } = await import('./paths');
    const run = { context: 65_536, cacheType: 'f16', parallel: 2, vision: false, anonBytes: 3.9e9, fileBytes: 2.1e9, at: 'now' };
    mkdirSync(serverDir('qwen3.5-4b'), { recursive: true });
    writeFileSync(footprintsFile('qwen3.5-4b'), JSON.stringify({ here: { [footprintKey(run)]: run }, elsewhere: { x: { ...run, anonBytes: 1 } } }));
    expect(footprintKey(run)).toBe('65536|f16|2|text');
    expect(await readFootprints('here', ['qwen3.5-4b', 'gpt-oss-20b'])).toEqual({ 'qwen3.5-4b': [run] });
    expect(await readFootprints('new-machine', ['qwen3.5-4b'])).toEqual({});
  });
});

describe('whether anyone holds a model', () => {
  it('counts only leases whose process is alive', async () => {
    expect(await heldByLiveProcess('m')).toBe(false);
    mkdirSync(join(serverDir('m'), 'leases'), { recursive: true });
    writeFileSync(join(serverDir('m'), 'leases', '999999999-gone.json'), '{}');
    expect(await heldByLiveProcess('m')).toBe(false);
    await writeLease('m', 'mine');
    expect(await heldByLiveProcess('m')).toBe(true);
  });
});

describe('the supervisor\'s logs', () => {
  it('moves a large server.log aside at start, and trims one the server grows while running', async () => {
    const { startSupervisor, SUPERVISOR_SCRIPT } = await import('./lifecycle');
    const { readFileSync, statSync, existsSync } = await import('node:fs');
    expect(SUPERVISOR_SCRIPT).toContain('rotateLogs');
    const dir = serverDir('rotate-test');
    mkdirSync(join(dir, 'leases'), { recursive: true });
    writeFileSync(join(dir, 'leases', `${process.pid}-s.json`), '{}');
    writeFileSync(join(dir, 'server.log'), 'old\n'.repeat(1_600_000));
    // A stand-in server that writes 6MB, then waits.
    const record = await startSupervisor({
      modelId: 'rotate-test', dir, command: process.execPath, port: 1, alias: 'x', context: 1024,
      args: ['-e', "process.stdout.write('new\\n'.repeat(1600000)); setInterval(() => {}, 1000)"],
      env: {}, idleMs: 0, pollMs: 60_000, logCheckMs: 200,
    } as never);
    try {
      // Moved aside before the server started: the server's own lines start the file.
      expect(readFileSync(join(dir, 'server.log'), 'utf8').startsWith('old')).toBe(false);
      for (let waited = 0; waited < 10_000; waited += 100) {
        if (existsSync(join(dir, 'server.log.1')) && readFileSync(join(dir, 'server.log.1'), 'utf8').startsWith('new') && statSync(join(dir, 'server.log')).size < 1_000_000) break;
        await new Promise((done) => setTimeout(done, 100));
      }
      expect(readFileSync(join(dir, 'server.log.1'), 'utf8').startsWith('new')).toBe(true);
      expect(statSync(join(dir, 'server.log')).size).toBeLessThan(1_000_000);
    } finally {
      try { process.kill(record.serverPid, 'SIGKILL'); } catch { /* gone */ }
      try { process.kill(record.supervisorPid, 'SIGKILL'); } catch { /* gone */ }
    }
  }, 20_000);
});
