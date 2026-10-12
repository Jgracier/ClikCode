import { describe, expect, it } from 'vitest';
import { applyEvent, emptyModel, providerDisplayName } from '../../src/model';
import { formatOutput } from '../../src/format';
import type { HarnessSession } from '../../src/protocol';

const session = { id: 's1', route: 'local', nativeHarness: 'claude', messages: [] } as unknown as HarnessSession;

describe('what the bridge says outright', () => {
  it('shows the bridge\'s formatted panel text, and falls back to the payload without it', () => {
    const payload = { panel: 'models', models: [{ model: 'm', provider: 'p' }], selected: 'm' };
    expect(formatOutput(payload, { title: 'Models', body: '  m (p)' })).toEqual({ kind: 'panel', title: 'Models', body: '  m (p)' });
    expect(formatOutput(payload)).toMatchObject({ kind: 'panel', title: 'Models' });
    // A payload for the page's own header is still not a panel.
    expect(formatOutput({ panel: 'settings' }, { title: 'Settings', body: '' })).toEqual({ kind: 'none' });
  });

  it('takes the provider from the session event, and from the session when the bridge is older', () => {
    const named = applyEvent(emptyModel(), { type: 'session', session, providerId: 'claude', providerName: 'Claude Code' });
    expect(named.providerId).toBe('claude');
    expect(providerDisplayName(named)).toBe('Claude Code');
    const old = applyEvent(emptyModel(), { type: 'session', session });
    expect(old.providerId).toBe('claude');
    expect(providerDisplayName(old)).toBe('Claude');
  });

  it('uses the level the bridge sent for a note, else reads the colour', () => {
    const joined = applyEvent(emptyModel(), { type: 'session', session });
    const sent = applyEvent(joined, { type: 'worker', sessionId: 's1', event: { type: 'note', message: 'plain' }, level: 'warning' });
    expect(sent.notes.at(-1)?.level).toBe('warning');
    const old = applyEvent(joined, { type: 'worker', sessionId: 's1', event: { type: 'note', message: '\u001b[31mbad\u001b[39m' } });
    expect(old.notes.at(-1)?.level).toBe('error');
  });
});
