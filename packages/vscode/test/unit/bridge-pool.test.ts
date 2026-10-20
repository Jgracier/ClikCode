import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgePool } from '../../src/bridge-pool';
import type { BridgeEndpoint } from '../../src/bridge-client';
import type { IdeEvent } from '../../src/protocol';
import type { Runtime } from '../../src/runtime';

/** A stand-in `ide-bridge`: shares itself when asked (CLIKCODE_IDE_MULTIPLEX),
 * unless FAKE_OLD says it is a ClikCode from before that. Every start, and
 * every chat it closes, is written down. */
const FAKE = `
const fs = require('node:fs');
if (process.argv[2] !== 'ide-bridge') process.exit(2);
fs.appendFileSync(process.env.FAKE_LOG, 'start ' + process.pid + '\\n');
const shared = process.env.CLIKCODE_IDE_MULTIPLEX === '1' && !process.env.FAKE_OLD;
const answer = (chat, request) => {
  if (request.type === 'open') return { type: 'result', requestId: request.requestId, ok: true, data: { chat, pid: process.pid } };
  if (request.type === 'query') return { type: 'result', requestId: request.requestId, ok: true, data: request.query };
};
if (shared) {
  process.send({ type: 'host-ready', version: 't', protocol: 1, revision: 2, pid: process.pid });
  process.on('message', (m) => {
    if (m.type === 'chat-attach') process.send({ type: 'chat', chat: m.chat, event: { type: 'ready', version: 't', protocol: 1, revision: 2, pid: process.pid } });
    if (m.type !== 'chat') return;
    if (m.request.type === 'close') { fs.appendFileSync(process.env.FAKE_LOG, 'close ' + m.chat + '\\n'); process.send({ type: 'chat-closed', chat: m.chat }); return; }
    if (m.request.type === 'visible') fs.appendFileSync(process.env.FAKE_LOG, 'visible ' + m.chat + '\\n');
    const reply = answer(m.chat, m.request);
    if (reply) process.send({ type: 'chat', chat: m.chat, event: reply });
  });
} else {
  process.send({ type: 'ready', version: 't', protocol: 1, revision: 2, pid: process.pid });
  process.on('message', (m) => {
    if (m.type === 'close') { process.exit(0); }
    const reply = answer('own', m);
    if (reply) process.send(reply);
  });
}
process.on('disconnect', () => process.exit(0));
`;

let open: BridgeEndpoint[] = [];
afterEach(() => { for (const bridge of open) bridge.dispose(); open = []; });

function fixture(env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'clikcode-fake-pool-'));
  const entry = join(dir, 'index.js');
  writeFileSync(entry, FAKE);
  const log = join(dir, 'log');
  const runtime: Runtime = { node: process.execPath, env: { FAKE_LOG: log, ...env }, entry, nodeSource: 'path', entrySource: 'path' };
  const lines = (): string[] => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
  const starts = (): number[] => lines().filter((line) => line.startsWith('start ')).map((line) => Number(line.slice(6)));
  const pool = new BridgePool();
  const connect = (shared = true): BridgeEndpoint => { const bridge = pool.connect(runtime, dir, shared); open.push(bridge); return bridge; };
  return { dir, pool, connect, lines, starts };
}

