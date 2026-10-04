/** Work a persistent vendor leaves running between turns -- a background
 * shell under ACP answers its tool call at once, and nothing in the protocol
 * says it still runs -- is seen in the vendor's process group, so the worker
 * keeps the vendor up for it. Driven by a real child speaking ACP. */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAcpSession } from './acp-client.js';
import { processGroupMembers } from './process-group.js';

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

describe.skipIf(process.platform === 'win32')('work an ACP vendor leaves running between turns', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'clikcode-bg-work-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  /** An agent that starts a helper of its own at session/new (as MCP servers
   * are) and, for the prompt, a background `sleep` it answers at once about. */
  const agent = (pidFile: string): string => `
    const { spawn } = require('node:child_process');
    const fs = require('node:fs');
    const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
    let buf = '';
    process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
      else if (m.method === 'session/new') { spawn('sleep', ['60'], { stdio: 'ignore' }); send({ id: m.id, result: { sessionId: 's1' } }); }
      else if (m.method === 'session/prompt') {
        const job = spawn('sleep', ['60'], { stdio: 'ignore' });
        fs.writeFileSync(${JSON.stringify(pidFile)}, String(job.pid));
        send({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'tool_call', toolCallId: 'b', title: 'Run dev server (background)', kind: 'execute', status: 'completed' } } });
        send({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'started it' } } } });
        send({ id: m.id, result: { stopReason: 'end_turn' } });
      }
    } });
  `;

  it('counts the background job, not the vendor\'s own helpers, until it ends', async () => {
    const pidFile = join(dir, 'job.pid');
    const session = createAcpSession({});
    try {
      expect(await session.backgroundWorkRunning()).toBe(false);
      const result = await session.runTurn({
        binary: process.execPath, command: 'fake', argv: ['-e', agent(pidFile)], cwd: process.cwd(), prompt: 'start the dev server',
        environment: {}, permissionMode: 'ask',
      });
      expect(result.text).toBe('started it');
      await vi.waitFor(async () => expect(await session.backgroundWorkRunning()).toBe(true), { timeout: 5_000 });
      process.kill(Number(await readFile(pidFile, 'utf8')), 'SIGKILL');
      // The helper started at session/new is still running: it is not work.
      await vi.waitFor(async () => expect(await session.backgroundWorkRunning()).toBe(false), { timeout: 5_000 });
    } finally { await session.close(); }
  }, 20_000);
});
