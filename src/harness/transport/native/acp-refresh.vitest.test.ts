import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { localHarnessForCommand } from '../../../../packages/clikrouter/src/ai-local-harness.js';
import { refreshAcpAgent, resetAcpRefreshForTests } from './install.js';

describe('an ACP agent that is behind its CLI', () => {
  let directory: string;
  const previous = process.env.CLIKCODE_HOME;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'clikcode-acp-refresh-'));
    process.env.CLIKCODE_HOME = directory;
    resetAcpRefreshForTests();
  });
  afterEach(async () => {
    if (previous === undefined) delete process.env.CLIKCODE_HOME; else process.env.CLIKCODE_HOME = previous;
    await rm(directory, { recursive: true, force: true });
  });

  it('Claude\'s agent is installed at whatever is current, as its CLI is: a pinned agent cannot know a model the CLI gained', () => {
    const claude = localHarnessForCommand('claude')!;
    expect(claude.acp?.npmPackage).toBe('@agentclientprotocol/claude-agent-acp');
    // No ACP agent in the catalog names a version: each is the companion of a CLI that updates itself.
    expect(claude.acp?.npmPackage).not.toMatch(/.@\d/);
  });

  it('is installed afresh once, then not again for hours however many turns it refuses', async () => {
    const spec = { command: 'claude', binary: 'claude', displayName: 'Claude Code', acp: { binary: 'claude-agent-acp', npmPackage: '@agentclientprotocol/claude-agent-acp' } };
    const install = vi.fn(async () => undefined);
    let now = 1_000_000;
    const deps = { install, now: () => now, directory };
    expect(await Promise.all([refreshAcpAgent(spec, deps), refreshAcpAgent(spec, deps)])).toEqual([true, true]);
    expect(install).toHaveBeenCalledTimes(1);
    expect(install).toHaveBeenCalledWith('@agentclientprotocol/claude-agent-acp');
    // Another worker of the same machine, minutes later: the agent is current, its refusal is not a reason to install again.
    resetAcpRefreshForTests();
    now += 10 * 60 * 1000;
    expect(await refreshAcpAgent(spec, deps)).toBe(false);
    expect(install).toHaveBeenCalledTimes(1);
    // Much later the CLI may have moved on again.
    resetAcpRefreshForTests();
    now += 7 * 60 * 60 * 1000;
    expect(await refreshAcpAgent(spec, deps)).toBe(true);
    expect(install).toHaveBeenCalledTimes(2);
  });

  it('a failed install is not the turn\'s failure, and a harness with no ACP package has nothing to refresh', async () => {
    const spec = { command: 'claude', binary: 'claude', displayName: 'Claude Code', acp: { binary: 'claude-agent-acp', npmPackage: 'x' } };
    expect(await refreshAcpAgent(spec, { install: async () => { throw new Error('offline'); }, directory })).toBe(false);
    expect(await refreshAcpAgent({ command: 'codex', binary: 'codex', displayName: 'Codex' }, { install: async () => { throw new Error('never'); }, directory })).toBe(false);
  });
});
