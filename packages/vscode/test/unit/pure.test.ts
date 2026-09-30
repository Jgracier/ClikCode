import { describe, expect, it } from 'vitest';
import { applyEvent, chatModelLabel, emptyModel, type ChatModel } from '../../src/model';
import { formatOutput } from '../../src/format';
import { diffSides, stripAnsi } from '../../src/text';
import { renderMarkdown } from '../../src/webview/markdown';
import { questionWithSelection } from '../../src/editor-context';
import type { HarnessSession, IdeEvent } from '../../src/protocol';

const session = (patch: Partial<HarnessSession> = {}): HarnessSession => ({
  id: 's1', route: 'local', accountId: null, provider: 'opencode', model: 'opencode/big-pickle', effort: 'medium',
  permissionMode: 'ask', accountFailover: 'never', createdAt: '', updatedAt: '', status: 'active', nativeHarness: 'opencode',
  messages: [], ...patch,
});
const run = (events: IdeEvent[], start: ChatModel = emptyModel()): ChatModel => events.reduce(applyEvent, start);
const worker = (event: unknown): IdeEvent => ({ type: 'worker', sessionId: 's1', event } as IdeEvent);

describe('chat model', () => {
  it('streams a turn and ends on the worker transcript', () => {
    const during = run([
      { type: 'ready', version: '1', pid: 1 },
      { type: 'session', session: session() },
      { type: 'turn-start', sessionId: 's1', prompt: 'hi' },
      worker({ type: 'waiting-start', message: 'thinking' }),
      worker({ type: 'delta', text: 'Hel', mode: 'append' }),
      worker({ type: 'delta', text: 'lo', mode: 'append' }),
      worker({ type: 'activity', event: { kind: 'tool-start', id: 't1', label: '\u001b[2mread\u001b[0m a.ts' } }),
      worker({ type: 'activity', event: { kind: 'tool-done', id: 't1', label: 'read a.ts' } }),
      worker({ type: 'plan', entries: [{ content: 'step', status: 'in_progress' }] }),
    ]);
    expect(during.running).toBe(true);
    expect(during.pendingPrompt).toBe('hi');
    expect(during.live?.text).toBe('Hello');
    expect(during.live?.activities).toEqual([{ key: 't1', kind: 'tool-done', label: 'read a.ts' }]);
    expect(during.plan).toEqual([{ content: 'step', status: 'in_progress' }]);
    const after = run([
      worker({ type: 'snapshot', session: session({ messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'Hello' }] }), live: { text: 'Hello', waitingLabel: 'thinking' } }),
      worker({ type: 'waiting-stop' }),
    ], during);
    expect(after.running).toBe(false);
    expect(after.live).toBeUndefined();
    expect(after.pendingPrompt).toBeUndefined();
    expect(after.messages.map((m) => m.content)).toEqual(['hi', 'Hello']);
  });

  it('ignores events it does not know and events for another conversation', () => {
    const base = run([{ type: 'session', session: session() }]);
    expect(run([worker({ type: 'brand-new-event', x: 1 }), { type: 'unheard-of' } as unknown as IdeEvent], base)).toBe(base);
    expect(run([{ type: 'worker', sessionId: 'other', event: { type: 'delta', text: 'x', mode: 'append' } }], base)).toBe(base);
  });

  it('shows approvals, notices, queued turns and strips ANSI', () => {
    const model = run([
      { type: 'session', session: session({ queuedTurns: [{ id: 'q', text: 'later', submittedAt: '' }] }) },
      worker({ type: 'approval-request', id: 'a', title: 'Edit a.ts', preview: { diff: ['-a', '+b'] }, rule: 'Edit(*)' }),
      worker({ type: 'notice', message: '\u001b[33mStopped\u001b[0m' }),
      worker({ type: 'turn-error', message: 'boom' }),
    ]);
    expect(model.approvals).toEqual([{ id: 'a', title: 'Edit a.ts', rule: 'Edit(*)', hasDiff: true }]);
    expect(model.notes.map((n) => [n.level, n.text])).toEqual([['info', 'Stopped'], ['error', 'boom']]);
    expect(model.queued).toEqual([{ id: 'q', text: 'later', command: false }]);
  });

  it('resets when the conversation changes, and picks up a turn already running on attach', () => {
    const first = run([{ type: 'session', session: session({ messages: [{ role: 'user', content: 'old' }] }) }]);
    const next = run([worker({ type: 'snapshot', session: session({ id: 's1' }) })], first);
    expect(next.messages).toEqual([]);
    const other = run([{ type: 'session', session: session({ id: 's2' }) }], first);
    expect(other.sessionId).toBe('s2');
    const attached = run([{ type: 'worker', sessionId: 's2', event: { type: 'snapshot', session: session({ id: 's2', pendingTurn: { prompt: 'p', startedAt: '', updatedAt: '', outputStarted: true } }), live: { text: 'part', waitingLabel: 'thinking' } } }], other);
    expect(attached.running).toBe(true);
    expect(attached.pendingPrompt).toBe('p');
    expect(attached.live?.text).toBe('part');
  });
});

