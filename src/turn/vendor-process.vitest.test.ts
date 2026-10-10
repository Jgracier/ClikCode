import { afterEach, describe, expect, it } from 'vitest';
import type { AiHarnessAccount, AiLocalHarnessDefinition } from '../harness/definition.js';
import { persistentTransports, vendorChildKey, waitForPersistentWork } from './vendor-process.js';

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
  afterEach(() => { persistentTransports.delete('work-test'); });

  it('waits for the old process to finish its work before returning', async () => {
    let running = true;
    persistentTransports.set('work-test', { key: 'a', transport: 'acp', session: { backgroundWorkRunning: async () => running } } as never);
    let settled = false;
    const waiting = waitForPersistentWork('work-test').then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);
    running = false;
    await waiting;
    expect(settled).toBe(true);
  });

  it('lets a cancelled turn leave the old process running', async () => {
    persistentTransports.set('work-test', { key: 'a', transport: 'acp', session: { backgroundWorkRunning: async () => true } } as never);
    const controller = new AbortController();
    const waiting = waitForPersistentWork('work-test', controller.signal);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ code: 'ERR_TURN_CANCELLED' });
    expect(persistentTransports.has('work-test')).toBe(true);
  });
});
