import { describe, expect, it } from 'vitest';
import { applyEvent, emptyModel, type ChatModel } from '../../src/model';
import { applyModelPatch, diffModel } from '../../src/model-patch';
import { createStreamingMarkdown, renderMarkdown } from '../../src/webview/markdown';
import type { HarnessSession, IdeEvent } from '../../src/protocol';

const session = (patch: Partial<HarnessSession> = {}): HarnessSession => ({
  id: 's1', route: 'local', accountId: null, provider: 'opencode', model: 'm', effort: 'medium',
  permissionMode: 'ask', createdAt: '', updatedAt: '', status: 'active', nativeHarness: 'opencode',
  messages: [], ...patch,
});
const worker = (event: unknown): IdeEvent => ({ type: 'worker', sessionId: 's1', event } as IdeEvent);
const long = Array.from({ length: 50 }, (_, index) => ({ role: index % 2 ? 'assistant' as const : 'user' as const, content: `message ${index} `.repeat(40) }));

describe('model patches', () => {
  it('rebuilds on the page exactly the model the host has, sending only what changed', () => {
    const events: IdeEvent[] = [
      { type: 'ready', version: '1', pid: 1 },
      { type: 'session', session: session({ messages: long }) },
      { type: 'turn-start', sessionId: 's1', prompt: 'hi' },
      worker({ type: 'waiting-start', message: 'thinking' }),
      worker({ type: 'activity', event: { kind: 'thinking', label: 'Considering the file layout' } }),
      worker({ type: 'delta', text: 'Hel', mode: 'append' }),
      worker({ type: 'delta', text: 'lo', mode: 'append' }),
      worker({ type: 'activity', event: { kind: 'tool-start', id: 't1', label: 'read a.ts' } }),
      worker({ type: 'delta', text: 'Bye', mode: 'replace' }),
      worker({ type: 'phase', message: 'writing' }),
      worker({ type: 'snapshot', session: session({ messages: long }), live: { text: 'Bye', waitingLabel: 'thinking' } }),
      worker({ type: 'waiting-stop' }),
    ];
    let host: ChatModel = emptyModel();
    let page: ChatModel = structuredClone(host);
    for (const event of events) {
      const next = applyEvent(host, event);
      const patch = diffModel(host, next);
      if (patch) {
        const wire = JSON.parse(JSON.stringify(patch));
        if (event.type === 'worker' && (event.event as { type: string }).type === 'delta' && (event.event as { mode: string }).mode === 'append') {
          // A delta is its text and its timestamps, not the transcript. The first one also closes
          // the open thought (its text and how long it ran), so the bound leaves room for that.
          expect(Object.keys(wire.set)).toEqual([]);
          expect(wire.live.append).toBe((event.event as { text: string }).text);
          expect(JSON.stringify(wire).length).toBeLessThan(300);
        }
        page = applyModelPatch(page, wire);
      }
      host = next;
      expect(JSON.parse(JSON.stringify(page))).toEqual(JSON.parse(JSON.stringify(host)));
    }
    expect(host.traces).toHaveLength(1);
  });

  it('keeps the transcript object when a snapshot repeats it, so it is not resent', () => {
    const first = applyEvent(emptyModel(), { type: 'session', session: session({ messages: long }) });
    const again = applyEvent(first, worker({ type: 'snapshot', session: session({ messages: long.map((message) => ({ ...message })) }) }));
    expect(again.messages).toBe(first.messages);
    expect(diffModel(first, again)?.set.messages).toBeUndefined();
  });

  it('keeps a tool call\'s start, run time and exit code', () => {
    const run = (events: IdeEvent[]): ChatModel => events.reduce(applyEvent, applyEvent(emptyModel(), { type: 'session', session: session() }));
    const started = run([
      worker({ type: 'waiting-start', message: 'thinking' }),
      worker({ type: 'activity', event: { kind: 'tool-start', id: 't', label: '$ npm test' } }),
    ]);
    const startedAt = started.live!.activities[0]!.startedAt;
    expect(startedAt).toEqual(expect.any(Number));
    const done = applyEvent(started, worker({ type: 'activity', event: { kind: 'tool-error', id: 't', label: '$ npm test', durationMs: 4200, exitCode: 1 } }));
    expect(done.live!.activities[0]).toMatchObject({ kind: 'tool-error', startedAt, durationMs: 4200, exitCode: 1 });
  });

  it('keeps the latest thought until a tool starts', () => {
    const run = (events: IdeEvent[]): ChatModel => events.reduce(applyEvent, applyEvent(emptyModel(), { type: 'session', session: session() }));
    const thinking = run([
      worker({ type: 'waiting-start', message: 'thinking' }),
      worker({ type: 'activity', event: { kind: 'thinking', label: 'Reading   the\nconfig' } }),
      worker({ type: 'activity', event: { kind: 'thinking', label: 'thinking' } }),
    ]);
    expect(thinking.live?.thought?.text).toBe('Reading the config');
    const tool = applyEvent(thinking, worker({ type: 'activity', event: { kind: 'tool-start', id: 't', label: 'read' } }));
    expect(tool.live?.thought).toBeUndefined();
  });
});

