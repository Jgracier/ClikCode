import { describe, expect, it } from 'vitest';
import type { AiHarnessAccount, AiLocalHarnessDefinition } from '../harness/definition.js';
import { vendorChildKey } from './vendor-process.js';

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
