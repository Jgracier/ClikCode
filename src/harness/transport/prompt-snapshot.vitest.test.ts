/** The process group a turn compares against is read before its prompt goes
 * out. That scan reads every process on the machine, and standing between the
 * turn's setup and the prompt it was the largest wait ClikCode itself owned on
 * a warm turn (about 35 ms measured). Read when the turn is accepted, it
 * overlaps the setup; the prompt still never goes out before it is known. */
import { afterEach, describe, expect, it, vi } from 'vitest';

const scans: Array<{ at: number; done: number }> = [];
vi.mock('./process-group.js', async (original) => ({
  ...(await original<typeof import('./process-group.js')>()),
  processGroupMembers: vi.fn(async (pid: number) => {
    const scan = { at: Date.now(), done: 0 };
    scans.push(scan);
    await new Promise((resolve) => setTimeout(resolve, 60));
    scan.done = Date.now();
    return new Set([pid]);
  }),
}));

const { createAcpSession } = await import('./acp-client.js');

const agent = `
  const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
  let buf = '';
  process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
    else if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 's1' } });
    else if (m.method === 'session/prompt') {
      send({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } } } });
      send({ id: m.id, result: { stopReason: 'end_turn' } });
    }
  } });
`;

describe.skipIf(process.platform === 'win32')('the group read ahead of the prompt', () => {
  const sessions: Array<ReturnType<typeof createAcpSession>> = [];
  afterEach(async () => { scans.length = 0; await Promise.all(sessions.splice(0).map((session) => session.close())); });
  const run = (session: ReturnType<typeof createAcpSession>) => session.runTurn({
    binary: process.execPath, command: 'fake', argv: ['-e', agent], cwd: process.cwd(), prompt: 'hello', environment: {}, permissionMode: 'ask',
  });

  it('is used by the prompt, which then reads nothing a second time', async () => {
    const session = createAcpSession({});
    sessions.push(session);
    await run(session);
    scans.length = 0;
    // Turn accepted: the group is read now.
    const started = Date.now();
    session.prefetchGroup();
    expect(scans).toHaveLength(1);
    await run(session);
    // One read ahead of the prompt, one when the turn ended (what it left
    // running): the prompt did not read a third time.
    await vi.waitFor(() => expect(scans).toHaveLength(2));
    expect(scans[0]!.at).toBeLessThanOrEqual(started + 5);
    expect(scans[1]!.at).toBeGreaterThanOrEqual(scans[0]!.done);
  }, 20_000);

  it('reads at the prompt when nothing was read ahead, and the turn waits for it', async () => {
    const session = createAcpSession({});
    sessions.push(session);
    await run(session);
    await vi.waitFor(() => expect(scans).toHaveLength(2));
    scans.length = 0;
    const started = Date.now();
    await run(session);
    expect(scans[0]!.at).toBeGreaterThanOrEqual(started);
    expect(scans[0]!.done).toBeGreaterThan(0);
  }, 20_000);

  it('does nothing before there is a vendor to read, or while a turn runs', async () => {
    const session = createAcpSession({});
    sessions.push(session);
    session.prefetchGroup();
    expect(scans).toHaveLength(0);
  });
});
