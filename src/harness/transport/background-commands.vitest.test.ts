/** Background commands by pid: how a status line names them, when the policy calls one stale, and how a
 * tracked command is ended (its own group, never the vendor's; never by name). Real children. */
import { spawn } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { CommandSampler, KEEP_MARK, describeCommands, formatAge, killCommand, staleVerdict, type CommandPolicy } from './background-commands.js';
import { createAcpSession } from './acp-client.js';
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
  it('says what is being waited on: label, age, cpu and silence', () => {
    const now = 1_000_000_000_000;
    expect(describeCommands([{ pid: 9, label: 'node scripts/pre-push-related.mjs --all', startedAt: now - 32 * HOUR, cpuPercent: 100 }], now))
      .toBe('waiting on background command: node scripts/pre-push-related.mjs --all · running 32h · cpu 100% · no output');
    expect(describeCommands([{ pid: 9, label: 'a', startedAt: now - 60_000, lastOutputAt: now - 5_000 }, { pid: 10, label: 'b', startedAt: now - 5_000 }], now))
      .toBe('waiting on background command: a · running 1m · output 5s ago · +1 more');
    expect(describeCommands([], now)).toBeUndefined();
    expect(formatAge(90 * 60_000)).toBe('1h 30m');
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

async function leaving(command: string, commandPolicy: CommandPolicy) {
  const session = createAcpSession({ commandWatchMs: 150, commandPolicy });
  const turn = await session.runTurn({
    binary: process.execPath, command: 'fake', argv: ['-e', agent(command)], cwd: process.cwd(), prompt: 'go', environment: {}, permissionMode: 'ask',
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
