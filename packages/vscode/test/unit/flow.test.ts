import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyEvent, emptyModel, enterAgainReady, queuedRowLabel, stoppingTurn, takenBackText, turnHasAnswer, type Activity, type ChatModel, type LiveTurn } from '../../src/model';
import { foldedGroupCount, foldedSummary, runSummary, workingStatus } from '../../src/webview/flow';
import { commandOutputPreview } from '../../../../src/harness/protocol/activity-view';
import { turnChanges, unwindChanges } from '../../src/text';
import type { FileDiff, HarnessSession, IdeEvent } from '../../src/protocol';

const session = (patch: Partial<HarnessSession> = {}): HarnessSession => ({
  id: 's1', route: 'local', accountId: null, provider: 'opencode', model: 'opencode/big-pickle', effort: 'medium',
  permissionMode: 'ask', createdAt: '', updatedAt: '', status: 'active', nativeHarness: 'opencode',
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

describe('stop: a turn asked to stop says so until it ends', () => {
  it('says "Stopping" over the open call, and only once', () => {
    const running = applyEvent(begin(), activity({ kind: 'tool-start', id: 't', label: '$ sleep 30', category: 'run' }));
    expect(workingStatus(running.live, false, Date.now()).label).toBe('Running sleep…');
    const stopping = stoppingTurn(running);
    expect(stopping.live!.stopping).toBe(true);
    expect(workingStatus(stopping.live, false, Date.now()).label).toBe('Stopping…');
    expect(stoppingTurn(stopping)).toBe(stopping);
    // A snapshot or a delta while it stops keeps it stopping.
    expect(applyEvent(stopping, worker({ type: 'delta', text: 'more', mode: 'append' })).live!.stopping).toBe(true);
  });

  it('is not a state of a turn that is not running, nor of the next turn', () => {
    expect(stoppingTurn(emptyModel())).toEqual(emptyModel());
    const ended = run([worker({ type: 'waiting-stop' }), { type: 'turn-start', sessionId: 's1', prompt: 'again' }, worker({ type: 'waiting-start', message: 'thinking' })], stoppingTurn(begin()));
    expect(ended.live!.stopping).toBeUndefined();
  });
});

describe('esc / edit: taking a waiting message back', () => {
  it('puts its text back only when the worker says it left the queue', () => {
    const taking = new Map([['a', 'first'], ['b', 'second']]);
    expect(takenBackText(taking, { type: 'unqueued', id: 'a', outcome: 'removed' })).toBe('first');
    // Already steered in, or the turn running now: it stays sent, once.
    expect(takenBackText(taking, { type: 'unqueued', id: 'b', outcome: 'running' })).toBeUndefined();
    expect(taking.size).toBe(0);
    // A plain remove asked for no text.
    expect(takenBackText(taking, { type: 'unqueued', id: 'c', outcome: 'removed' })).toBeUndefined();
  });
});

describe('enter again: send into the chat', () => {
  const message = { id: 'a', text: 'first', command: false };
  const notice = { id: 'n', text: 'done', command: false, notification: true };
  const command = { id: 'c', text: '/model opus', command: true };

  it('is ready when a message of the user\'s is waiting', () => {
    expect(enterAgainReady({ queued: [notice, message], running: true })).toBe(true);
  });

  it('never with nothing running, nothing waiting, or only a notice or a command waiting', () => {
    expect(enterAgainReady({ queued: [message], running: false })).toBe(false);
    expect(enterAgainReady({ queued: [], running: true })).toBe(false);
    expect(enterAgainReady({ queued: [notice, command], running: true })).toBe(false);
  });
});

describe('esc: an answer is text or a tool', () => {
  const live = { text: '', activities: [] as Activity[] } as LiveTurn;
  it('is unanswered while only thinking', () => {
    expect(turnHasAnswer({ live })).toBe(false);
    expect(turnHasAnswer({ live: { ...live, activities: [{ key: 't', kind: 'thinking', label: 'thinking' }] } })).toBe(false);
  });
  it('has started once there is text or a tool', () => {
    expect(turnHasAnswer({ live: { ...live, text: 'hello' } })).toBe(true);
    expect(turnHasAnswer({ live: { ...live, activities: [{ key: 'c', kind: 'tool-start', label: 'read' }] } })).toBe(true);
  });
});

describe('a queued row says where it waits and what Enter does', () => {
  it('names the hold, a steer the turn could not take, and enter again', () => {
    const submissions = [{ id: 'u', text: 'x', disposition: 'queued', unsteered: true }];
    expect(queuedRowLabel({ submissions: [] }, { id: 'a' }, false)).toBe('queued');
    expect(queuedRowLabel({ submissions: [] }, { id: 'a', held: true }, true)).toBe('sending at the next pause · enter again send into the chat');
    expect(queuedRowLabel({ submissions }, { id: 'u' }, true)).toBe("queued · this turn can't take it · enter again send into the chat");
  });

  it('carries the worker\'s unsteered answer onto the typed message', () => {
    const typed = { ...emptyModel(), submissions: [{ id: 'u', text: 'x' }] };
    const next = applyEvent(typed, { type: 'worker', sessionId: 's', event: { type: 'submission', id: 'u', disposition: 'queued', unsteered: true } });
    expect(next.submissions[0]).toMatchObject({ disposition: 'queued', unsteered: true });
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
    startedAt: 0, thinkingSince: 0, activeAt: 0, ...patch,
  });

  it('says it waits for you, in the permission colour, while an approval is up', () => {
    expect(workingStatus(live(), true, 60_000)).toMatchObject({ label: 'Waiting for you…', tone: 'asking', toneClass: 'tone-permission' });
  });

  it("names the open call's work in its category's colour", () => {
    const status = workingStatus(live({ toolPhase: 'running tests', openTools: [['t', { label: 'npm test', category: 'run' }]] }), false, 30_000);
    expect(status).toMatchObject({ label: 'Running tests…', tone: 'tool', toneClass: 'tone-yellow' });
  });

  it("shows the reasoning's own heading, else writing, else thinking", () => {
    expect(workingStatus(live({ thought: { text: '**Inspecting the parser** first' }}), false, 2000).label).toBe('Inspecting the parser…');
    expect(workingStatus(live({ writingAt: 2_000 }), false, 2_500).label).toBe('Writing…');
    expect(workingStatus(live({ writingAt: 0 }), false, 3_000).label).toBe('Thinking…');
    expect(workingStatus(live({ thinkingSince: 0 }), false, 25_000).label).toBe('Thinking…');
    expect(workingStatus(live(), false, 3_000)).toMatchObject({ label: 'Thinking…', toneClass: 'tone-cyan' });
  });

  it('never turns toward red or says nothing arrived, however long it is quiet', () => {
    expect(workingStatus(live(), false, 600_000)).toMatchObject({ tone: 'thinking', toneClass: 'tone-cyan' });
  });

});

describe('a running turn folds only settled steps', () => {
  it('never folds a row still running under "earlier steps"', () => {
    const group = (kind: 'tool-start' | 'tool-done') => ({ rows: [{ kind }] });
    const lanes = ['tool-start', 'tool-start', 'tool-start', 'tool-start', 'tool-start', 'tool-done', 'tool-done', 'tool-done'] as const;
    expect(foldedGroupCount(lanes.map(group), 6), 'five agents running, three calls after').toBe(0);
    const settledFirst = ['tool-done', 'tool-done', 'tool-done', 'tool-start', 'tool-done', 'tool-done', 'tool-done', 'tool-done'] as const;
    expect(foldedGroupCount(settledFirst.map(group), 6)).toBe(2);
    expect(foldedGroupCount(Array.from({ length: 9 }, () => group('tool-done')), 6)).toBe(3);
  });
});
