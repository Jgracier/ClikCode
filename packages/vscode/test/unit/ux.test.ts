import { describe, expect, it } from 'vitest';
import { applyEvent, emptyModel, type ChatModel } from '../../src/model';
import { supportsSecondarySidebar } from '../../src/compat';
import { mentionScore } from '../../src/text';
import { composeMessage, tokenAtCaret } from '../../src/webview/composer';
import { inlineStep } from '../../src/webview/sheet';
import { pathIn, relativeTime, resetIn } from '../../src/webview/format';
import type { HarnessSession, IdeEvent } from '../../src/protocol';

const session = (patch: Partial<HarnessSession> = {}): HarnessSession => ({
  id: 's1', route: 'local', accountId: null, provider: 'opencode', model: 'opencode/big-pickle', effort: 'medium',
  permissionMode: 'ask', accountFailover: 'never', createdAt: '', updatedAt: '', status: 'active', nativeHarness: 'opencode',
  messages: [], ...patch,
});
const run = (events: IdeEvent[], start: ChatModel = emptyModel()): ChatModel => events.reduce(applyEvent, start);
const worker = (event: unknown): IdeEvent => ({ type: 'worker', sessionId: 's1', event } as IdeEvent);

describe('where the chat opens', () => {
  it('uses the secondary side bar from VS Code 1.106 on', () => {
    expect(supportsSecondarySidebar('1.105.3')).toBe(false);
    expect(supportsSecondarySidebar('1.106.0')).toBe(true);
    expect(supportsSecondarySidebar('1.123.0-insider')).toBe(true);
    expect(supportsSecondarySidebar('2.0.0')).toBe(true);
  });
});

describe('the chat model', () => {
  it('records the bridge revision and the provider id a choice takes', () => {
    const model = run([{ type: 'ready', version: '1', protocol: 1, revision: 2, pid: 1 }, { type: 'session', session: session({ route: 'gateway' }) }]);
    expect(model.revision).toBe(2);
    expect(model.providerId).toBe('gateway');
    expect(run([{ type: 'ready', version: '0.9', protocol: 1, pid: 1 }]).revision).toBe(1);
  });

  it('keeps a finished turn\'s tool rows beside its answer', () => {
    const done = run([
      { type: 'session', session: session() },
      { type: 'turn-start', sessionId: 's1', prompt: 'read it' },
      worker({ type: 'waiting-start', message: 'thinking' }),
      worker({ type: 'activity', event: { kind: 'tool-done', id: 't1', label: 'Read math.ts', category: 'read' } }),
      worker({ type: 'snapshot', session: session({ messages: [{ role: 'user', content: 'read it' }, { role: 'assistant', content: 'ok' }] }) }),
      worker({ type: 'waiting-stop' }),
    ]);
    expect(done.running).toBe(false);
    expect(done.traces).toHaveLength(1);
    expect(done.traces[0]).toMatchObject({ userIndex: 0, activities: [{ key: 't1', label: 'Read math.ts' }] });
  });

  it('marks a turn this client started as its own', () => {
    expect(run([{ type: 'session', session: session() }, { type: 'turn-start', sessionId: 's1', prompt: 'x' }]).ownTurn).toBe(true);
  });
});

describe('the composer', () => {
  it('finds the / or @ token under the caret', () => {
    expect(tokenAtCaret('/mod', 4)).toEqual({ kind: '/', query: 'mod', start: 0 });
    expect(tokenAtCaret('/model x', 8)).toBeUndefined();
    expect(tokenAtCaret('look at @src/ma', 15)).toEqual({ kind: '@', query: 'src/ma', start: 8 });
    expect(tokenAtCaret('mail me@example', 15)).toBeUndefined();
  });

  it('sends attached selections as fenced blocks and pasted images as paths', () => {
    const text = composeMessage('why?', [
      { kind: 'selection', mention: { path: '/w/a.ts', label: 'a.ts', startLine: 2, endLine: 3, text: 'x\ny', languageId: 'typescript' } },
      { kind: 'image', path: '/tmp/shot.png' },
    ]);
    expect(text).toBe('why?\n\n`a.ts` lines 2-3:\n```typescript\nx\ny\n```\n\n/tmp/shot.png');
  });
});

describe('mentions', () => {
  it('ranks a file name match above a path match above letters in order', () => {
    expect(mentionScore('src/math.ts', 'math')).toBe(0);
    expect(mentionScore('src/fmath.ts', 'math')).toBe(1);
    expect(mentionScore('math/index.ts', 'math')).toBe(2);
    expect(mentionScore('src/my-app/tsconfig.json', 'mat')).toBe(3);
    expect(mentionScore('src/a.ts', 'zz')).toBeUndefined();
  });
});

describe('segmented settings', () => {
  const pick = (current: string) => ({
    kind: 'pick' as const, title: 'Settings', canGoBack: false,
    items: [{ label: 'Effort', inline: { current, choices: ['default', 'low', 'high'].map((value) => ({ label: value, value })) } }],
  });
  it('keeps cycling until the chosen value is reached', () => {
    const target = { title: 'Settings', label: 'Effort', value: 'high', steps: 3 };
    expect(inlineStep(target, pick('low'))).toEqual({ index: 0 });
    expect(inlineStep(target, pick('high'))).toBe('done');
    expect(inlineStep({ ...target, steps: 0 }, pick('low'))).toBe('done');
    expect(inlineStep(undefined, pick('low'))).toBeUndefined();
  });
});

describe('formatting', () => {
  it('finds a path with its line in a tool label', () => {
    expect(pathIn('Read src/math.ts:12')).toEqual({ path: 'src/math.ts', line: 12, index: 5 });
    expect(pathIn('Edit README.md')).toMatchObject({ path: 'README.md' });
    expect(pathIn('run npm test')).toBeUndefined();
  });

  it('says when things happened and reset', () => {
    const now = Date.parse('2026-09-29T12:00:00Z');
    expect(relativeTime('2026-09-29T11:58:00Z', now)).toBe('2m ago');
    expect(relativeTime('2026-09-29T07:00:00Z', now)).toBe('5h ago');
    expect(resetIn('2026-09-29T14:30:00Z', now)).toBe('resets in 3h');
    expect(resetIn('2026-09-29T11:00:00Z', now)).toBeUndefined();
  });
});

import { applyHunks, diffInDetail } from '../../src/text';

describe('an agent edit described in an approval', () => {
  const detail = [
    '/w/math.ts', '',
    '    return values.reduce(add, 0) / values.length;',
    '  }', '+ ', '+ export function median(values: number[]): number {', '+   return 0;', '+ }',
    '', 'why: ask mode',
  ].join('\n');
  const file = 'export function mean(values: number[]): number {\n  return values.reduce(add, 0) / values.length;\n}\n';

  it('reads the path and the hunks', () => {
    const parsed = diffInDetail(detail)!;
    expect(parsed.path).toBe('/w/math.ts');
    expect(parsed.hunks).toHaveLength(1);
    expect(parsed.hunks[0]!.after.at(-1)).toBe('}');
    expect(diffInDetail('npm test\n\ncwd: /w\nwhy: ask')).toBeUndefined();
  });

  it('applies them to the file on disk for a whole-file diff, and refuses when a hunk does not fit', () => {
    const after = applyHunks(file, diffInDetail(detail)!.hunks)!;
    expect(after).toContain('export function median(values: number[]): number {');
    expect(after.startsWith('export function mean')).toBe(true);
    expect(applyHunks('something else\n', diffInDetail(detail)!.hunks)).toBeUndefined();
  });
});
