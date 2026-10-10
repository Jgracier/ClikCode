/** An agent that cannot find the thread it was asked to load says so, and the turn treats that
 * as a lost thread (start fresh, retell) rather than an `other` failure that stops every turn.
 * Driven by a real child speaking ACP. Claude Code's wording, verbatim from chat de679bc3. */
import { expect, it } from 'vitest';
import { createAcpSession, markMissingThread } from './acp-client.js';
import { classifyAccountFailure } from '../../turn/failover.js';

const agent = (resume: boolean, error: { code: number; message: string }) => `
  const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
  let buf = '';
  process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: ${resume ? '{ resume: {} }' : '{}'} } } });
    else if (m.method === 'session/resume' || m.method === 'session/load') send({ id: m.id, error: ${JSON.stringify(error)} });
  } });
`;

async function failure(resume: boolean, error: { code: number; message: string }): Promise<unknown> {
  const session = createAcpSession();
  try {
    await session.runTurn({
      binary: process.execPath, command: 'fake', argv: ['-e', agent(resume, error)], cwd: process.cwd(), prompt: 'go',
      environment: {}, permissionMode: 'ask', nativeSessionId: 'de679bc3-gone',
    });
    return undefined;
  } catch (caught) {
    return caught;
  } finally {
    await session.close();
  }
}

it('Claude Code resume of a thread it lost is native-thread-invalid', async () => {
  const caught = await failure(true, { code: -32002, message: 'Resource not found: de679bc3-gone' });
  expect(classifyAccountFailure(caught)).toBe('native-thread-invalid');
});

it('any agent whose load names the wanted id as not found is native-thread-invalid', async () => {
  const caught = await failure(false, { code: -32603, message: 'Internal error: session de679bc3-gone not found' });
  expect(classifyAccountFailure(caught)).toBe('native-thread-invalid');
});

it('a load failing for another reason is left to the other signals', async () => {
  const caught = await failure(false, { code: -32603, message: 'Internal error: 401 Unauthorized' });
  expect(classifyAccountFailure(caught)).toBe('authentication-required');
  expect(markMissingThread(new Error('model not found'), 'x')).not.toHaveProperty('nativeThreadInvalid');
});
