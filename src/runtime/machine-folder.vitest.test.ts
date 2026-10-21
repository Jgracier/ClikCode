/** Node says `spawn <binary> ENOENT` both when the program is missing and when the folder it
 * was to run in is: on a machine that owns a chat named by another machine, that read as a
 * harness that is not installed. A failed start says which, and on which machine. */
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { machineName, spawnFailure } from './machine-folder.js';
import { createAcpSession } from '../harness/transport/acp-client.js';
import { classifyAccountFailure } from '../turn/failover.js';

const startError = (binary: string, cwd: string): Promise<Error> => new Promise((resolve) => {
  spawn(binary, [], { cwd, stdio: 'ignore' }).once('error', resolve);
});

describe('a child that failed to start', () => {
  const missing = '/clikcode-test-no-such-folder/on-the-other-machine';

  it('names the missing folder, on this machine, when the folder is what is missing', async () => {
    const raw = await startError(process.execPath, missing);
    expect(raw.message).toMatch(/ENOENT/);
    const said = spawnFailure(raw, { name: 'Claude Code', binary: process.execPath, cwd: missing });
    expect(said.message).toBe(`The folder ${missing} does not exist on ${machineName()}`);
    expect(said.message).not.toMatch(/not installed|ENOENT/);
  });

  it('names the harness and its binary when the program is what is missing', async () => {
    const raw = await startError('clikcode-test-no-such-binary', tmpdir());
    const said = spawnFailure(raw, { name: 'Claude Code', binary: 'clikcode-test-no-such-binary', cwd: tmpdir() });
    expect(said.message).toBe(`Claude Code is not installed on ${machineName()} (no \`clikcode-test-no-such-binary\` on PATH)`);
  });

  it('leaves every other error as it is', () => {
    const other = Object.assign(new Error('read EIO'), { code: 'EIO' });
    expect(spawnFailure(other, { name: 'x', binary: 'x', cwd: missing })).toBe(other);
  });

  it('never reads as a spent account', async () => {
    const folder = spawnFailure(await startError(process.execPath, missing), { name: 'x', binary: 'x', cwd: missing });
    const binary = spawnFailure(await startError('clikcode-test-no-such-binary', tmpdir()), { name: 'x', binary: 'clikcode-test-no-such-binary' });
    expect(classifyAccountFailure(folder, { isResultError: true })).toBe('other');
    expect(classifyAccountFailure(binary, { isResultError: true })).toBe('other');
  });

  it('says so through an ACP turn, whose child is started in the missing folder', async () => {
    const session = createAcpSession();
    try {
      await expect(session.runTurn({
        binary: process.execPath, command: 'claude', displayName: 'Claude Code', argv: ['-e', ''], cwd: missing, prompt: 'go',
        environment: {}, permissionMode: 'ask',
      })).rejects.toThrow(`The folder ${missing} does not exist on ${machineName()}`);
    } finally { await session.close(); }
  });
});
