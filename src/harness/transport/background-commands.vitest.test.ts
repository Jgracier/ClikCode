/** Background commands by pid: how a status line names them, when the policy calls one stale, and how a
 * tracked command is ended (its own group, never the vendor's; never by name). Real children. */
import { spawn } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { appendFile, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandSampler, KEEP_MARK, describeCommands, formatAge, killCommand, staleVerdict, type CommandPolicy, type CommandStats } from './background-commands.js';
import { commandLastLine, type BackgroundWork } from '../protocol/background-agents.js';
import { createAcpSession, shellFailure } from './acp-client.js';
import { processAlive } from './process-group.js';

const POLICY: CommandPolicy = { maxLifetimeMs: 2 * 3_600_000, hotMs: 30 * 60_000, hotCpuPercent: 90 };
const HOUR = 3_600_000;

describe('staleVerdict', () => {
  const now = 1_000_000_000_000;
  it('calls a command over the lifetime limit stale, whatever it is doing', () => {
    expect(staleVerdict({ pid: 5, label: 'x', startedAt: now - 3 * HOUR, cpuPercent: 0, lastOutputAt: now - 1000 }, now, POLICY)).toMatch(/over the 2h limit/);
  });
  it('calls a busy command with no output for 30 minutes stale', () => {
    expect(staleVerdict({ pid: 5, label: 'x', startedAt: now - 40 * 60_000, cpuPercent: 100 }, now, POLICY)).toMatch(/cpu 100% with no output for 40m/);
  });
  it('leaves a busy command that is writing, an idle one, a young one and a kept one alone', () => {
    expect(staleVerdict({ pid: 5, label: 'x', startedAt: now - 40 * 60_000, cpuPercent: 100, lastOutputAt: now - 60_000 }, now, POLICY)).toBeUndefined();
    expect(staleVerdict({ pid: 5, label: 'x', startedAt: now - 40 * 60_000, cpuPercent: 3 }, now, POLICY)).toBeUndefined();
    expect(staleVerdict({ pid: 5, label: 'x', startedAt: now - 10 * 60_000, cpuPercent: 100 }, now, POLICY)).toBeUndefined();
    expect(staleVerdict({ pid: 5, label: 'x', startedAt: now - 9 * HOUR, keep: true }, now, POLICY)).toBeUndefined();
  });
});

describe('describeCommands', () => {
  const now = 1_000_000_000_000;
  it('says the command and the newest line it printed, never its cpu', () => {
    expect(describeCommands([{ pid: 9, label: 'publish', startedAt: now - 6 * 60_000, cpuPercent: 100, lastOutputAt: now - 2_000, lastLine: 'running tests' }], now))
      .toBe('publish · running tests');
    expect(describeCommands([{ pid: 9, label: 'a', startedAt: now - 60_000, lastOutputAt: now - 5_000, lastLine: 'ok' }, { pid: 10, label: 'b', startedAt: now - 5_000 }], now))
      .toBe('a · ok · +1 more');
    expect(describeCommands([], now)).toBeUndefined();
    expect(formatAge(90 * 60_000)).toBe('1h 30m');
  });

  it('says nothing of silence until it has lasted five minutes, then how long', () => {
    expect(describeCommands([{ pid: 9, label: 'sleep 600', startedAt: now - 4 * 60_000 }], now)).toBe('sleep 600');
    expect(describeCommands([{ pid: 9, label: 'sleep 600', startedAt: now - 7 * 60_000 }], now)).toBe('sleep 600 · quiet 7m');
    expect(describeCommands([{ pid: 9, label: 'pnpm test', startedAt: now - 3_600_000, lastOutputAt: now - 5 * 60_000, lastLine: 'waiting for db' }], now))
      .toBe('pnpm test · waiting for db · quiet 5m');
    expect(describeCommands([{ pid: 9, label: 'x', startedAt: now - 32 * HOUR, cpuPercent: 100 }], now)).not.toMatch(/cpu|no output/);
  });

  it('cuts the line to the room it has', () => {
    const line = describeCommands([{ pid: 9, label: 'build', startedAt: now - 1000, lastOutputAt: now, lastLine: 'x'.repeat(200) }], now, 40)!;
    expect(line.startsWith('build · xxx')).toBe(true);
    expect(line.length).toBeLessThanOrEqual(40);
    expect(line.endsWith('…')).toBe(true);
  });
});

