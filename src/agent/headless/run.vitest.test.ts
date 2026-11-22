import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentArgs, ENV_LAUNCHER_SOURCE, superviseAgent } from './run.js';

const base = { dir: '/tmp/d', config: '/tmp/d/mcp.json', final: '/tmp/d/final.txt', prompt: 'do it' };

describe('the headless agent command line', () => {
  it('has no --allowedTools when no MCP server is given, so the next flag is not swallowed', () => {
    const args = agentArgs({ ...base, useCodex: false, servers: {} });
    expect(args).not.toContain('--allowedTools');
    expect(args).toContain('--permission-mode');
    expect(agentArgs({ ...base, useCodex: false, servers: { clikcode: { command: 'node' } } })).toEqual(expect.arrayContaining(['--allowedTools', 'mcp__clikcode']));
  });
  it('never puts a Codex MCP server\'s environment on argv', () => {
    const args = agentArgs({ ...base, useCodex: true, servers: { tools: { command: 'node', args: ['x'], env: { API_KEY: 'sk-secret-value' } } } });
    expect(args.join(' ')).not.toContain('sk-secret-value');
    expect(args.join(' ')).not.toMatch(/\.env=/);
  });
  it('the launcher gives the server its environment from the file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-launcher-'));
    await writeFile(join(dir, 'l.cjs'), ENV_LAUNCHER_SOURCE);
    await writeFile(join(dir, 'env.json'), JSON.stringify({ API_KEY: 'from-file' }));
    const out = execFileSync(process.execPath, [join(dir, 'l.cjs'), join(dir, 'env.json'), process.execPath, '-e', 'process.stdout.write(process.env.API_KEY)'], { encoding: 'utf8' });
    expect(out).toBe('from-file');
  });
});

describe.skipIf(process.platform === 'win32')('supervising a headless agent', () => {
  const setup = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-supervise-'));
    const activity = join(dir, 'activity');
    await writeFile(activity, '');
    return { dir, activity };
  };
  it('stops on the ceiling with SIGTERM first, so a tool server can close its tab, before any SIGKILL', async () => {
    const { dir, activity } = await setup();
    const mark = join(dir, 'closed');
    // A "tool server" in the agent's group that cleans up on SIGTERM.
    const child = spawn('sh', ['-c', `sh -c 'trap "echo closed > ${mark}; exit 0" TERM; while :; do sleep 0.05; done' & wait`], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const result = await superviseAgent(child, { activity, maxMs: 300, stallMs: 60_000, graceMs: 2_000, pollMs: 50 });
    expect(result.timedOut).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(await readFile(mark, 'utf8').catch(() => '')).toContain('closed');
  });
  it('SIGKILLs an agent that ignores SIGTERM after the grace period', async () => {
    const { activity } = await setup();
    const child = spawn('sh', ['-c', "trap '' TERM; while :; do sleep 0.05; done"], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const started = Date.now();
    const result = await superviseAgent(child, { activity, maxMs: 200, stallMs: 60_000, graceMs: 300, pollMs: 50 });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(3_000);
  });
  it('stops on the caller\'s signal (Ctrl-C), also one already aborted', async () => {
    const { activity } = await setup();
    const controller = new AbortController();
    const child = spawn('sh', ['-c', 'sleep 30'], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    setTimeout(() => controller.abort(), 100);
    expect(await superviseAgent(child, { activity, maxMs: 60_000, stallMs: 60_000, signal: controller.signal, graceMs: 300, pollMs: 50 })).toMatchObject({ stopped: true });
    const again = spawn('sh', ['-c', 'sleep 30'], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const started = Date.now();
    expect(await superviseAgent(again, { activity, maxMs: 60_000, stallMs: 60_000, signal: AbortSignal.abort(), graceMs: 300, pollMs: 50 })).toMatchObject({ stopped: true });
    expect(Date.now() - started).toBeLessThan(3_000);
  });
  it('cuts off an agent that stopped calling tools', async () => {
    const { activity } = await setup();
    const child = spawn('sh', ['-c', 'sleep 30'], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    expect(await superviseAgent(child, { activity, maxMs: 60_000, stallMs: 200, graceMs: 300, pollMs: 50 })).toMatchObject({ timedOut: true, stalled: true });
  });
});
