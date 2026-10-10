import { beforeEach, describe, expect, it, vi } from 'vitest';

const bus = vi.hoisted(() => ({ requests: [] as unknown[] }));
vi.mock('../../src/webview/bus', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/webview/bus')>(),
  request: async (body: unknown) => { bus.requests.push(body); return undefined; },
}));

const { conversationMark, holdConversationWatch, rowState } = await import('../../src/webview/screens');

const row = (patch: Record<string, unknown> = {}) => ({ id: 'c1', title: 'Fix it', updatedAt: new Date().toISOString(), ...patch }) as never;

describe('the conversation list on the welcome screen and in the history menu', () => {
  beforeEach(() => { bus.requests.length = 0; });

  it('keeps the watch on while either shows: one closing does not switch it off under the other', () => {
    const history = holdConversationWatch();
    const welcome = holdConversationWatch();
    history();
    history();
    expect(bus.requests).toEqual([{ method: 'watchConversations', on: true }]);
    welcome();
    expect(bus.requests).toEqual([{ method: 'watchConversations', on: true }, { method: 'watchConversations', on: false }]);
  });

  it('marks a row by its one state: working, stalled, needs you', () => {
    const now = Date.now();
    const working = row({ activity: 'working', turn: { startedAt: new Date(now - 60_000).toISOString(), activeAt: new Date(now - 1_000).toISOString() } });
    expect(conversationMark(working, rowState(working, now))).toBe('working');
    const stalled = row({ activity: 'working', turn: { startedAt: new Date(now - 600_000).toISOString(), activeAt: new Date(now - 300_000).toISOString() } });
    expect(conversationMark(stalled, rowState(stalled, now))).toBe('stalled');
    const asking = row({ activity: 'working', needsYou: true, turn: { startedAt: new Date(now - 60_000).toISOString(), activeAt: new Date(now - 1_000).toISOString() } });
    expect(conversationMark(asking, rowState(asking, now))).toBe('needs-you');
    const finished = row();
    expect(conversationMark(finished, rowState(finished, now))).toBe('none');
  });
});