describe('streaming markdown', () => {
  const answer = [
    '# Plan', '', 'Some **bold** text and `code`.', '', '- one', '- two', '', '  continued', '', '1. first', '', '2. second', '',
    '```ts', 'const a = 1;', '', 'const b = 2;', '```', '', '| a | b |', '|---|---|', '| 1 | 2 |', '', 'Setext', '---', '',
    '> quote', '', '    indented', '', '    still indented', '', '<pre>', '', 'x', '</pre>', '', '* a', '', '* b', '', 'text', '', 'last paragraph with a [link](https://example.com)',
  ].join('\n');

  it('renders every prefix exactly as the whole text renders', () => {
    const render = createStreamingMarkdown();
    for (let end = 1; end <= answer.length; end += 1) {
      const text = answer.slice(0, end);
      const { stable, tail } = render(text);
      expect(stable + tail).toBe(renderMarkdown(text));
    }
  });

  it('renders the settled part once and re-renders only the growing block', () => {
    const render = createStreamingMarkdown();
    const first = render('para one\n\npara two');
    const second = render('para one\n\npara two grows');
    expect(second.stable).toBe(first.stable);
    expect(second.stable).toContain('para one');
    expect(second.tail).toContain('para two grows');
  });

  it('falls back to whole renders for reference definitions and rewrites', () => {
    const render = createStreamingMarkdown();
    render('see [x]\n\nmore');
    const defined = render('see [x]\n\nmore\n\n[x]: https://example.com');
    expect(defined.stable + defined.tail).toBe(renderMarkdown('see [x]\n\nmore\n\n[x]: https://example.com'));
    const rewritten = render('entirely new');
    expect(rewritten.stable + rewritten.tail).toBe(renderMarkdown('entirely new'));
  });
});

describe('a phase reported before the vendor answers', () => {
  it('ends at the first answer text or call, once', () => {
    const apply = (events: unknown[]) => events.reduce<ChatModel>((model, event) => applyEvent(model, worker(event)), emptyModel());
    const switching = { type: 'phase', message: 'out of usage, switching to b@example.com' };
    expect(apply([{ type: 'waiting-start', message: 'thinking' }, switching]).live?.phase).toBe(switching.message);
    expect(apply([{ type: 'waiting-start', message: 'thinking' }, switching, { type: 'delta', text: 'Hi', mode: 'append' }]).live?.phase).toBeUndefined();
    expect(apply([{ type: 'waiting-start', message: 'thinking' }, switching, { type: 'activity', event: { kind: 'tool-start', id: 't', label: 'read a.ts' } }]).live?.phase).toBeUndefined();
  });
});
