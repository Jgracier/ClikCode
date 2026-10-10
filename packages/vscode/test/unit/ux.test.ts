import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyEvent, conversationAttention, emptyModel, liveElapsedMs, type ChatModel } from '../../src/model';
import { waitingOnUser } from '../../src/webview/chat';
import { supportsSecondarySidebar } from '../../src/compat';
import { mentionScore } from '../../src/text';
import { composeMessage, paletteEntry, promptHistory, tokenAtCaret } from '../../src/webview/composer';
import { commandPaletteMatches } from '../../../../src/tui/command-palette';
import { approvalHeading } from '../../../../src/tui/render/approval-keys';
import { accountUsageText } from '../../../../src/harness/accounts/usage-reading';
import { noticeLevel } from '../../src/text';
import { modelWithEffort, toggleAgent } from '../../src/webview/picker';
import { conversationSection, rowState } from '../../src/webview/screens';
import { splitEditorContext } from '../../src/editor-context';
import { pathIn, relativeTime } from '../../src/webview/format';
import type { HarnessSession, IdeEvent } from '../../src/protocol';

const session = (patch: Partial<HarnessSession> = {}): HarnessSession => ({
  id: 's1', route: 'local', accountId: null, provider: 'opencode', model: 'opencode/big-pickle', effort: 'medium',
  permissionMode: 'ask', createdAt: '', updatedAt: '', status: 'active', nativeHarness: 'opencode',
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
    // Yesterday is Recent by the 24-hour rule, not "Previous 7 days".
    expect(conversationSection({ ...row, updatedAt: '2026-10-02T13:00:00.000Z' }, now)).toBe('active');
    expect(conversationSection(row, now)).toBe('past');
  });
});

describe('a history row\'s state', () => {
  const now = Date.parse('2026-10-03T12:00:00.000Z');
  const row = { id: 'a', title: 't', updatedAt: '2026-10-03T11:55:00.000Z', messages: 1, current: false };
  it('is the terminal\'s: when, working, stalled, needs you', () => {
    expect(rowState(row, now)).toEqual({ kind: 'idle', text: '5m ago' });
    expect(rowState({ ...row, activity: 'working', turn: { startedAt: '2026-10-03T11:57:00.000Z', activeAt: '2026-10-03T11:59:50.000Z', agents: 2 } }, now).text).toBe('working 3m · 2 agents');
    expect(rowState({ ...row, activity: 'working', turn: { startedAt: '2026-10-03T11:40:00.000Z', activeAt: '2026-10-03T11:56:00.000Z' } }, now).text).toBe('stalled 4m');
    expect(rowState({ ...row, needsYou: true }, now).kind).toBe('needs-you');
  });

  it('needs you when one of VS Code\'s own panels holds an approval, and still works on a bridge that sends no turn', () => {
    expect(rowState({ ...row, attention: 'waiting' }, now).text).toBe('needs you');
    expect(rowState({ ...row, activity: 'working' }, now)).toEqual({ kind: 'working', text: 'working' });
  });
});

describe('the Gateway agents in the model menu', () => {
  const list = {
    provider: 'gateway', custom: false, models: [{ id: 'auto', label: 'Automatic', current: true }],
    agents: [{ id: 'silas', name: 'Silas', current: false }, { id: 'vera', name: 'Vera', current: false }],
  };

  it('choosing an agent marks it alone and asks the bridge for it', () => {
    const { list: next, choice } = toggleAgent(list, 'silas');
    expect(choice).toEqual({ kind: 'agent', agent: 'silas' });
    expect(next?.agents?.map((agent) => [agent.id, agent.current])).toEqual([['silas', true], ['vera', false]]);
    expect(next?.models).toBe(list.models);
  });

  it('choosing the marked agent again clears it', () => {
    const marked = toggleAgent(list, 'silas').list;
    const { list: next, choice } = toggleAgent(marked, 'silas');
    expect(choice).toEqual({ kind: 'agent', agent: null });
    expect(next?.agents?.every((agent) => !agent.current)).toBe(true);
  });

  it('switching agents moves the one mark', () => {
    const { list: next } = toggleAgent(toggleAgent(list, 'silas').list, 'vera');
    expect(next?.agents?.map((agent) => [agent.id, agent.current])).toEqual([['silas', false], ['vera', true]]);
  });
});