const ready = (bridge: BridgeEndpoint): Promise<IdeEvent> => new Promise((resolve) => bridge.on('event', (event) => { if (event.type === 'ready') resolve(event); }));
const exited = (bridge: BridgeEndpoint): Promise<unknown> => new Promise((resolve) => bridge.once('exit', resolve));
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('the window\'s bridge pool', () => {
  it('serves every chat from one process, each with its own ready, requests and results', async () => {
    const { connect, starts, lines, pool } = fixture();
    const a = connect();
    // Said before the process is up: kept, and delivered once it is.
    a.send({ type: 'visible', visible: true });
    const b = connect();
    await Promise.all([ready(a), ready(b)]);
    expect(starts()).toHaveLength(1);
    expect(pool.sharedProcesses).toBe(1);
    const [fromA, fromB] = await Promise.all([
      a.call<{ chat: string; pid: number }>({ type: 'open', workspace: '/', mode: 'new' }),
      b.call<{ chat: string; pid: number }>({ type: 'open', workspace: '/', mode: 'new' }),
    ]);
    expect(fromA.pid).toBe(fromB.pid);
    expect(fromA.chat).not.toBe(fromB.chat);
    await expect(b.call({ type: 'query', query: 'providers' })).resolves.toBe('providers');
    expect(lines().filter((line) => line.startsWith('visible '))).toHaveLength(1);
  });

  it('closes a chat that leaves (a panel closed) and keeps the process for the others; the last one leaving ends it', async () => {
    const { connect, starts, lines, pool } = fixture();
    const a = connect();
    const b = connect();
    await Promise.all([ready(a), ready(b)]);
    const pid = starts()[0]!;
    const aGone = exited(a);
    a.dispose();
    await aGone;
    expect(a.running).toBe(false);
    expect(a.send({ type: 'cancel', restoreDraft: false })).toBe(false);
    await until(() => lines().some((line) => line.startsWith('close ')));
    expect(lines().filter((line) => line.startsWith('close '))).toHaveLength(1);
    expect(alive(pid)).toBe(true);
    await expect(b.call({ type: 'query', query: 'accounts' })).resolves.toBe('accounts');
    b.dispose();
    expect(pool.sharedProcesses).toBe(0);
    await until(() => !alive(pid));
    // The next chat starts a new process; it never joins one on its way out.
    const c = connect();
    await ready(c);
    expect(starts()).toHaveLength(2);
  });

  it('after a crash every chat reconnects into one new process, and nothing is left of the old one', async () => {
    const { connect, starts } = fixture();
    const a = connect();
    const b = connect();
    await Promise.all([ready(a), ready(b)]);
    const pid = starts()[0]!;
    const gone = Promise.all([exited(a), exited(b)]);
    process.kill(pid, 'SIGKILL');
    const [exitA] = await gone as Array<{ signal: string | null }>;
    expect(exitA!.signal).toBe('SIGKILL');
    expect(a.running || b.running).toBe(false);
    const a2 = connect();
    const b2 = connect();
    await Promise.all([ready(a2), ready(b2)]);
    expect(starts()).toHaveLength(2);
    expect(alive(pid)).toBe(false);
  });

  it('rejects what a chat was waiting on when the process dies', async () => {
    const { connect, starts } = fixture();
    const a = connect();
    await ready(a);
    const waiting = a.call({ type: 'choose', choice: { kind: 'gateway-credit' } });
    process.kill(starts()[0]!, 'SIGKILL');
    await expect(waiting).rejects.toThrow('ClikCode stopped');
  });

  it('gives each chat a process of its own when ClikCode cannot share, and when sharing is off', async () => {
    const old = fixture({ FAKE_OLD: '1' });
    const a = old.connect();
    const b = old.connect();
    await Promise.all([ready(a), ready(b)]);
    expect(old.starts()).toHaveLength(2);
    const [fromA, fromB] = await Promise.all([
      a.call<{ pid: number }>({ type: 'open', workspace: '/', mode: 'new' }),
      b.call<{ pid: number }>({ type: 'open', workspace: '/', mode: 'new' }),
    ]);
    expect(fromA.pid).not.toBe(fromB.pid);
    // Known now: the next chat goes straight to a process of its own.
    const c = old.connect();
    await ready(c);
    expect(old.starts()).toHaveLength(3);
    const aGone = exited(a);
    a.dispose();
    await aGone;
    await expect(b.call({ type: 'query', query: 'models' })).resolves.toBe('models');

    const off = fixture();
    const x = off.connect(false);
    const y = off.connect(false);
    await Promise.all([ready(x), ready(y)]);
    expect(off.starts()).toHaveLength(2);
  });
});
