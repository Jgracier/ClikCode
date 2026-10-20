import { afterEach, describe, expect, it } from 'vitest';
import type { AiHarnessAccount, AiLocalHarnessDefinition } from '../harness/definition.js';
import { closePersistentTransport, leavePersistentTransport, persistentTransports, persistentWorkRunning, vendorChildKey } from './vendor-process.js';

const harness = { command: 'codex' } as AiLocalHarnessDefinition;
const account: AiHarnessAccount = {
  id: 'a', provider: 'openai', label: 'a', authKind: 'vendor-cli', models: [], status: 'ready', credentialRef: 'native:codex',
  signedInAt: '2026-09-01T00:00:00.000Z',
};

describe('vendor child reuse', () => {
  it('reuses a child only while the account holds the same sign-in', () => {
    const key = vendorChildKey(harness, account, { CODEX_HOME: '/p' }, '/w');
    expect(vendorChildKey(harness, { ...account }, { CODEX_HOME: '/p' }, '/w')).toBe(key);
    expect(vendorChildKey(harness, { ...account, signedInAt: '2026-09-02T00:00:00.000Z' }, { CODEX_HOME: '/p' }, '/w')).not.toBe(key);
    expect(vendorChildKey(harness, { ...account, signedInAt: undefined }, { CODEX_HOME: '/p' }, '/w')).not.toBe(key);
  });
});

describe('account handoff while vendor work is running', () => {
  afterEach(() => { persistentTransports.delete('work-test'); void closePersistentTransport('work-test'); });

  const fake = (running: boolean) => {
    const calls: string[] = [];
    let work = running;
    const session = {
      backgroundWorkRunning: async () => work,
      retire: async () => { calls.push('retire'); return work; },
      close: async () => { calls.push('close'); work = false; },
      retiredWork: { agents: 0, terminals: running ? 1 : 0 },
    };
    return { session, calls, finish: () => { work = false; } };
  };

  it('leaves a process with work running to it: not waited on, not closed, and still the conversation\'s work', async () => {
    const old = fake(true);
    persistentTransports.set('work-test', { key: JSON.stringify(['claude', 'acct-a']), transport: 'acp', session: old.session } as never);
    await leavePersistentTransport('work-test');
    expect(old.calls).toEqual(['retire']);
    expect(persistentTransports.has('work-test')).toBe(false);
    expect(await persistentWorkRunning('work-test')).toBe(true);
    old.finish();
    expect(await persistentWorkRunning('work-test')).toBe(false);
  });

  it('closes a process with nothing running', async () => {
    const old = fake(false);
    persistentTransports.set('work-test', { key: JSON.stringify(['claude', 'acct-a']), transport: 'acp', session: old.session } as never);
    await leavePersistentTransport('work-test');
    expect(old.calls).toEqual(['retire', 'close']);
    expect(await persistentWorkRunning('work-test')).toBe(false);
  });

  it('leaves only the process of the account named: the conversation may be on another by then', async () => {
    const current = fake(true);
    persistentTransports.set('work-test', { key: JSON.stringify(['claude', 'acct-b']), transport: 'acp', session: current.session } as never);
    await leavePersistentTransport('work-test', { accountId: 'acct-a' });
    expect(current.calls).toEqual([]);
    expect(persistentTransports.has('work-test')).toBe(true);
  });
});
