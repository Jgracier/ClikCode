/** A background command a sub-agent started does not outlive that sub-agent: when it ends, the command is ended by
 * pid (found by the task's output file), unless it asked to be kept. The agent is a real child that speaks the
 * `_claude/sdkMessage` frames claude-agent-acp sends. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAcpSession } from './acp-client.js';
import { processAlive } from './process-group.js';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'owned-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

/** The agent: its prompt starts the shell `command` (output in a file named for task `tk`), says a sub-agent `ag` owns it,
 * answers, and 1.2 s later the sub-agent ends (`ownerEnds`) or stays. */
const agent = (command: string, outFile: string, ownerEnds: boolean): string => `
  const { spawn } = require('node:child_process');
  const fs = require('node:fs');
  const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
  const frame = (message) => send({ method: '_claude/sdkMessage', params: { sessionId: 's1', message } });
  let buf = '';
  process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    else if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 's1' } });
    else if (m.method === 'session/prompt') {
      const out = fs.openSync(${JSON.stringify(outFile)}, 'w');
      spawn('sh', ['-c', ${JSON.stringify(command)}], { stdio: ['ignore', out, 'ignore'] });
      send({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'tool_call', toolCallId: 'b', title: 'Run (background)', kind: 'execute', status: 'completed' } } });
      frame({ type: 'system', subtype: 'task_started', task_id: 'ag1', task_type: 'local_agent', description: 'helper', is_backgrounded: true });
      frame({ type: 'system', subtype: 'task_started', task_id: 'tkowned1', task_type: 'local_bash', description: 'spin', owned_by_subagent: true, parent_task_id: 'ag1' });
      frame({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'ag1', task_type: 'local_agent', description: 'helper' }, { task_id: 'tkowned1', task_type: 'local_bash', description: 'spin', parent_task_id: 'ag1' }] });
      setTimeout(() => { send({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } } } }); send({ id: m.id, result: { stopReason: 'end_turn' } }); }, 300);
      if (${ownerEnds}) setTimeout(() => {
        frame({ type: 'system', subtype: 'task_notification', task_id: 'ag1', status: 'completed', summary: 'done' });
        frame({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'tkowned1', task_type: 'local_bash', description: 'spin', parent_task_id: 'ag1' }] });
      }, 1500);
    }
  } });
`;

async function run(command: string, ownerEnds: boolean) {
  const session = createAcpSession({ commandWatchMs: 200, backgroundTurns: () => undefined });
  await session.runTurn({ binary: process.execPath, command: 'fake', argv: ['-e', agent(command, join(dir, 'tkowned1.output'), ownerEnds)], cwd: process.cwd(), prompt: 'go', environment: {}, permissionMode: 'ask' });
  let pid = 0;
  await vi.waitFor(async () => { const [first] = await session.backgroundCommands(); expect(first).toBeDefined(); pid = first!.pid; }, { timeout: 5_000 });
  return { session, pid };
}

describe.skipIf(process.platform !== 'linux')('a command a sub-agent started', () => {
  it('is ended by its pid when the sub-agent ends', async () => {
    const { session, pid } = await run('sleep 71; true', true);
    try {
      expect(processAlive(pid)).toBe(true);
      await vi.waitFor(() => expect(processAlive(pid)).toBe(false), { timeout: 8_000 });
    } finally { await session.close(); }
  });

  it('is left alone while its sub-agent runs', async () => {
    const { session, pid } = await run('sleep 72; true', false);
    try {
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      expect(processAlive(pid)).toBe(true);
    } finally { await session.reapCommands('all', 'test cleanup'); await session.close(); }
  });

  it('survives its sub-agent when it carries the keep mark', async () => {
    const { session, pid } = await run('sleep 73; true # clikcode:keep', true);
    try {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      expect(processAlive(pid)).toBe(true);
    } finally { await session.reapCommands('all', 'test cleanup'); await session.close(); }
  }, 20_000);
});