describe('the approval card', () => {
  it('heads a call titled with its own command as the terminal does, so the command shows once', () => {
    expect(approvalHeading('make clean', '$ make clean')).toBe('Approve command');
    expect(approvalHeading('src/a.ts', 'src/a.ts')).toBe('Approve');
    expect(approvalHeading('Run the tests', '$ npm test')).toBe('Run the tests');
  });
});

describe('an account\'s usage in the account menu', () => {
  it('reads its windows, not only the label, and marks a learned figure as the terminal\'s /usage does', () => {
    expect(accountUsageText({ windows: [{ name: '5h', usedPct: 60 }, { name: 'weekly', usedPct: 10 }] })).toBe('5h 40% left · Weekly 90% left');
    expect(accountUsageText({ windows: [{ name: '5h', usedPct: 30 }], learned: true })).toBe('5h 70% left · estimated');
    expect(accountUsageText({ label: '$3 left', windows: [] })).toBe('$3 left');
  });
});

describe('a sign-in during a turn', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('holds the working line still and stops its clock until it is over', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    let model = run([
      { type: 'session', session: session() },
      { type: 'turn-start', sessionId: 's1', prompt: 'x' },
      worker({ type: 'waiting-start', message: 'thinking' }),
    ]);
    vi.setSystemTime(1_005_000);
    model = applyEvent(model, { type: 'sign-in-link', id: 'g', name: 'Grok Build', url: 'https://example.test' });
    expect(waitingOnUser(model)).toBe(true);
    const held = liveElapsedMs(model.live!, Date.now());
    vi.setSystemTime(1_065_000);
    expect(liveElapsedMs(model.live!, Date.now())).toBe(held);
    model = applyEvent(model, { type: 'sign-in-link', id: 'g', name: 'Grok Build', done: true });
    expect(waitingOnUser(model)).toBe(false);
    expect(model.live!.activeAt).toBe(1_065_000);
    vi.setSystemTime(1_066_000);
    expect(liveElapsedMs(model.live!, Date.now())).toBe(held + 1_000);
  });
});

describe('running cost per chat', () => {
  it("shows the bridge's dollars for this chat beside the usage, and nothing (never $0) when no cost was reported", async () => {
    const costed = applyEvent(emptyModel(), { type: 'usage', label: '5h 40% left', chatCost: 1.234 });
    expect(costed.chatCost).toBe('$1.23 this chat');
    // Cheap turns keep their figure rather than rounding to nothing.
    expect(applyEvent(emptyModel(), { type: 'usage', chatCost: 0.0042 }).chatCost).toBe('$0.0042 this chat');
    // A subscription harness reports no cost: not shown, and a later reading without one clears it.
    expect(applyEvent(emptyModel(), { type: 'usage', label: '5h 40% left' }).chatCost).toBeUndefined();
    expect(applyEvent(costed, { type: 'usage', label: '5h 40% left' }).chatCost).toBeUndefined();
  });
});

describe('usage and its reset in the composer corner', () => {
  it('keeps when the closest window resets beside the figure, and only the reset once spent', () => {
    const open = applyEvent(emptyModel(), { type: 'usage', label: '5h 40% left · Weekly 90% left', next: '5h resets 5:34PM', detail: '5h 40% left · resets 5:34PM\nWeekly 90% left' });
    expect([open.accountUsage, open.accountUsageNext, open.accountUsageDetail]).toEqual(['5h 40% left · Weekly 90% left', '5h resets 5:34PM', '5h 40% left · resets 5:34PM\nWeekly 90% left']);
    const spent = applyEvent(open, { type: 'usage', label: '5h 0% left', reset: 'Resets 5:34PM', next: '5h resets 5:34PM' });
    expect([spent.accountUsage, spent.accountUsageNext]).toEqual(['Resets 5:34PM', undefined]);
  });
});
