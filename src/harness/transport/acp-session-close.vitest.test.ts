/** A process that is handed another session closes the one it had open: an agent keeps every
 * session until told otherwise (claude-agent-acp runs a whole Claude CLI per session). Driven by
 * a real child speaking ACP, which records the requests it was sent. */
import { expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAcpSession } from './acp-client.js';

const agent = (log: string, close: boolean) => `
  const fs = require('node:fs');
  const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
  let buf = '';
  process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (m.method) fs.appendFileSync(${JSON.stringify(log)}, m.method + ' ' + (m.params?.sessionId ?? '') + '\\n');
    if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: ${close ? '{ close: {} }' : '{}'} } } });
    else if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 's1' } });
    else if (m.method === 'session/load' || m.method === 'session/close') send({ id: m.id, result: {} });
    else if (m.method === 'session/prompt') {
      send({ method: 'session/update', params: { sessionId: m.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } } } });
      send({ id: m.id, result: { stopReason: 'end_turn' } });
    }
  } });
`;

async function requests(close: boolean): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), 'acp-close-'));
  const log = join(dir, 'requests');
  const session = createAcpSession();
  const turn = (nativeSessionId?: string) => session.runTurn({
    binary: process.execPath, command: 'fake', argv: ['-e', agent(log, close)], cwd: process.cwd(), prompt: 'go',
    environment: {}, permissionMode: 'ask', ...(nativeSessionId ? { nativeSessionId } : {}),
  });
  try {
    await turn();
    await turn('s2');
    await turn('s2');
    return readFileSync(log, 'utf8').trim().split('\n').filter((line) => !line.startsWith('initialize'));
  } finally {
    await session.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

it('closes the session it had open before loading another, once', async () => {
  expect(await requests(true)).toEqual([
    'session/new ', 'session/prompt s1',
    'session/close s1', 'session/load s2', 'session/prompt s2',
    'session/prompt s2',
  ]);
});

it('asks nothing of an agent that cannot close a session', async () => {
  expect(await requests(false)).toEqual(['session/new ', 'session/prompt s1', 'session/load s2', 'session/prompt s2', 'session/prompt s2']);
});
