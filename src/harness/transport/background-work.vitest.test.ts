/** Work a persistent vendor leaves running between turns -- a background
 * shell under ACP answers its tool call at once, and nothing in the protocol
 * says it still runs -- is seen in the vendor's process group, so the worker
 * keeps the vendor up for it. The vendor's own helpers in that group (MCP
 * servers it starts lazily at the first prompt, an idle shell it keeps) are
 * not work. Driven by a real child speaking ACP. */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAcpSession } from './acp-client.js';
import { processGroupMembers, toolCallWork, type GroupProcess } from './process-group.js';

describe.skipIf(process.platform === 'win32')('a vendor\'s process group', () => {
  it('lists the vendor and what it started, and nothing else', async () => {
    const child = spawn('sh', ['-c', 'sleep 30 & sleep 30'], { detached: true, stdio: 'ignore' });
    try {
      await vi.waitFor(async () => expect((await processGroupMembers(child.pid!)).size).toBe(3), { timeout: 5_000 });
      expect((await processGroupMembers(child.pid!)).has(child.pid!)).toBe(true);
      expect((await processGroupMembers(process.pid)).has(child.pid!)).toBe(false);
    } finally { process.kill(-child.pid!, 'SIGKILL'); }
  });
});

describe('what counts as work a tool call left running', () => {
  const group = (entries: Array<[number, number, string]>): Map<number, GroupProcess> => new Map(entries.map(([pid, ppid, name]) => [pid, { ppid, name }]));
  // 10 is the vendor. 11 an MCP server it started at the first prompt, 12
  // what that server runs, 13 an idle shell it keeps, 14 a `bash -c` it ran
  // for a tool call and 15 the dev server under it, 16 a `nohup` job whose
  // shell exited, 17 the Claude CLI under claude-agent-acp with 18 its MCP
  // server and 19 its background bash running 20.
  const tree = group([
    [10, 1, 'copilot'], [11, 10, 'node'], [12, 11, 'node'], [13, 10, 'bash'], [14, 10, 'bash'], [15, 14, 'node'], [16, 1, 'sleep'],
    [17, 10, 'claude'], [18, 17, 'node'], [19, 17, 'bash'], [20, 19, 'sleep'],
  ]);
  const all = new Set([11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);

  it('counts what runs below a shell the turn started, and orphaned jobs', () => {
    expect([...toolCallWork(tree, 10, all)].sort((a, b) => a - b)).toEqual([15, 16, 20]);
  });
  it('never counts the vendor\'s helpers, or a shell with nothing running under it', () => {
    expect(toolCallWork(tree, 10, new Set([11, 12, 13, 17, 18])).size).toBe(0);
  });
  it('a shell from before the turn (a launcher) does not make its children work', () => {
    const launched = group([[10, 1, 'sh'], [11, 10, 'node'], [12, 11, 'node']]);
    expect(toolCallWork(launched, 10, new Set([12])).size).toBe(0);
    expect(toolCallWork(group([[5, 1, 'sh'], [10, 5, 'node'], [12, 10, 'node']]), 5, new Set([12])).size).toBe(0);
  });
});

describe.skipIf(process.platform === 'win32')('work an ACP vendor leaves running between turns', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'clikcode-bg-work-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  /** An agent that starts a helper at session/new and, lazily at the first
   * prompt, an MCP-like server and an idle shell of its own (as Copilot
   * does); a prompt naming a job runs it for a tool call it answers at once
   * about, and writes the job's pid. */
  const agent = (pidFile: string): string => `
    const { spawn } = require('node:child_process');
        const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
    const jobs = {
      'run the dev server': ['sh', ['-c', 'sleep 60 & echo $! > ' + ${JSON.stringify(pidFile)} + '; wait']],
      'start it with nohup': ['sh', ['-c', 'sleep 61 & echo $! > ' + ${JSON.stringify(pidFile)}]],
    };
    let first = true;
    let buf = '';
    process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
      else if (m.method === 'session/new') { spawn('sleep', ['60'], { stdio: 'ignore' }); send({ id: m.id, result: { sessionId: 's1' } }); }
      else if (m.method === 'session/prompt') {
        if (first) {
          first = false;
          spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['pipe', 'pipe', 'ignore'] });
          spawn('sh', [], { stdio: ['pipe', 'ignore', 'ignore'] });
        }
        const text = JSON.stringify(m.params.prompt);
        const job = Object.keys(jobs).find((name) => text.includes(name));
        if (job) {
          spawn(...jobs[job], { stdio: 'ignore' });
          send({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'tool_call', toolCallId: 'b', title: 'Run (background)', kind: 'execute', status: 'completed' } } });
        }
        const answer = () => { send({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } } } });
          send({ id: m.id, result: { stopReason: 'end_turn' } }); };
        // Once the job has written its pid (and, with nohup, its shell is gone).
        setTimeout(answer, job ? 300 : 0);
      }
    } });
  `;

  const turn = (session: ReturnType<typeof createAcpSession>, pidFile: string, prompt: string) => session.runTurn({
    binary: process.execPath, command: 'fake', argv: ['-e', agent(pidFile)], cwd: process.cwd(), prompt, environment: {}, permissionMode: 'ask',
  });
  /** Long enough for the turn's left-running scan to have finished. */
  const settled = async (session: ReturnType<typeof createAcpSession>): Promise<boolean> => {
    let running = false;
    for (let i = 0; i < 10; i += 1) { running = await session.backgroundWorkRunning(); await new Promise((resolve) => setTimeout(resolve, 50)); }
    return running;
  };

  it('does not count the MCP servers and idle shell a vendor starts at the first prompt', async () => {
    const session = createAcpSession({});
    try {
      expect((await turn(session, join(dir, 'job.pid'), 'hello')).text).toBe('ok');
      expect(await settled(session)).toBe(false);
    } finally { await session.close(); }
  }, 20_000);

  it('counts a background command a tool call left running, until it ends', async () => {
    const pidFile = join(dir, 'job.pid');
    const session = createAcpSession({});
    try {
      await turn(session, pidFile, 'hello');
      expect(await settled(session)).toBe(false);
      await turn(session, pidFile, 'run the dev server');
      await vi.waitFor(async () => expect(await session.backgroundWorkRunning()).toBe(true), { timeout: 5_000 });
      // Its shell waits on it, and exits with it.
      process.kill(Number(await readFile(pidFile, 'utf8')), 'SIGKILL');
      await vi.waitFor(async () => expect(await session.backgroundWorkRunning()).toBe(false), { timeout: 5_000 });
    } finally { await session.close(); }
  }, 20_000);

  it('counts a job whose shell exited (nohup), until it ends', async () => {
    const pidFile = join(dir, 'job.pid');
    const session = createAcpSession({});
    try {
      await turn(session, pidFile, 'start it with nohup');
      await vi.waitFor(async () => expect(await session.backgroundWorkRunning()).toBe(true), { timeout: 5_000 });
      process.kill(Number(await readFile(pidFile, 'utf8')), 'SIGKILL');
      await vi.waitFor(async () => expect(await session.backgroundWorkRunning()).toBe(false), { timeout: 5_000 });
      // The helpers it started at the first prompt are still running.
      expect(await settled(session)).toBe(false);
    } finally { await session.close(); }
  }, 20_000);
});