describe('model labels', () => {
  it('names the chat model without its provider prefix, from the bridge or the shared rule', () => {
    const labelled = run([{ type: 'session', session: session(), modelLabel: { model: 'opencode/big-pickle', label: 'big-pickle' } }]);
    expect(labelled.model).toBe('opencode/big-pickle');
    expect(chatModelLabel(labelled)).toBe('big-pickle');
    // No label from an older bridge: the same rule, applied here.
    expect(chatModelLabel(run([{ type: 'session', session: session() }]))).toBe('big-pickle');
    // A model the worker reported since the label was sent.
    const reported = run([worker({ type: 'snapshot', session: session({ model: 'opencode/claude-opus-4-5' }) })], labelled);
    expect(chatModelLabel(reported)).toBe('claude-opus-4-5');
    // A lab stays: OpenCode's anthropic model, and a Gateway model.
    expect(chatModelLabel(run([{ type: 'session', session: session({ model: 'anthropic/claude-sonnet-4' }) }]))).toBe('anthropic/claude-sonnet-4');
    const gateway = session({ route: 'gateway', nativeHarness: undefined, provider: 'gateway', model: 'openai/gpt-5.5' });
    expect(chatModelLabel(run([{ type: 'session', session: gateway }]), 'ClikDeploy Gateway')).toBe('openai/gpt-5.5');
    expect(chatModelLabel(run([{ type: 'session', session: session({ model: null }) }]))).toBeUndefined();
  });

  it('lists a models panel by label', () => {
    expect(formatOutput({ panel: 'models', models: [{ model: 'opencode/big-pickle', provider: 'opencode' }, { model: 'kilo/openai/gpt-5.1', provider: 'kilo', label: 'openai/gpt-5.1' }], selected: 'opencode/big-pickle' }))
      .toEqual({ kind: 'panel', title: 'Models', body: '● big-pickle  (opencode)\n  openai/gpt-5.1  (kilo)' });
  });
});

describe('output formatting', () => {
  it('turns command results into panels, notices, or nothing', () => {
    expect(formatOutput({ panel: 'settings', session: {} })).toEqual({ kind: 'none' });
    expect(formatOutput({ panel: 'error', message: 'bad' })).toEqual({ kind: 'notice', text: 'bad', level: 'error' });
    expect(formatOutput({ panel: 'error', message: 'All accounts exhausted' })).toMatchObject({ level: 'warning' });
    expect(formatOutput({ panel: 'help', helpText: '\u001b[1m/help\u001b[0m' })).toEqual({ kind: 'panel', title: 'Commands', body: '/help' });
    expect(formatOutput({ panel: 'models', models: [{ model: 'a', provider: 'x' }, { model: 'b' }], selected: 'a' }))
      .toEqual({ kind: 'panel', title: 'Models', body: '● a  (x)\n  b' });
    expect(formatOutput({ panel: 'session-renamed', text: 'Renamed' })).toEqual({ kind: 'notice', text: 'Renamed', level: 'info' });
    expect(formatOutput({ panel: 'shell', text: '$ ls' })).toEqual({ kind: 'panel', title: 'Shell', body: '$ ls' });
  });
});

describe('text', () => {
  it('strips colour, OSC links and control characters', () => {
    expect(stripAnsi('\u001b[31mred\u001b[0m \u001b]8;;http://x\u0007link\u001b]8;;\u0007\u0007')).toBe('red link');
  });
  it('splits unified and two-sided diffs into before and after', () => {
    expect(diffSides(['--- a/x', '+++ b/x', '@@ -1,2 +1,2 @@', ' same', '-old', '+new'])).toEqual({ before: 'same\nold', after: 'same\nnew' });
    expect(diffSides({ removed: ['a'], added: ['b', 'c'] })).toEqual({ before: 'a', after: 'b\nc' });
  });
});

describe('markdown', () => {
  it('renders markdown but never raw HTML, script links or images', () => {
    const html = renderMarkdown('**bold** <script>alert(1)</script> [x](javascript:alert(1)) [ok](https://a.b) ![i](https://t.rk/p.png)\n\n```js\n<b>\n```');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('data-href="https://a.b"');
    expect(html).not.toContain('<img');
    expect(html).toContain('<pre class="code" data-lang="js"><code>&lt;b&gt;');
  });
});

describe('editor context', () => {
  it('fences a selection with a fence longer than any it contains', () => {
    expect(questionWithSelection('Why?', { path: 'src/a.ts', languageId: 'typescript', startLine: 3, endLine: 4, text: 'a\n```\nb\n' }))
      .toBe('Why?\n\n`src/a.ts` lines 3-4:\n````typescript\na\n```\nb\n````');
  });
});
