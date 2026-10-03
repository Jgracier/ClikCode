import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyEvent, emptyModel, sendNowPlan, type Activity, type ChatModel, type LiveTurn } from '../../src/model';
import { foldedSummary, runSummary, workingStatus } from '../../src/webview/flow';
import { commandOutputPreview } from '../../../../src/harness/protocol/activity-view';
import { turnChanges, unwindChanges } from '../../src/text';
import type { FileDiff, HarnessSession, IdeEvent } from '../../src/protocol';

const session = (patch: Partial<HarnessSession> = {}): HarnessSession => ({
  id: 's1', route: 'local', accountId: null, provider: 'opencode', model: 'opencode/big-pickle', effort: 'medium',
  permissionMode: 'ask', accountFailover: 'never', createdAt: '', updatedAt: '', status: 'active', nativeHarness: 'opencode',
  messages: [], ...patch,
});
const worker = (event: unknown): IdeEvent => ({ type: 'worker', sessionId: 's1', event } as IdeEvent);
const activity = (event: Record<string, unknown>): IdeEvent => worker({ type: 'activity', event });
const run = (events: IdeEvent[], start: ChatModel = emptyModel()): ChatModel => events.reduce(applyEvent, start);
const begin = (): ChatModel => run([
  { type: 'ready', version: '1', pid: 1 }, { type: 'session', session: session() },
  { type: 'turn-start', sessionId: 's1', prompt: 'hi' }, worker({ type: 'waiting-start', message: 'thinking' }),
]);

afterEach(() => { vi.useRealTimers(); });

describe('how long the model has thought', () => {
  it('counts from the turn start, and again from when its last call closed', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const started = begin();
    expect(started.live!.thinkingSince).toBe(1_000);
    vi.setSystemTime(5_000);
    const tool = applyEvent(started, activity({ kind: 'tool-start', id: 't', label: 'Read a.ts', category: 'read' }));
    expect(tool.live!.thinkingSince).toBe(1_000);
    vi.setSystemTime(9_000);
    const closed = applyEvent(tool, activity({ kind: 'tool-done', id: 't', label: 'Read a.ts' }));
    expect(closed.live!.thinkingSince).toBe(9_000);
  });
});

describe("a turn's changes, together", () => {
  const edit = (path: string, from: string, to: string, change?: FileDiff['change']): FileDiff => ({
    path, additions: 1, removals: 1, ...(change ? { change } : {}),
    lines: [{ kind: 'same', text: 'top' }, { kind: 'removed', text: from }, { kind: 'added', text: to }],
  });

  it('groups finished calls by file, in the order made', () => {
    const files = turnChanges([
      { kind: 'tool-done', diff: [edit('a.ts', 'x', 'y')] }, { kind: 'tool-error', diff: [edit('b.ts', 'x', 'y')] },
      { kind: 'tool-done', diff: [edit('a.ts', 'y', 'z'), { additions: 1, removals: 0, lines: [] }] },
    ]);
    expect([...files.keys()]).toEqual(['a.ts']);
    expect(files.get('a.ts')).toHaveLength(2);
  });

  it('undoes every change to a file, newest first, back to how the turn found it', () => {
    expect(unwindChanges('top\nz\nend', [edit('a.ts', 'x', 'y'), edit('a.ts', 'y', 'z')])).toEqual({ before: 'top\nx\nend', whole: true, created: false });
    const created: FileDiff = { path: 'n.ts', change: 'add', additions: 2, removals: 0, lines: [{ kind: 'added', text: 'top' }, { kind: 'added', text: 'y' }] };
    expect(unwindChanges('top\nz\n', [created, edit('n.ts', 'y', 'z')])).toEqual({ before: '', whole: true, created: true });
  });

  it('does not delete a file the turn created once it was edited by hand', () => {
    const created: FileDiff = { path: 'n.ts', change: 'add', additions: 2, removals: 0, lines: [{ kind: 'added', text: 'top' }, { kind: 'added', text: 'y' }] };
    expect(unwindChanges('top\ny\nmine\n', [created]).whole).toBe(false);
  });

  it('is not whole when the file changed since, or is gone', () => {
    expect(unwindChanges('top\nedited by hand', [edit('a.ts', 'x', 'y')]).whole).toBe(false);
    expect(unwindChanges(undefined, [edit('a.ts', 'x', 'y')]).whole).toBe(false);
  });
});

