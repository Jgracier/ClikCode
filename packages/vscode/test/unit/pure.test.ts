import { describe, expect, it } from 'vitest';
import { applyEvent, chatModelLabel, emptyModel, turnMarks, type ChatModel } from '../../src/model';
import { formatOutput } from '../../src/format';
import { stripAnsi } from '../../src/text';
import { renderMarkdown } from '../../src/webview/markdown';
import { questionWithSelection } from '../../src/editor-context';
import type { HarnessSession, IdeEvent } from '../../src/protocol';

const session = (patch: Partial<HarnessSession> = {}): HarnessSession => ({
  id: 's1', route: 'local', accountId: null, provider: 'opencode', model: 'opencode/big-pickle', effort: 'medium',
  permissionMode: 'ask', createdAt: '', updatedAt: '', status: 'active', nativeHarness: 'opencode',
  messages: [], ...patch,
});
const run = (events: IdeEvent[], start: ChatModel = emptyModel()): ChatModel => events.reduce(applyEvent, start);
const worker = (event: unknown): IdeEvent => ({ type: 'worker', sessionId: 's1', event } as IdeEvent);
const change = { path: 'a.ts', change: 'modify', additions: 1, removals: 1, lines: [{ kind: 'removed', line: 1, text: 'a' }, { kind: 'added', line: 1, text: 'b' }] };
const activity = (event: Record<string, unknown>): IdeEvent => worker({ type: 'activity', event });
const turn = (...events: IdeEvent[]): ChatModel => run([
  { type: 'ready', version: '1', pid: 1 }, { type: 'session', session: session() },
  { type: 'turn-start', sessionId: 's1', prompt: 'hi' }, worker({ type: 'waiting-start', message: 'thinking' }), ...events,
]);

