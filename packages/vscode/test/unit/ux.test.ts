import { describe, expect, it } from 'vitest';
import { applyEvent, conversationAttention, emptyModel, type ChatModel } from '../../src/model';
import { supportsSecondarySidebar } from '../../src/compat';
import { mentionScore } from '../../src/text';
import { composeMessage, paletteEntry, promptHistory, tokenAtCaret } from '../../src/webview/composer';
import { commandPaletteMatches } from '../../../../src/tui/command-palette';
import { noticeLevel } from '../../src/text';
import { modelWithEffort } from '../../src/webview/picker';
import { conversationSection } from '../../src/webview/screens';
import { splitEditorContext } from '../../src/editor-context';
import { pathIn, relativeTime } from '../../src/webview/format';
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
    expect(tokenAtCaret('/model x', 8)).toEqual({ kind: '/', query: 'model x', start: 0 });
    expect(tokenAtCaret('/model x\nmore', 13)).toBeUndefined();
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

  it('sends a long paste held as a chip with the message, its text whole', () => {
    const pasted = Array.from({ length: 5 }, (_, index) => `row ${index}`).join('\r\n');
    expect(composeMessage('what is wrong here?', [{ kind: 'pasted', text: `${pasted}\r\n` }])).toBe(`what is wrong here?\n\n${pasted.replace(/\r\n/g, '\n')}`);
    expect(composeMessage('', [{ kind: 'pasted', text: 'only this\nand more' }])).toBe('only this\nand more');
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

describe('formatting', () => {
  it('finds a path with its line in a tool label', () => {
    expect(pathIn('Read src/math.ts:12')).toEqual({ path: 'src/math.ts', line: 12, index: 5 });
    expect(pathIn('Edit README.md')).toMatchObject({ path: 'README.md' });
    expect(pathIn('run npm test')).toBeUndefined();
  });

  it('says when things happened', () => {
    const now = Date.parse('2026-09-29T12:00:00Z');
    expect(relativeTime('2026-09-29T11:58:00Z', now)).toBe('2m ago');
    expect(relativeTime('2026-09-29T07:00:00Z', now)).toBe('5h ago');
  });
});

import { applyHunks, fileHunks } from '../../src/text';
import { eventDiff } from '../../../../src/agent/line-diff';

describe("a file change in an approval's preview", () => {
  const file = 'export function mean(values: number[]): number {\n  return values.reduce(add, 0) / values.length;\n}\n';
  const edited = `${file}\nexport function median(values: number[]): number {\n  return 0;\n}\n`;
  const [diff] = eventDiff(file, edited, { path: '/w/math.ts', numbered: true });

  it('reads as hunks of before and after', () => {
    const hunks = fileHunks(diff!);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.after.at(-1)).toBe('}');
    expect(hunks[0]!.before).not.toContain('export function median(values: number[]): number {');
  });

  it('applies them to the file on disk for a whole-file diff, and refuses when a hunk does not fit', () => {
    const after = applyHunks(file, fileHunks(diff!))!;
    expect(after).toContain('export function median(values: number[]): number {');
    expect(after.startsWith('export function mean')).toBe(true);
    expect(applyHunks('something else\n', fileHunks(diff!))).toBeUndefined();
  });
});

describe('composer history and notice levels', () => {
  it('recalls this conversation\'s prompts, oldest first, a repeat once', () => {
    expect(promptHistory([
      { role: 'user', content: 'one' }, { role: 'assistant', content: 'a' },
      { role: 'user', content: 'two' }, { role: 'user', content: 'two' }, { role: 'user', content: '  ' },
    ])).toEqual(['one', 'two']);
  });

  it('does not recall a notice ClikCode sent in the user\'s place', () => {
    expect(promptHistory([
      { role: 'user', content: 'one' }, { role: 'assistant', content: 'a' },
      { role: 'user', content: '[ClikCode] Background work you started was stopped: a newer build.' },
      { role: 'user', content: '[background shell 2 exited (code 0)] npm test\nok' },
    ])).toEqual(['one']);
  });

  it('reads a terminal note\'s level from its colour', () => {
    expect(noticeLevel('\u001b[33mswitched to work@example.com\u001b[39m')).toBe('warning');
    expect(noticeLevel('\u001b[1;31mfailed\u001b[0m')).toBe('error');
    expect(noticeLevel('\u001b[2mbackground task done\u001b[22m')).toBe('info');
    expect(noticeLevel('plain')).toBe('info');
  });
});

describe('slash menu', () => {
  const commands = [
    { command: '/model', description: 'Choose the model', argHint: '<model>', argValues: [{ value: 'claude-opus-5-5', label: 'Opus 5.5' }, { value: 'claude-sonnet-5-5', label: 'Sonnet 5.5' }] },
    { command: '/clear', description: 'Start over', aliases: ['/new'] },
  ].map(paletteEntry);

  it('completes a command\'s values as the terminal does', () => {
    expect(commandPaletteMatches('/model op', commands).map((row) => [row.value, row.completes])).toEqual([['/model claude-opus-5-5', true]]);
  });

  it('finds a command by its alias', () => {
    expect(commandPaletteMatches('/new', commands).map((row) => row.value)).toEqual(['/clear']);
  });
});

describe('editor context', () => {
  it('sends referenced lines as a block with the problems VS Code reports in them', () => {
    const problems = ["line 3 error: Cannot find name 'x'. (ts 2304)"];
    const selected = composeMessage('why', [{ kind: 'selection', mention: { path: '/w/a.ts', label: 'a.ts', startLine: 3, endLine: 3, text: 'x', languageId: 'typescript', problems } }]);
    expect(selected).toContain('`a.ts` line 3:');
    expect(selected).toContain('VS Code reports this problem');
  });

  it('splits references back off what was typed, for the bubble and for recall', () => {
    // An older message, sent with the open file as context.
    const older = "fix it\n\nOpen in the editor: `src/a.ts`\n\nVS Code reports these problems in `src/a.ts`:\n- line 1 error: x\n- line 2 warning: y";
    expect(splitEditorContext(older)).toEqual({ text: 'fix it', file: 'src/a.ts', problems: 2, selections: [] });
    expect(splitEditorContext('just text\n\nmore')).toEqual({ text: 'just text\n\nmore', problems: 0, selections: [] });
    // A selection with blank lines inside its code is one block.
    const withSelection = composeMessage('why?', [{ kind: 'selection', mention: { path: '/w/a.ts', label: 'src/a.ts', startLine: 2, endLine: 5, text: 'a\n\nb', languageId: 'ts' } }]);
    expect(splitEditorContext(withSelection)).toEqual({ text: 'why?', problems: 0, selections: ['a.ts:2-5'] });
    expect(promptHistory([{ role: 'user', content: older }])).toEqual(['fix it']);
  });
});
describe('conversation list', () => {
  const chat = (patch: Partial<{ sessionId: string; approvals: number; unread: boolean }>) => ({ sessionId: 'a', approvals: 0, unread: false, ...patch });
  it('marks a conversation another chat shows: a waiting approval first, then an unseen finish', () => {
    expect(conversationAttention('a', [chat({ approvals: 1, unread: true })])).toBe('waiting');
    expect(conversationAttention('a', [chat({ unread: true })])).toBe('unread');
    expect(conversationAttention('a', [chat({})])).toBeUndefined();
    expect(conversationAttention('a', [chat({ sessionId: 'b', approvals: 1 })])).toBeUndefined();
  });
});

describe('model and effort chip', () => {
  it('names them together, the model alone while it decides', () => {
    expect(modelWithEffort('opus', 'medium')).toBe('Opus Medium');
    expect(modelWithEffort('gpt-5.5', 'high')).toBe('gpt-5.5 High');
    expect(modelWithEffort('opus', 'default')).toBe('Opus');
    expect(modelWithEffort(undefined, undefined)).toBe('Default model');
  });
});

describe('the history menu lists the terminal board\'s sections', () => {
  it('uses the section ClikCode decided, and the same rule for a bridge that sends none', () => {
    const now = Date.parse('2026-10-03T12:00:00.000Z');
    const row = { id: 'a', title: 't', updatedAt: '2026-09-01T00:00:00.000Z', messages: 1, current: false };
    expect(conversationSection({ ...row, section: 'active' }, now)).toBe('active');
    expect(conversationSection({ ...row, activity: 'working' }, now)).toBe('working');
    expect(conversationSection({ ...row, updatedAt: '2026-10-03T01:00:00.000Z' }, now)).toBe('active');
    // Yesterday is Active by the 24-hour rule, not "Previous 7 days".
    expect(conversationSection({ ...row, updatedAt: '2026-10-02T13:00:00.000Z' }, now)).toBe('active');
    expect(conversationSection(row, now)).toBe('past');
  });
});