describe('send a queued message now', () => {
  const queued = [
    { id: 'a', text: 'first', command: false }, { id: 'n', text: 'done', command: false, notification: true }, { id: 'b', text: 'second', command: false },
  ];

  it('stops the turn only, for the queue head: the queue sends it next itself', () => {
    expect(sendNowPlan({ queued, running: true }, 'a')).toBe('stop');
  });

  it('takes a later one out of the queue, stops the turn, and sends it after', () => {
    expect(sendNowPlan({ queued, running: true }, 'b')).toBe('unqueue-and-stop');
  });

  it('just sends it with nothing running; never a notification or one already gone', () => {
    expect(sendNowPlan({ queued, running: false }, 'b')).toBe('send');
    expect(sendNowPlan({ queued, running: true }, 'n')).toBeUndefined();
    expect(sendNowPlan({ queued, running: true }, 'gone')).toBeUndefined();
  });
});

describe('tool rows', () => {
  const row = (patch: Partial<Activity>): Activity => ({ key: patch.label ?? 'k', kind: 'tool-done', label: 'tool', ...patch });

  it("shows a command's first two and last three lines, the middle counted", () => {
    const output = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`);
    expect(commandOutputPreview({ category: 'run', output })).toEqual({ head: ['line 1', 'line 2'], tail: ['line 10', 'line 11', 'line 12'], hidden: 7 });
    expect(commandOutputPreview({ category: 'run', output: output.slice(0, 5) })).toEqual({ head: output.slice(0, 5), hidden: 0, tail: [] });
    // Only part of it was kept: its real ends are unknown.
    expect(commandOutputPreview({ category: 'run', output, outputOmitted: 40, outputHead: ['first', 'second'] })).toEqual({ head: ['first', 'second'], hidden: 47, tail: ['line 10', 'line 11', 'line 12'] });
    expect(commandOutputPreview({ category: 'run', output, outputOmitted: 40 })).toBeUndefined();
  });

  it('folds a finished run, reads and searches in Claude Code\'s words', () => {
    const read = (path: string): Activity => row({ label: `Read ${path}`, category: 'read' });
    expect(foldedSummary([read('a.ts'), read('b.ts'), row({ label: 'Grep foo', category: 'search' })])).toBe('Read 2 files, searched 1 pattern');
    expect(foldedSummary([row({ label: '$ npm test', category: 'run' }), row({ label: '$ npm run build', category: 'run' }), read('a.ts'), read('b.ts')]))
      .toBe('Ran 2 commands · read 2 files');
    expect(foldedSummary([row({ label: 'Edit a.ts', category: 'edit' })])).toBe('Edited a.ts');
    expect(runSummary([row({ label: 'Read a.ts', category: 'read', kind: 'tool-start' })])).toBe('Reading a.ts');
  });
});

describe('the working line', () => {
  const live = (patch: Partial<LiveTurn> = {}): LiveTurn => ({
    text: '', waitingLabel: 'thinking', activities: [], reasoning: [], seen: 0, openTools: [], steers: [],
    startedAt: 0, lastEventAt: 0, thinkingSince: 0, ...patch,
  });

  it('says it waits for you, in the permission colour, while an approval is up', () => {
    expect(workingStatus(live(), true, 60_000)).toMatchObject({ label: 'Waiting for you…', tone: 'asking', stall: 0, toneClass: 'tone-permission' });
  });

  it("names the open call's work in its category's colour", () => {
    const status = workingStatus(live({ toolPhase: 'running tests', openTools: [['t', { label: 'npm test', category: 'run' }]] }), false, 30_000);
    expect(status).toMatchObject({ label: 'Running tests…', tone: 'tool', stall: 0, toneClass: 'tone-yellow' });
  });

  it("shows the reasoning's own heading, else escalating thinking words", () => {
    expect(workingStatus(live({ thought: { text: '**Inspecting the parser** first' }, lastEventAt: 1000 }), false, 2000).label).toBe('Inspecting the parser…');
    expect(workingStatus(live({ lastEventAt: 24_000 }), false, 25_000).label).toBe('Thinking more…');
    expect(workingStatus(live({ lastEventAt: 2_000 }), false, 3_000)).toMatchObject({ label: 'Thinking…', toneClass: 'tone-cyan' });
  });

  it('goes toward red as silence goes on', () => {
    expect(workingStatus(live(), false, 15_000).stall).toBeCloseTo(0.5);
    expect(workingStatus(live(), false, 40_000)).toMatchObject({ tone: 'stalled', stall: 1 });
  });
});
