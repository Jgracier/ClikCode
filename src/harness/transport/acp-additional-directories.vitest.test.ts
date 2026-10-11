/** /add-dir over ACP: the directories ride session/new|resume when the agent advertises the capability. */
import { expect, it } from 'vitest';
import { createAcpSession } from './acp-client.js';

const agent = (advertise: boolean) => `
  const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
  let buf = '';
  process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: ${advertise ? '{ additionalDirectories: {}, resume: {} }' : '{}'} } } });
    else if (m.method === 'session/new' || m.method === 'session/resume') send({ id: m.id, error: { code: -32603, message: 'SEEN ' + JSON.stringify(m.params.additionalDirectories) } });
  } });
`;

const run = async (advertise: boolean, nativeSessionId?: string): Promise<string> => {
  const session = createAcpSession();
  try {
    await session.runTurn({
      binary: process.execPath, command: 'fake', argv: ['-e', agent(advertise)], cwd: process.cwd(), prompt: 'go', environment: {},
      permissionMode: 'ask', additionalDirectories: ['/tmp/extra'], ...(nativeSessionId ? { nativeSessionId } : {}),
    });
    return '';
  } catch (caught) {
    return String((caught as Error).message);
  } finally {
    await session.close();
  }
};

it('sends additionalDirectories with session/new and session/resume when advertised', async () => {
  expect(await run(true)).toContain('SEEN ["/tmp/extra"]');
  expect(await run(true, 'S1')).toContain('SEEN ["/tmp/extra"]');
});

it('refuses, naming /add-dir, an agent that does not advertise it', async () => {
  expect(await run(false)).toContain('does not accept additional directories');
});
