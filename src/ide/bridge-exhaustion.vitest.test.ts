/** A queued message that runs out of usage in the editor is offered "Resume
 * in" like a typed one, and is either carried on or handed back -- never
 * both, which would send it twice. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Conf from 'conf';

const carry = vi.hoisted(() => ({ next: vi.fn() }));
vi.mock('../tui/pickers/resume-in.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../tui/pickers/resume-in.js')>(),
  carryOnAfterExhaustion: carry.next,
}));
vi.mock('../commands/ai/conversations.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../commands/ai/conversations.js')>(),
  releaseQueuedTurn: async () => undefined,
}));
const { IdeBridge } = await import('./bridge.js');

interface Internals {
  sessionId: string | undefined;
  execute(line: string, options: { queuedTurnId?: string }): Promise<void>;
  runTurn(id: string, prompt: string, turn: { echo: boolean; queuedTurnId?: string }): Promise<void>;
  dispatch(line: string): Promise<{ prompt?: string }>;
  switchTo(id: string): Promise<void>;
  emitSession(): Promise<void>;
}

function setup() {
  const sent: Array<{ type: string; text?: string }> = [];
  const bridge = new IdeBridge({} as Conf, { send: (message) => { sent.push(message as never); } });
  const inner = bridge as unknown as Internals;
  inner.sessionId = 's1';
  inner.emitSession = async () => undefined;
  inner.switchTo = vi.fn(async (id: string) => { inner.sessionId = id; });
  const turns: string[] = [];
  inner.runTurn = vi.fn(async (_id: string, prompt: string) => {
    turns.push(prompt);
    if (turns.length === 1) throw new Error('All accounts exhausted');
  });
  inner.dispatch = async (line: string) => ({ prompt: line });
  return { inner, sent, turns };
}

describe('a queued message that runs out of usage in the editor', () => {
  beforeEach(() => { carry.next.mockReset(); });

  it('is offered "Resume in", and carried on there is not also handed back', async () => {
    const { inner, sent, turns } = setup();
    carry.next.mockResolvedValue({ moved: { id: 's2', prompt: 'continue it' } });
    await inner.execute('queued words', { queuedTurnId: 'q1' });
    expect(carry.next).toHaveBeenCalledWith(expect.anything(), 's1', 'queued words', expect.anything(), 'queued words');
    expect(inner.switchTo).toHaveBeenCalledWith('s2');
    expect(turns).toEqual(['queued words', 'continue it']);
    expect(sent.filter((message) => message.type === 'restore-draft')).toEqual([]);
  });

  it('comes back to the composer, with what was queued behind it, when it stays', async () => {
    const { inner, sent, turns } = setup();
    carry.next.mockResolvedValue({ stayed: ['and then this'] });
    await inner.execute('queued words', { queuedTurnId: 'q1' });
    expect(turns).toEqual(['queued words']);
    expect(sent.filter((message) => message.type === 'restore-draft')).toEqual([{ type: 'restore-draft', text: 'queued words\n\nand then this' }]);
  });

  it('names the prompt a slash command expanded to, so its interrupted turn is continued, not re-run', async () => {
    const { inner } = setup();
    inner.dispatch = async (line: string) => ({ prompt: line === '/review' ? 'Review the uncommitted changes.' : line });
    carry.next.mockResolvedValue({ stayed: [] });
    await inner.execute('/review', {});
    expect(carry.next).toHaveBeenCalledWith(expect.anything(), 's1', '/review', expect.anything(), 'Review the uncommitted changes.');
  });
});
