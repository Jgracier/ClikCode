/** What a vendor leaves in its process group when it exits: reaped (SIGTERM,
 * then SIGKILL), unless the conversation retired the process with work still
 * running in it -- that work runs on, told when it ends, up to the abandoned-
 * work ceiling, after which it is told as cut off and the group closed. A
 * process table that cannot be read ends nothing. Driven by real children. */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { JsonRpcPeer } from './jsonrpc-peer.js';
import { createAcpSession } from './acp-client.js';
import { processGroupMembers } from './process-group.js';
import type { EndedWork } from './handoff-work.js';

const reads = vi.hoisted(() => ({ fail: false }));
vi.mock('./process-group.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./process-group.js')>();
  return { ...actual, readProcessGroup: async (...args: Parameters<typeof actual.readProcessGroup>) => reads.fail ? undefined : actual.readProcessGroup(...args) };
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const members = async (pgid: number): Promise<number> => (await processGroupMembers(pgid)).size;

describe.skipIf(process.platform !== 'linux')('a vendor\'s process group when the vendor exits', () => {
  it('is reaped: what the leader left in it does not run on', async () => {
    const pidFile = join(tmpdir(), `reap-${process.pid}-${Date.now()}`);
    const child = spawn('sh', ['-c', `sleep 60 & echo $! > ${pidFile}; sleep 0.2`], { detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const peer = new JsonRpcPeer(child, { label: 'fake', detached: true, forwardParentSignals: false });
    await peer.waitForExit();
    expect(Number(await readFile(pidFile, 'utf8'))).toBeGreaterThan(0);
    await vi.waitFor(async () => expect(await members(child.pid!)).toBe(0), { timeout: 5_000 });
  });

  it('is kept while asked to, and reaped once let go', async () => {
    const child = spawn('sh', ['-c', 'sleep 60 & sleep 0.2'], { detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const peer = new JsonRpcPeer(child, { label: 'fake', detached: true, forwardParentSignals: false });
    peer.keepGroup();
    try {
      await peer.waitForExit();
      await sleep(2_500);
      expect(await members(child.pid!)).toBe(1);
      peer.keepGroup(false);
      await vi.waitFor(async () => expect(await members(child.pid!)).toBe(0), { timeout: 5_000 });
    } finally { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ } }
  });
});

/** An agent whose prompt leaves `command` running in a shell (a tool call's background job) and
 * answers. */
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

async function retired(command: string, retiredCeilingMs: number) {
  const ended: EndedWork[] = [];
  const spawned: number[] = [];
  const session = createAcpSession({
    retiredCeilingMs, workEnded: (work) => { ended.push(...work); },
    spawn: (binary, argv, options) => { const child = spawn(binary, [...argv], options); spawned.push(child.pid!); return child; },
  });
  expect((await session.runTurn({ binary: process.execPath, command: 'fake', argv: ['-e', agent(command)], cwd: process.cwd(), prompt: 'go', environment: {}, permissionMode: 'ask' })).text).toBe('ok');
  await vi.waitFor(async () => expect(await session.backgroundWorkRunning()).toBe(true), { timeout: 5_000 });
  expect(await session.retire()).toBe(true);
  return { session, ended, leader: spawned[0]! };
}

describe.skipIf(process.platform !== 'linux')('a retired vendor process', () => {
  it('keeps its work running after the vendor exits, until the ceiling cuts it off and closes the group', async () => {
    const { session, ended, leader } = await retired('sleep 60; echo done', 6_000);
    try {
      process.kill(leader, 'SIGKILL');
      await sleep(3_000);
      // The vendor is gone; its command runs on, held for the conversation.
      expect(await members(leader)).toBeGreaterThan(0);
      expect(session.retiredWork).toEqual({ agents: 0, terminals: 1 });
      expect(ended).toEqual([]);
      await vi.waitFor(() => expect(ended).toHaveLength(1), { timeout: 8_000 });
      expect(ended[0]).toMatchObject({ kind: 'command', label: 'sleep 60; echo done', outcome: 'cut-off' });
      expect(ended[0]!.tail).toMatch(/^Stopped: it was still running/);
      await vi.waitFor(async () => expect(await members(leader)).toBe(0), { timeout: 5_000 });
      expect(session.retiredWork).toEqual({ agents: 0, terminals: 0 });
    } finally {
      await session.close();
      try { process.kill(-leader, 'SIGKILL'); } catch { /* already gone */ }
    }
  }, 30_000);

  it('ends nothing on a process table it could not read, and tells the end once it can', async () => {
    const { session, ended, leader } = await retired('sleep 1; echo done', 60_000);
    try {
      reads.fail = true;
      await sleep(4_500);
      // The command has ended, but nobody could see it: not told, still held.
      expect(ended).toEqual([]);
      expect(session.retiredWork.terminals).toBe(1);
      reads.fail = false;
      await vi.waitFor(() => expect(ended).toHaveLength(1), { timeout: 8_000 });
      expect(ended[0]).toMatchObject({ kind: 'command', outcome: 'finished' });
    } finally {
      reads.fail = false;
      await session.close();
      try { process.kill(-leader, 'SIGKILL'); } catch { /* already gone */ }
    }
  }, 30_000);
});