describe('chat model', () => {
  it('merges the frames of a call that has no id into one row, as the terminal does', () => {
    const model = turn(activity({ kind: 'tool-start', label: 'npm test' }), activity({ kind: 'tool-done', label: 'npm test', exitCode: 1 }), activity({ kind: 'tool-start', label: 'npm test' }));
    const rows = model.live!.activities;
    expect(rows.map((row) => [row.key, row.kind, row.exitCode])).toEqual([['#1', 'tool-done', 1], ['#2', 'tool-start', undefined]]);
  });

  it('never reopens a finished call, and keeps what its start knew', () => {
    const model = turn(
      activity({ kind: 'tool-start', id: 't', label: 'Read a.ts', category: 'read' }),
      activity({ kind: 'tool-done', id: 't', label: 'tool', output: ['x'] }),
      activity({ kind: 'tool-start', id: 't', label: 'tool' }),
    );
    expect(model.live!.activities).toEqual([expect.objectContaining({ kind: 'tool-done', label: 'Read a.ts', category: 'read', output: ['x'] })]);
  });

  it("shows a sub-agent's current step inside its parent's row", () => {
    const working = turn(
      activity({ kind: 'tool-start', id: 'agent', label: 'Task explore', agent: true }),
      activity({ kind: 'tool-start', id: 'c1', parentId: 'agent', label: 'grep TODO' }),
    );
    expect(working.live!.activities).toEqual([expect.objectContaining({ key: 'agent', child: 'grep TODO' })]);
    const between = run([activity({ kind: 'tool-done', id: 'c1', parentId: 'agent', label: 'grep TODO' })], working);
    expect(between.live!.activities[0]!.child).toBeUndefined();
  });

  it('names what the open call is doing, as the terminal does, and says thinking once it ends', () => {
    const testing = turn(activity({ kind: 'tool-start', id: 'b', label: 'Bash(npm test)', category: 'run' }));
    expect(testing.live?.toolPhase).toBe('running tests');
    expect(run([activity({ kind: 'tool-done', id: 'b', label: 'Bash(npm test)' })], testing).live?.toolPhase).toBeUndefined();
  });

  it('places a call where it happened in the answer, and moves it back when the text is replaced', () => {
    const model = turn(worker({ type: 'delta', text: 'First part. ', mode: 'append' }), activity({ kind: 'tool-start', id: 'r', label: 'Read(a.ts)', category: 'read' }));
    expect(model.live?.activities[0]?.offset).toBe(12);
    const replaced = run([worker({ type: 'delta', text: 'First', mode: 'replace' })], model);
    expect(replaced.live?.activities[0]?.offset).toBe(5);
  });

  it('settles the thought once answer text arrives', () => {
    const model = turn(activity({ kind: 'thinking', id: 'r1', label: 'Considering' }), worker({ type: 'delta', text: 'Answer', mode: 'append' }));
    expect(model.live?.thought).toBeUndefined();
    expect(model.live?.reasoning).toEqual([{ text: 'Considering', offset: 0, ms: expect.any(Number), seq: 1 }]);
  });

  it('puts a note from the running turn after its prompt, not before it', () => {
    const model = turn(worker({ type: 'note', message: 'switched account' }));
    expect(model.notes.at(-1)?.after).toBe(model.messages.length + 1);
  });

  it('joins a running turn at its real start, with the steers sent into it', () => {
    const startedAt = new Date(Date.now() - 90_000).toISOString();
    const joined = run([worker({
      type: 'snapshot', session: session({ pendingTurn: { prompt: 'p', startedAt, updatedAt: startedAt, outputStarted: true, steers: [{ text: 'also this', submittedAt: startedAt, responseOffset: 2 }] } }),
      live: { text: 'abc', waitingLabel: 'thinking' },
    })], run([{ type: 'session', session: session() }]));
    expect(joined.live?.startedAt).toBe(Date.parse(startedAt));
    expect(joined.live?.steers).toEqual([{ text: 'also this', offset: 2 }]);
  });

  it('shows a submitted steer only as a user message once the turn finishes', () => {
    const startedAt = new Date().toISOString();
    const during = run([worker({
      type: 'snapshot', session: session({ pendingTurn: { prompt: 'p', startedAt, updatedAt: startedAt, outputStarted: true,
        steers: [{ text: 'also this', submittedAt: startedAt, responseOffset: 2 }] } }),
      live: { text: 'abc', waitingLabel: 'thinking' },
    })], run([{ type: 'session', session: session() }]));
    expect(during.live?.steers).toHaveLength(1);
    const finished = run([activity({ kind: 'tool-done', id: 'r', label: 'Read a.ts', category: 'read' }), worker({ type: 'waiting-stop' }), { type: 'session', session: session({ messages: [
      { role: 'user', content: 'p' }, { role: 'assistant', content: 'ab' },
      { role: 'user', content: 'also this' }, { role: 'assistant', content: 'c' },
    ] }) }], during);
    expect(finished.messages.filter((message) => message.role === 'user' && message.content === 'also this')).toHaveLength(1);
    expect(finished.traces).toHaveLength(1);
    expect(finished.traces[0]?.steers).toBeUndefined();
  });

  it("counts a sub-agent's tool uses on its parent row, and keeps the count when it finishes", () => {
    const working = turn(
      activity({ kind: 'tool-start', id: 'agent', label: 'Task explore', agent: true }),
      activity({ kind: 'tool-start', id: 'c1', parentId: 'agent', label: 'grep TODO' }),
      activity({ kind: 'tool-done', id: 'c1', parentId: 'agent', label: 'grep TODO' }),
      activity({ kind: 'tool-start', id: 'c2', parentId: 'agent', label: 'Read(a.ts)' }),
      activity({ kind: 'tool-done', id: 'agent', label: 'Task explore' }),
    );
    expect(working.live!.activities[0]).toMatchObject({ kind: 'tool-done', childTools: 2 });
  });

  it('keeps where each call and thought came, for the finished turn', () => {
    const model = turn(
      activity({ kind: 'thinking', id: 'r1', label: 'Plan it' }),
      worker({ type: 'delta', text: 'Looking. ', mode: 'append' }),
      activity({ kind: 'tool-start', id: 'b', label: 'Bash(npm test)', category: 'run' }),
      worker({ type: 'waiting-stop' }),
    );
    const trace = model.traces.at(-1)!;
    expect(trace.text).toBe('Looking. ');
    expect(trace.reasoning?.[0]?.offset).toBe(0);
    expect(trace.activities[0]?.offset).toBe(9);
  });

  it("shows a saved turn's calls in a panel opened after it, from the saved turn itself", () => {
    const saved = session({ messages: [
      { role: 'user', content: 'run it' },
      { role: 'assistant', content: 'Running. Done.', activities: [
        { event: { kind: 'tool-done', id: 'b', label: 'Bash(npm test)', category: 'run', output: ['ok'] }, responseOffset: 9 },
      ] },
    ] });
    const model = run([{ type: 'ready', version: '1', pid: 1 }, { type: 'session', session: saved }]);
    expect(model.messages).toEqual([{ role: 'user', content: 'run it' }, { role: 'assistant', content: 'Running. Done.' }]);
    expect(model.traces).toEqual([expect.objectContaining({ userIndex: 0, text: 'Running. Done.', saved: true })]);
    expect(model.traces[0]!.activities).toEqual([expect.objectContaining({ key: 'b', kind: 'tool-done', label: 'Bash(npm test)', output: ['ok'], offset: 9 })]);
    // The same snapshot again changes nothing the page would redraw.
    expect(run([{ type: 'session', session: saved }], model).traces).toBe(model.traces);
  });

  it("takes a watched turn's calls from its saved copy, keeping what only this window saw", () => {
    const watched = turn(
      activity({ kind: 'thinking', id: 'r1', label: 'Plan it' }),
      worker({ type: 'delta', text: 'Looking. ', mode: 'append' }),
      activity({ kind: 'tool-start', id: 'b', label: 'Bash(npm test)', category: 'run' }),
    );
    const ended = run([worker({ type: 'snapshot', session: session({ messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Looking.', activities: [{ event: { kind: 'tool-done', id: 'b', label: 'Bash(npm test)', category: 'run', exitCode: 0 }, responseOffset: 8 }] },
    ] }) }), worker({ type: 'waiting-stop' })], watched);
    const trace = ended.traces.at(-1)!;
    expect(trace).toMatchObject({ userIndex: 0, text: 'Looking.', saved: true });
    expect(trace.activities).toEqual([expect.objectContaining({ kind: 'tool-done', exitCode: 0, offset: 8 })]);
    expect(trace.reasoning?.[0]?.text).toBe('Plan it');
  });

  it('keeps thoughts and calls in the order they happened when no text comes between them', () => {
    const model = turn(
      activity({ kind: 'thinking', id: 'r1', label: 'First, look' }),
      activity({ kind: 'tool-start', id: 'a', label: 'Read(a.ts)', category: 'read' }),
      activity({ kind: 'tool-done', id: 'a', label: 'Read(a.ts)' }),
      activity({ kind: 'thinking', id: 'r2', label: 'Now run it' }),
      activity({ kind: 'tool-start', id: 'b', label: 'Bash(npm test)', category: 'run' }),
      worker({ type: 'delta', text: 'Done.', mode: 'append' }),
      worker({ type: 'waiting-stop' }),
    );
    const trace = model.traces.at(-1)!;
    const order = turnMarks(trace.text, trace.activities, trace.reasoning ?? [], [])
      .map((mark) => mark.thought?.text ?? mark.activity?.label);
    expect(order).toEqual(['First, look', 'Read(a.ts)', 'Now run it', 'Bash(npm test)']);
  });

  it('keeps a finished plan with its turn, and a new turn starts without one', () => {
    const steps = [{ content: 'read', status: 'completed' }, { content: 'fix', status: 'completed' }];
    const ended = turn(worker({ type: 'plan', entries: steps }), worker({ type: 'waiting-stop' }));
    expect(ended.traces.at(-1)?.plan).toEqual(steps);
    expect(run([worker({ type: 'waiting-start', message: 'thinking' })], ended).plan).toEqual([]);
  });

  it('keeps the context window figure between turns', () => {
    const model = turn(worker({ type: 'usage', usage: { input: 10, contextUsed: 50_000, contextWindow: 200_000 } }), worker({ type: 'waiting-stop' }));
    expect(model.context).toEqual({ used: 50_000, window: 200_000, percent: 25 });
    const next = run([worker({ type: 'waiting-start', message: 'thinking' })], model);
    expect(next.turnUsage).toBeUndefined();
    expect(next.context?.percent).toBe(25);
  });

  it('accumulates thinking fragments and keeps the reasoning with the finished turn', () => {
    const model = turn(
      activity({ kind: 'thinking', id: 'r1', label: 'Reading' }),
      activity({ kind: 'thinking', id: 'r1', label: 'the config' }),
    );
    expect(model.live!.thought?.text).toBe('Reading the config');
    const next = run([activity({ kind: 'thinking', id: 'r2', label: 'Now the tests' }), worker({ type: 'waiting-stop' })], model);
    expect(next.traces.at(-1)?.reasoning?.map((entry) => entry.text)).toEqual(['Reading the config', 'Now the tests']);
  });

  it('says nothing when an idle worker retires, but reports a cut-off turn', () => {
    const open = run([{ type: 'ready', version: '1', pid: 1 }, { type: 'session', session: session() }]);
    const retired = run([worker({ type: 'shutdown', reason: 'replaced by a newer ClikCode build' })], open);
    expect(retired).toBe(open);
    const cut = run([{ type: 'turn-start', sessionId: 's1', prompt: 'hi' }, worker({ type: 'shutdown', reason: 'killed' })], open);
    expect(cut.running).toBe(false);
    expect(cut.notes.at(-1)?.text).toContain('killed');
  });

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
    expect(during.live?.activities).toEqual([{ id: 't1', key: 't1', kind: 'tool-done', label: 'read a.ts', startedAt: expect.any(Number), offset: 5, seq: 1 }]);
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
      worker({ type: 'approval-request', id: 'a', title: 'Edit a.ts', preview: { diff: [change] }, rule: 'Edit(*)' }),
      worker({ type: 'notice', message: '\u001b[33mStopped\u001b[0m' }),
      worker({ type: 'turn-error', message: 'boom' }),
    ]);
    expect(model.approvals).toEqual([{ id: 'a', title: 'Edit a.ts', rule: 'Edit(*)', diff: [change] }]);
    // The terminal's colour is the level: yellow warns.
    expect(model.notes.map((n) => [n.level, n.text])).toEqual([['warning', 'Stopped'], ['error', 'boom']]);
    expect(model.queued).toEqual([{ id: 'q', text: 'later', command: false }]);
  });

  it('shows a message the running turn holds for its next pause as on its way, not queued', () => {
    const pendingTurn = { prompt: 'p', startedAt: 't1', updatedAt: 't1', outputStarted: true };
    const held = (heldForTurn: string) => run([{ type: 'session', session: session({ pendingTurn, queuedTurns: [{ id: 'q', text: 'also', submittedAt: '', heldForTurn }] }) }]).queued;
    expect(held('t1')).toEqual([{ id: 'q', text: 'also', command: false, held: true }]);
    // Held by a turn that is over: it is the next turn now.
    expect(held('t0')).toEqual([{ id: 'q', text: 'also', command: false }]);
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

  it('highlights a fence in a language it knows, escaped, and leaves others plain', () => {
    const html = renderMarkdown('```ts\nconst a = "<b>"; // note\n```\n\n```text\nconst x\n```');
    expect(html).toContain('<span class="tok-keyword">const</span> a = <span class="tok-string">&quot;&lt;b&gt;&quot;</span>; <span class="tok-comment">// note</span>');
    expect(html).toContain('<code>const x</code>');
  });
});

describe('editor context', () => {
  it('fences a selection with a fence longer than any it contains', () => {
    expect(questionWithSelection('Why?', { path: 'src/a.ts', languageId: 'typescript', startLine: 3, endLine: 4, text: 'a\n```\nb\n' }))
      .toBe('Why?\n\n`src/a.ts` lines 3-4:\n````typescript\na\n```\nb\n````');
  });
});

describe('usage in the chat bar', () => {
  it('reads as the terminal words it: the figure, the reset once a window is spent', async () => {
    const { composerUsageLabel } = await import('../../../../src/tui/render/usage-words.js');
    expect(composerUsageLabel('5h 96% left · Weekly 18% left')).toBe('5h 96% left · Weekly 18% left');
    expect(composerUsageLabel('5h 0% left · Weekly 18% left', 'Resets 1:50PM')).toBe('Resets 1:50PM');
    expect(composerUsageLabel('$0 credits exhausted')).toBe('Out Of Credits');
  });
});
