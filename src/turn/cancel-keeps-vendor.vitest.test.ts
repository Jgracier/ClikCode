/** Stopping a turn cancels that turn, not the vendor: the next turn runs on
 * the same warm child (and so the same MCP servers), while a real failure
 * still drops it. Driven through runVendorSessionAttempt with a real child
 * speaking ACP that answers a cancel with stopReason `cancelled`. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runVendorSessionAttempt } from './vendor-session-attempt.js';
import { closePersistentTransport } from './vendor-process.js';
import { isTurnCancelled, turnCancelledError } from '../agent/cancellation.js';
import type { AiHarnessAccount, AiLocalHarnessDefinition } from '../harness/definition.js';
import type { HarnessSession } from '../session/model.js';

const agent = (log: string) => `
  const fs = require('node:fs');
  const log = (line) => fs.appendFileSync(${JSON.stringify(log)}, line + '\\n');
  const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
  log('spawn ' + process.pid);
  let prompts = 0; let open;
  let buf = '';
  process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
    else if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 's1' } });
    else if (m.method === 'session/load') send({ id: m.id, result: {} });
    else if (m.method === 'session/cancel') { log('cancel'); if (open !== undefined) { send({ id: open, result: { stopReason: 'cancelled' } }); open = undefined; } }
    else if (m.method === 'session/prompt') {
      prompts += 1;
      const text = m.params.prompt[0].text;
      log('prompt ' + text);
      send({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'pid ' + process.pid + ' ' } } } });
      if (text === 'fail') { send({ id: m.id, error: { code: -32603, message: 'boom' } }); continue; }
      if (text === 'hang') { open = m.id; continue; }
      send({ id: m.id, result: { stopReason: 'end_turn' } });
    }
  } });
`;

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cancel-keeps-vendor-')); });
afterEach(async () => { await closePersistentTransport(); rmSync(dir, { recursive: true, force: true }); });

function attempt(log: string, session: HarnessSession, text: string, signal?: AbortSignal) {
  const harness = {
    command: 'fakeacp', displayName: 'Fake ACP', provider: 'fake', binary: process.execPath,
    transport: 'acp', acp: { binary: process.execPath, argv: ['-e', agent(log)], inheritCliOptions: false },
  } as unknown as AiLocalHarnessDefinition;
  const account = { id: 'acct', provider: 'fake', harness: 'fakeacp' } as unknown as AiHarnessAccount;
  return runVendorSessionAttempt({
    harness, account, session, transport: 'acp', turnText: text, model: null, environment: {}, images: [], signal,
    run: { persistentTransports: true } as never,
    checkpoint: { unqueueSoon: () => undefined, steer: async () => undefined, persistNow: async () => undefined } as never,
    sharedObserver: {},
    onSessionId: async (id) => { session.nativeSessionId = id; },
    runCli: async () => { throw new Error('no CLI'); },
  });
}

const spawns = (log: string): string[] => readFileSync(log, 'utf8').split('\n').filter((line) => line.startsWith('spawn'));

describe('a cancelled ACP turn', () => {
  it('keeps the warm vendor: the next turn reuses the same process', async () => {
    const log = join(dir, 'log');
    const session = { id: 'cancel-keeps-1', workspace: process.cwd(), permissionMode: 'ask' } as unknown as HarnessSession;
    await attempt(log, session, 'first');
    const controller = new AbortController();
    const hung = attempt(log, session, 'hang', controller.signal);
    setTimeout(() => controller.abort(), 300);
    await expect(hung).rejects.toMatchObject({ code: 'ERR_TURN_CANCELLED' });
    await attempt(log, session, 'after');
    const lines = readFileSync(log, 'utf8');
    expect(lines).toContain('cancel');
    expect(lines).toContain('prompt after');
    expect(spawns(log)).toHaveLength(1);
  });

  it('still drops the vendor after a real failure', async () => {
    const log = join(dir, 'log');
    const session = { id: 'cancel-keeps-2', workspace: process.cwd(), permissionMode: 'ask' } as unknown as HarnessSession;
    await attempt(log, session, 'first');
    await expect(attempt(log, session, 'fail')).rejects.toThrow();
    await attempt(log, session, 'after');
    expect(spawns(log)).toHaveLength(2);
  });
});

describe('isTurnCancelled (what keeps the warm vendor child)', () => {
  it('is a cancel or an abort, nothing else', () => {
    expect(isTurnCancelled(turnCancelledError())).toBe(true);
    expect(isTurnCancelled(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(true);
    expect(isTurnCancelled(new Error('boom'))).toBe(false);
    expect(isTurnCancelled(undefined)).toBe(false);
  });
});
