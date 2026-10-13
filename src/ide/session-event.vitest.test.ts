import { describe, expect, it, vi } from 'vitest';

vi.mock('../runtime/lazy-bridge.js', () => ({ localHarnessForCommand: (command: string) => (command === 'claude' ? { displayName: 'Claude Code' } : undefined) }));

import type { HarnessSession } from '../session/model.js';
import { noticeLevel } from './notice-level.js';
import { sessionEvent } from './session-event.js';

const base = { id: 's1', name: 'x', messages: [] } as unknown as HarnessSession;

describe('the session event names its provider', () => {
  it('names the Gateway and ClikCode Local without a harness lookup', () => {
    expect(sessionEvent({ ...base, route: 'gateway' } as HarnessSession)).toMatchObject({ providerId: 'gateway', providerName: 'ClikDeploy Gateway' });
    expect(sessionEvent({ ...base, route: 'clikcode-local' } as HarnessSession)).toMatchObject({ providerId: 'clikcode-local' });
  });

  it('carries a harness command as the id', () => {
    expect(sessionEvent({ ...base, route: 'local', nativeHarness: 'claude' } as HarnessSession)).toMatchObject({ providerId: 'claude', providerName: 'Claude Code' });
  });

  it('names none for a session with no provider yet', () => {
    expect(sessionEvent(base)).not.toHaveProperty('providerId');
  });
});

describe('noticeLevel', () => {
  it('reads red as an error and yellow as a warning', () => {
    expect(noticeLevel('\u001b[31mboom\u001b[39m')).toBe('error');
    expect(noticeLevel('\u001b[33mcareful\u001b[39m')).toBe('warning');
    expect(noticeLevel('plain')).toBe('info');
  });
});
