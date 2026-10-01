/** Text an ACP agent sends after a tool call starts a new paragraph. Driven by
 * a real child speaking ACP. */
import { expect, it } from 'vitest';
import { createAcpSession } from './acp-client.js';

const agent = `
  const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
  const update = (u) => send({ method: 'session/update', params: { sessionId: 's1', update: u } });
  const text = (t) => update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } });
  let buf = '';
  process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    else if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 's1' } });
    else if (m.method === 'session/prompt') {
      text('Checking the '); text('workspace first.');
      update({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'git log', kind: 'execute', status: 'in_progress' });
      update({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' });
      text('The final '); text('commit is live.');
      send({ id: m.id, result: { stopReason: 'end_turn' } });
    }
  } });
`;

it('starts the text after a tool call on a new paragraph', async () => {
  const session = createAcpSession();
  let streamed = '';
  try {
    const result = await session.runTurn({
      binary: process.execPath, command: 'fake', argv: ['-e', agent], cwd: process.cwd(), prompt: 'go',
      environment: {}, permissionMode: 'ask', onResponseDelta: (delta) => { streamed += delta; },
    });
    expect(result.text).toBe('Checking the workspace first.\n\nThe final commit is live.');
    expect(streamed).toBe(result.text);
  } finally { await session.close(); }
});