describe('shellFailure', () => {
  it('reads how a Claude background shell exited from its notification', () => {
    expect(shellFailure('completed', 'Background command "x" completed (exit code 0)')).toBeUndefined();
    expect(shellFailure('completed', 'Background command "x" completed (exit code 1)')).toBe('exit 1');
    expect(shellFailure('failed', 'Background command "x" failed with exit code 127')).toBe('exit 127');
    expect(shellFailure('killed', '')).toBe('killed');
  });
});

describe('commandLastLine', () => {
  it('is the newest non-empty line, plain', () => {
    expect(commandLastLine('one\n\u001b[32mtwo  ok\u001b[0m\n\n  \n')).toBe('two ok');
    expect(commandLastLine('progress 10%\rprogress 90%\r')).toBe('progress 90%');
    expect(commandLastLine('\n \n')).toBeUndefined();
  });
});

describe('CommandSampler output', () => {
  it('reads the newest line of a command\'s output file, again only when it changed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'clikcode-cmd-out-'));
    try {
      const file = join(dir, 'task.output');
      await writeFile(file, 'starting\nrunning tests\n');
      const sampler = new CommandSampler();
      const stats: CommandStats = { pid: 424242, label: 'x', outputFile: file };
      expect(await sampler.readOutput(stats)).toBe(true);
      expect(stats).toMatchObject({ lastLine: 'running tests' });
      expect(await sampler.readOutput(stats)).toBe(false);
      await appendFile(file, '12 passed\n\n');
      await utimes(file, new Date(), new Date(Date.now() + 5_000));
      expect(await sampler.readOutput(stats)).toBe(true);
      expect(stats.lastLine).toBe('12 passed');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe.skipIf(process.platform !== 'linux')('killCommand', () => {
  it('ends a command that leads a group of its own, with what it started', async () => {
    const child = spawn('sh', ['-c', 'sleep 60 & wait'], { detached: true, stdio: 'ignore' });
    await vi.waitFor(async () => expect((await new CommandSampler().sample(child.pid!)).pgid).toBe(child.pid));
    const report = await killCommand(child.pid!, { graceMs: 50 });
    expect(report.how).toBe('group');
    await vi.waitFor(() => expect(processAlive(child.pid!)).toBe(false));
  });

  it('never signals the vendor\'s group: a command in it is ended as a tree, by pid', async () => {
    const child = spawn('sh', ['-c', 'sleep 60 & wait'], { detached: true, stdio: 'ignore' });
    const signals: Array<[number, string]> = [];
    try {
      const report = await killCommand(child.pid!, { vendorPgid: child.pid!, graceMs: 20, kill: (target, signal) => { signals.push([target, signal]); } });
      expect(report.how).toBe('tree');
      expect(signals.every(([target]) => target > 0)).toBe(true);
      expect(signals.some(([target]) => target === child.pid)).toBe(true);
    } finally { process.kill(-child.pid!, 'SIGKILL'); }
  });

  it('does nothing to a pid that is gone', async () => {
    expect((await killCommand(2_147_000_000, { graceMs: 1 })).how).toBe('gone');
  });
});

/** An agent whose prompt leaves `command` running in a shell (a tool call's background job) and answers. */
const agent = (command: string): string => `
  const { spawn } = require('node:child_process');
  const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
  let buf = '';
  process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    else if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 's1' } });
    else if (m.method === 'session/prompt') {
      spawn('sh', ['-c', ${JSON.stringify(command)}], { stdio: 'ignore' });
      send({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'tool_call', toolCallId: 'b', title: 'Run (background)', kind: 'execute', status: 'completed' } } });
      setTimeout(() => { send({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } } } }); send({ id: m.id, result: { stopReason: 'end_turn' } }); }, 300);
    }
  } });
`;

async function leaving(command: string, commandPolicy: CommandPolicy, onBackgroundWork?: (work: BackgroundWork) => void) {
  const session = createAcpSession({ commandWatchMs: 150, commandPolicy });
  const turn = await session.runTurn({
    binary: process.execPath, command: 'fake', argv: ['-e', agent(command)], cwd: process.cwd(), prompt: 'go', environment: {}, permissionMode: 'ask',
    ...(onBackgroundWork ? { onBackgroundWork } : {}),
  });
  expect(turn.text).toBe('ok');
  await vi.waitFor(async () => expect(await session.backgroundWorkRunning()).toBe(true), { timeout: 5_000 });
  return { session };
}

describe.skipIf(process.platform !== 'linux')('a command a turn left running', () => {
  it('is listed by pid with its label and age, and ended by the stale policy (logged), leaving others alone', async () => {
    const { session } = await leaving('sleep 61; true', { maxLifetimeMs: 1, hotMs: 1e12, hotCpuPercent: 90 });
    try {
      // Read the pid before the watch ends it.
      const listed = await session.backgroundCommands();
      const reaped = listed.length ? await session.reapCommands('stale', 'stale background command') : [];
      expect(listed).toHaveLength(1);
      expect(listed[0]!.label).toContain('sleep 61');
      expect(listed[0]!.startedAt).toBeGreaterThan(0);
      expect(listed[0]!.stale).toMatch(/over the/);
      expect(reaped).toHaveLength(1);
      await vi.waitFor(() => expect(processAlive(listed[0]!.pid)).toBe(false), { timeout: 5_000 });
      await vi.waitFor(async () => expect(await session.backgroundWorkRunning()).toBe(false), { timeout: 5_000 });
    } finally { await session.close(); }
  });

  it('is told with the newest line it printed, and once it ends, that it ended and how long it ran', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'clikcode-cmd-told-'));
    const levels: BackgroundWork[] = [];
    const { session } = await leaving(`exec >${join(dir, 'job.output')}; echo first; echo 'step two'; sleep 1.5; true`, POLICY, (work) => levels.push(work));
    try {
      // The level names commands only beside the vendor's terminal count (which this fake agent never sends): read them directly.
      await vi.waitFor(async () => expect((await session.backgroundCommands())[0]?.lastLine).toBe('step two'), { timeout: 8_000 });
      await vi.waitFor(() => expect(levels.flatMap((level) => level.ended ?? [])).toEqual([expect.objectContaining({ label: expect.stringContaining('sleep 1.5'), ms: expect.any(Number) })]), { timeout: 12_000 });
      expect(levels.flatMap((level) => level.ended ?? [])[0]!.failed).toBeUndefined();
    } finally { await session.close(); await rm(dir, { recursive: true, force: true }); }
  }, 20_000);

  it('is ended by the watch on its own once it is stale', async () => {
    const { session } = await leaving('sleep 62; true', { maxLifetimeMs: 1, hotMs: 1e12, hotCpuPercent: 90 });
    try {
      await vi.waitFor(async () => expect(await session.backgroundWorkRunning()).toBe(false), { timeout: 8_000 });
    } finally { await session.close(); }
  });

  it(`is never ended by the policy when it carries ${KEEP_MARK}`, async () => {
    const { session } = await leaving(`sleep 63; true # ${KEEP_MARK}`, { maxLifetimeMs: 1, hotMs: 1, hotCpuPercent: 0 });
    try {
      const [command] = await session.backgroundCommands();
      expect(command?.keep).toBe(true);
      expect(command?.stale).toBeUndefined();
      expect(await session.reapCommands('stale', 'x')).toHaveLength(0);
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(await session.backgroundWorkRunning()).toBe(true);
      // An explicit stop is not the policy's: Esc ends it by pid.
      const stopped = await session.reapCommands('all', 'stopped by the user');
      expect(stopped).toHaveLength(1);
      await vi.waitFor(() => expect(processAlive(command!.pid)).toBe(false), { timeout: 5_000 });
    } finally { await session.close(); }
  });
});
