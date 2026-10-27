import { describe, expect, it } from 'vitest';
import { routedChoice } from './bridge-choose.js';
import type { BridgeHost } from './bridge-host.js';
import type { HarnessSession } from '../session/model.js';

/** The host as `routedChoice` uses it: the open session. */
const hostOn = (route: HarnessSession['route']): BridgeHost => ({ current: async () => ({ session: { id: 's1', route } as HarnessSession }) } as unknown as BridgeHost);

describe('a model chosen while the chat runs one on this computer', () => {
  it('moves the chat to the Gateway with it when it is a Gateway model, because both are the Gateway provider', async () => {
    expect(await routedChoice(hostOn('clikcode-local'), { kind: 'model', model: 'claude-opus-5.5' })).toEqual({ kind: 'provider', provider: 'gateway', model: 'claude-opus-5.5' });
    expect(await routedChoice(hostOn('clikcode-local'), { kind: 'model', model: 'auto' })).toEqual({ kind: 'provider', provider: 'gateway', model: 'auto' });
  });

  it('stays a model setting when it is one of this computer\'s own', async () => {
    const choice = { kind: 'model' as const, model: 'qwen3.5-4b' };
    expect(await routedChoice(hostOn('clikcode-local'), choice)).toEqual(choice);
  });

  it('is left alone on a Gateway chat, a vendor chat and for every other kind of choice', async () => {
    const model = { kind: 'model' as const, model: 'claude-opus-5.5' };
    expect(await routedChoice(hostOn('gateway'), model)).toEqual(model);
    expect(await routedChoice(hostOn('local'), model)).toEqual(model);
    const effort = { kind: 'effort' as const, value: 'high' };
    expect(await routedChoice(hostOn('clikcode-local'), effort)).toEqual(effort);
  });
});
