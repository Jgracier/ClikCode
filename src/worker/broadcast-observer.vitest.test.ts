import type { Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { MarkSequencer } from '../turn/turn-marks';
import { BroadcastObserver, windowReadsSaved } from './broadcast-observer';

function fakeClient(): { socket: Socket; frames: Record<string, unknown>[] } {
  const frames: Record<string, unknown>[] = [];
  const socket = { write: (frame: string) => { frames.push(JSON.parse(frame)); return true; } } as unknown as Socket;
  return { socket, frames };
}

describe('sign-in from a worker', () => {
  const request = { command: 'hermes', argv: ['auth', 'add', 'nous'], environment: {}, name: 'Hermes › nous' };

  it('asks the attached window to run the sign-in and waits for its answer', async () => {
    const observer = new BroadcastObserver();
    const client = fakeClient();
    observer.attach(client.socket);
    const signedIn = observer.signIn(request);
    const sent = client.frames.find((frame) => frame.type === 'sign-in-request') as { id: string } & typeof request;
    expect(sent).toMatchObject(request);
    observer.resolveSignIn(sent.id);
    await expect(signedIn).resolves.toBeUndefined();
  });

  it('fails the sign-in the window reports failed', async () => {
    const observer = new BroadcastObserver();
    const client = fakeClient();
    observer.attach(client.socket);
    const signedIn = observer.signIn(request);
    const sent = client.frames.find((frame) => frame.type === 'sign-in-request') as { id: string };
    observer.resolveSignIn(sent.id, 'hermes exited with status 1');
    await expect(signedIn).rejects.toThrow('hermes exited with status 1');
  });

  it('fails at once with no window to run it in', async () => {
    await expect(new BroadcastObserver().signIn(request)).rejects.toThrow('needs an open ClikCode window');
  });
});

describe('a request nobody has answered yet', () => {
  it('is asked again of a window that attaches later, and the answer still reaches the turn', async () => {
    const observer = new BroadcastObserver();
    observer.startTurn('thinking', 'fix it');
    // Asked with nobody attached: it used to go nowhere, for ever.
    const approved = observer.approval('Run npm test?', 'npm test', undefined, 'Bash(npm test:*)');
    const late = fakeClient();
    observer.attach(late.socket);
    observer.reofferPending(late.socket);
    const asked = late.frames.find((frame) => frame.type === 'approval-request') as { id: string };
    expect(asked).toMatchObject({ title: 'Run npm test?', detail: 'npm test', rule: 'Bash(npm test:*)' });
    observer.resolveApproval(asked.id, 'always');
    await expect(approved).resolves.toBe('always');
    // Answered: not offered to the next window.
    const later = fakeClient();
    observer.reofferPending(later.socket);
    expect(later.frames).toEqual([]);
  });

  it('re-offers a sign-in to a window attaching after the one that was asked left', async () => {
    const observer = new BroadcastObserver();
    const first = fakeClient();
    observer.attach(first.socket);
    const signedIn = observer.signIn({ command: 'hermes', argv: [], environment: {}, name: 'Hermes' });
    observer.detach(first.socket);
    const second = fakeClient();
    observer.attach(second.socket);
    observer.reofferPending(second.socket);
    const asked = second.frames.find((frame) => frame.type === 'sign-in-request') as { id: string };
    expect(asked).toMatchObject({ command: 'hermes' });
    observer.resolveSignIn(asked.id);
    await expect(signedIn).resolves.toBeUndefined();
  });

  it('is refused when its turn ends, so nothing is left waiting', async () => {
    const observer = new BroadcastObserver();
    observer.startTurn('thinking');
    const approved = observer.approval('Write a.txt?');
    observer.stopWaiting();
    await expect(approved).resolves.toBe(false);
    expect(observer.pendingRequestCount).toBe(0);
  });

  it('names the running prompt in waiting-start and in the live snapshot', () => {
    const observer = new BroadcastObserver();
    const client = fakeClient();
    observer.attach(client.socket);
    observer.startTurn('thinking', '[background shell bash_1 exited (code 0)] make');
    expect(client.frames[0]).toEqual({ type: 'waiting-start', message: 'thinking', prompt: '[background shell bash_1 exited (code 0)] make' });
    expect(observer.liveSnapshot()).toMatchObject({ prompt: '[background shell bash_1 exited (code 0)] make' });
  });
});

describe('a notice about the turn', () => {
  it('reaches every window as a line of the transcript, not as a passing thought', () => {
    const observer = new BroadcastObserver();
    const client = fakeClient();
    observer.attach(client.socket);
    observer.startTurn('thinking');
    observer.activity('The answer was cut off: the model reached its output limit.');
    // `seq`/`responseOffset` are additive: where the notice sits in the turn.
    expect(client.frames.at(-1)).toMatchObject({ type: 'note', message: 'The answer was cut off: the model reached its output limit.', seq: 1, responseOffset: 0 });
    expect(observer.turnOutputStarted).toBe(true);
  });
});

describe('a window joining a running turn', () => {
  it('keeps changed output from one running tool while dropping identical duplicate events', () => {
    const observer = new BroadcastObserver();
    const client = fakeClient();
    observer.attach(client.socket);
    observer.startTurn('running tests');
    const started = { kind: 'tool-start' as const, id: 'test', label: 'Bash(npm test)', output: ['file 1 passed'] };
    observer.activityEvent(started);
    observer.activityEvent(started);
    observer.activityEvent({ ...started, output: ['file 1 passed', 'file 2 passed'] });
    expect(client.frames.filter((frame) => frame.type === 'activity')).toHaveLength(2);
    expect(observer.liveSnapshot()?.activities.at(-1)?.event.output).toEqual(['file 1 passed', 'file 2 passed']);
  });

  it('is given the turn\'s tool rows, where they fell in its answer, and its plan', () => {
    const observer = new BroadcastObserver();
    observer.startTurn('thinking', 'fix the build');
    observer.response('Looking first.');
    observer.activityEvent({ kind: 'thinking', label: 'pondering' });
    observer.activityEvent({ kind: 'tool-start', id: 't1', label: 'Bash(npm test)' });
    observer.response(' Then fixing.');
    observer.activityEvent({ kind: 'tool-done', id: 't1', label: 'Bash(npm test)' });
    observer.setPlan([{ content: 'fix it', status: 'in_progress' }]);
    expect(observer.liveSnapshot()).toMatchObject({
      text: 'Looking first. Then fixing.', waitingLabel: 'thinking', prompt: 'fix the build',
      // A thought is never an activity row, so it is not one here either
      // (it is a mark: see `marks`). Each row carries the worker's seq.
      activities: [
        { event: { kind: 'tool-start', id: 't1', label: '$ npm test', category: 'run', seq: 2 }, responseOffset: 14 },
        { event: { kind: 'tool-done', id: 't1', label: '$ npm test', category: 'run', seq: 2 }, responseOffset: 27 },
      ],
      plan: [{ content: 'fix it', status: 'in_progress' }],
      marks: [{ kind: 'thought', seq: 1, responseOffset: 14 }, { kind: 'plan', seq: 3 }],
    });
    // The next turn starts from nothing.
    observer.stopWaiting();
    observer.startTurn('thinking', 'next');
    expect(observer.liveSnapshot()).toMatchObject({ text: '', activities: [], plan: [] });
  });

  it('is told the turn is over by a snapshot without `live`, then waiting-stop', () => {
    const observer = new BroadcastObserver();
    const client = fakeClient();
    observer.attach(client.socket);
    observer.startTurn('thinking', 'go');
    observer.render({ id: 's' } as never);
    observer.endTurn({ id: 's' } as never, 'work');
    const [midTurn, final, stop] = client.frames.slice(-3);
    expect(midTurn).toMatchObject({ type: 'snapshot', live: { prompt: 'go' } });
    expect(final).toEqual({ type: 'snapshot', session: { id: 's' }, account: 'work' });
    expect(stop).toEqual({ type: 'waiting-stop' });
  });
});

describe('a window that stops reading', () => {
  it('is let go once too far behind, instead of growing the worker without bound', () => {
    const observer = new BroadcastObserver();
    const written: string[] = [];
    let destroyed = false;
    const stalled = {
      writableLength: 0,
      get destroyed() { return destroyed; },
      write(frame: string) { written.push(frame); this.writableLength += frame.length; return false; },
      destroy() { destroyed = true; },
    };
    observer.attach(stalled as unknown as Socket);
    observer.startTurn('thinking');
    const chunk = 'x'.repeat(1024 * 1024);
    for (let index = 0; index < 40; index += 1) observer.response(chunk);
    expect(destroyed).toBe(true);
    // Nothing more is queued for it once it is closed.
    expect(stalled.writableLength).toBeLessThan(18 * 1024 * 1024);
    const before = written.length;
    observer.response('more');
    expect(written.length).toBe(before);
  });
});

describe('an approval another process can see', () => {
  it('tells the worker which approval waits, oldest first, and when none does', async () => {
    const observer = new BroadcastObserver();
    const client = fakeClient();
    observer.attach(client.socket);
    const told: Array<string | undefined> = [];
    observer.onAwaitingApproval = (approval) => { told.push(approval?.title); };
    const first = observer.approval('Run npm test?');
    const second = observer.approval('Write a.txt?');
    const [one, two] = client.frames.filter((frame) => frame.type === 'approval-request') as Array<{ id: string }>;
    observer.resolveApproval(one!.id, true);
    observer.resolveApproval(two!.id, false);
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(false);
    expect(told).toEqual(['Run npm test?', 'Run npm test?', 'Write a.txt?', undefined]);
  });
});

describe('an approval is recorded before it is asked', () => {
  it('waits for the record to be written before a window sees the question', async () => {
    const observer = new BroadcastObserver();
    const client = fakeClient();
    observer.attach(client.socket);
    let written!: () => void;
    observer.onAwaitingApproval = () => new Promise<void>((resolve) => { written = resolve; });
    void observer.approval('Delete build/?');
    expect(client.frames.some((frame) => frame.type === 'approval-request')).toBe(false);
    written();
    await new Promise((resolve) => setImmediate(resolve));
    expect(client.frames.some((frame) => frame.type === 'approval-request')).toBe(true);
  });
});

describe('a turn waiting on the user, for its closing line', () => {
  it('is timed from an approval asked to its answer, under the worker\'s conversation', async () => {
    const { userWaitedMs, resetUserWait } = await import('../turn/user-wait.js');
    const observer = new BroadcastObserver();
    observer.sessionId = 'waits';
    resetUserWait('waits');
    const asked = observer.approval('Run it?');
    expect(userWaitedMs('waits', Date.now() + 5_000)).toBeGreaterThanOrEqual(5_000);
    const [id] = [...(observer as unknown as { pendingApprovals: Map<string, unknown> }).pendingApprovals.keys()];
    observer.resolveApproval(id!, true);
    await asked;
    const waited = userWaitedMs('waits');
    expect(userWaitedMs('waits', Date.now() + 60_000)).toBe(waited);
  });
});


describe('a harness question', () => {
  const request = { title: 'Codex asks', questions: [{ id: 'a', prompt: 'Which?', options: [{ label: 'x' }, { label: 'y' }] }] };

  it('reaches a window, is re-offered to a late one, and carries the answer back', async () => {
    const observer = new BroadcastObserver();
    observer.startTurn('thinking');
    const answered = observer.askQuestions(request);
    const late = fakeClient();
    observer.attach(late.socket);
    observer.reofferPending(late.socket);
    const asked = late.frames.find((frame) => frame.type === 'question-request') as { id: string };
    expect(asked).toMatchObject({ request });
    expect(observer.pendingRequestCount).toBe(1);
    observer.resolveQuestion(asked.id, { kind: 'answered', answers: { a: ['y'] } });
    await expect(answered).resolves.toEqual({ kind: 'answered', answers: { a: ['y'] } });
    expect(observer.pendingRequestCount).toBe(0);
  });

  it('closes in every window when the vendor withdraws it, and is cancelled', async () => {
    const observer = new BroadcastObserver();
    const client = fakeClient();
    observer.attach(client.socket);
    observer.startTurn('thinking');
    const controller = new AbortController();
    const answered = observer.askQuestions(request, controller.signal);
    const asked = client.frames.find((frame) => frame.type === 'question-request') as { id: string };
    controller.abort();
    await expect(answered).resolves.toEqual({ kind: 'cancelled' });
    expect(client.frames).toContainEqual({ type: 'request-closed', id: asked.id });
  });

  it('closes an approval the same way', async () => {
    const observer = new BroadcastObserver();
    const client = fakeClient();
    observer.attach(client.socket);
    observer.startTurn('thinking');
    const controller = new AbortController();
    const approved = observer.approval('Run make?', undefined, undefined, undefined, controller.signal);
    const asked = client.frames.find((frame) => frame.type === 'approval-request') as { id: string };
    controller.abort();
    await expect(approved).resolves.toBe(false);
    expect(client.frames).toContainEqual({ type: 'request-closed', id: asked.id });
  });

  it('is cancelled when its turn ends, so nothing is left waiting', async () => {
    const observer = new BroadcastObserver();
    observer.startTurn('thinking');
    const answered = observer.askQuestions(request);
    observer.stopWaiting();
    await expect(answered).resolves.toEqual({ kind: 'cancelled' });
    expect(observer.pendingRequestCount).toBe(0);
  });
});

describe('worker-assigned order and a window joining mid-turn (standards 1, 4, 7, 8, 11)', () => {
  const frames = (client: ReturnType<typeof fakeClient>, type: string) => client.frames.filter((frame) => frame.type === type);

  it('numbers each row once, in the order the worker first saw it, and every frame of a call carries it', () => {
    const observer = new BroadcastObserver();
    const client = fakeClient();
    observer.attach(client.socket);
    observer.startTurn('thinking', 'go');
    observer.activityEvent({ kind: 'tool-start', label: 'Read a', id: 'a' });
    observer.activityEvent({ kind: 'tool-start', label: 'Read b', id: 'b' });
    observer.activityEvent({ kind: 'tool-done', label: 'tool', id: 'b' });
    observer.activityEvent({ kind: 'tool-done', label: 'tool', id: 'a' });
    expect(frames(client, 'activity').map((frame) => (frame.event as { seq: number }).seq)).toEqual([1, 2, 2, 1]);
    observer.activity('Switched to another account');
    observer.setPlan([{ content: 'one', status: 'pending' }]);
    expect(frames(client, 'note')[0]).toMatchObject({ seq: 3, responseOffset: 0 });
    expect(frames(client, 'plan')[0]).toMatchObject({ seq: 4, responseOffset: 0 });
  });

  it('shows a window that joins mid-turn what an attached one shows: thought, settled thoughts, plan, notices, phase, usage', () => {
    const observer = new BroadcastObserver();
    observer.startTurn('thinking', 'go');
    observer.response('Hello. ');
    observer.activityEvent({ kind: 'thinking', label: '**Checking the cache** first', id: 'r1' });
    observer.activityEvent({ kind: 'tool-start', label: 'Read a', id: 'a' });
    observer.activityEvent({ kind: 'thinking', label: 'then this', id: 'r2' });
    observer.activity('Cut off at its limit');
    observer.setPlan([{ content: 'one', status: 'in_progress' }]);
    observer.phase('compacting');
    observer.setTurnUsage({ input: 10, output: 20 });
    const live = observer.liveSnapshot()!;
    expect(live.marks!.map((mark) => mark.kind)).toEqual(['thought', 'notice', 'plan']);
    expect(live.marks![0]).toMatchObject({ id: 'thought:r1', responseOffset: 7, heading: 'Checking the cache' });
    expect(live.thought).toMatchObject({ id: 'r2', text: 'then this', responseOffset: 7 });
    expect(live.phase).toBe('compacting');
    expect(live.usage).toMatchObject({ input: 10, output: 20 });
    expect(live.plan).toEqual([{ content: 'one', status: 'in_progress' }]);
  });

  it('does not open a second thought when the vendor repeats a settled one after the answer began', () => {
    const observer = new BroadcastObserver();
    observer.startTurn('thinking', 'go');
    observer.activityEvent({ kind: 'thinking', label: 'considering the options', id: 'r1' });
    observer.response('The answer.');
    observer.activityEvent({ kind: 'thinking', label: 'considering the options and deciding', id: 'r1' });
    const live = observer.liveSnapshot()!;
    expect(live.thought).toBeUndefined();
    expect(live.marks).toHaveLength(1);
    expect(live.marks![0]).toMatchObject({ kind: 'thought', responseOffset: 0, text: 'considering the options and deciding' });
  });

  it('rebases the live rows when the answer is replaced, as the journal does', () => {
    const observer = new BroadcastObserver();
    observer.startTurn('thinking', 'go');
    observer.response('Alpha beta ');
    observer.activityEvent({ kind: 'tool-start', label: 'early', id: 'e' });
    observer.activity('early note');
    observer.response('gamma delta');
    observer.activityEvent({ kind: 'tool-start', label: 'late', id: 'l' });
    observer.activity('late note');
    // The vendor's final text keeps the opening and rewrites the rest.
    observer.response('Alpha beta SOMETHING ELSE ENTIRELY', 'replace');
    const live = observer.liveSnapshot()!;
    expect(live.activities!.map((row) => row.responseOffset)).toEqual([11, 0]);
    expect(live.marks!.map((mark) => mark.responseOffset)).toEqual([11, 0]);
  });

  it('records an approval\'s outcome where it was asked, and says so to every window', async () => {
    const observer = new BroadcastObserver();
    const client = fakeClient();
    observer.attach(client.socket);
    observer.startTurn('thinking', 'go');
    observer.response('Before. ');
    const approved = observer.approval('Run npm test?');
    const asked = frames(client, 'approval-request')[0] as { id: string; seq: number; responseOffset: number };
    expect(asked).toMatchObject({ seq: 1, responseOffset: 8 });
    observer.response('Waiting.');
    observer.resolveApproval(asked.id, true);
    await approved;
    expect(frames(client, 'request-closed')[0]).toMatchObject({ id: asked.id, outcome: 'approved', label: 'Run npm test?' });
    expect(observer.liveSnapshot()!.marks![0]).toMatchObject({ kind: 'outcome', outcome: 'approved', seq: 1, responseOffset: 8 });
  });

  it('carries the call the approval was about into request-closed and the journaled outcome', async () => {
    const observer = new BroadcastObserver();
    const client = fakeClient();
    observer.attach(client.socket);
    observer.startTurn('thinking', 'go');
    const denied = observer.approval('make clean', undefined, undefined, undefined, undefined, 'call-7');
    const asked = frames(client, 'approval-request')[0] as { id: string };
    observer.resolveApproval(asked.id, false);
    await denied;
    expect(frames(client, 'request-closed')[0]).toMatchObject({ id: asked.id, outcome: 'denied', callId: 'call-7' });
    expect(observer.liveSnapshot()!.marks![0]).toMatchObject({ kind: 'outcome', outcome: 'denied', callId: 'call-7' });
  });

  it('keeps background agents for a joining window after the parent turn ends', () => {
    const observer = new BroadcastObserver();
    const client = fakeClient();
    observer.attach(client.socket);
    observer.startTurn('thinking', 'go');
    observer.setBackgroundWork({ agents: 2, terminals: 1, workflows: 1 });
    expect(frames(client, 'background')[0]).toMatchObject({ pending: 2, work: { agents: 2, terminals: 1, workflows: 1 } });
    expect(observer.liveSnapshot()!.pendingBackground).toBe(2);
    expect(observer.liveSnapshot()!.background).toEqual({ agents: 2, terminals: 1, workflows: 1 });
    // Only a terminal: the agents' number older windows read is absent, the indicator is not.
    observer.setBackgroundWork({ terminals: 2 });
    expect(frames(client, 'background').at(-1)).toMatchObject({ pending: 0, work: { terminals: 2 } });
    expect(observer.liveSnapshot()!.pendingBackground).toBeUndefined();
    expect(observer.liveSnapshot()!.background).toEqual({ terminals: 2 });
    observer.setBackgroundWork(undefined);
    expect(frames(client, 'background').at(-1)).toEqual({ type: 'background', pending: 0 });
    expect(observer.liveSnapshot()!.background).toBeUndefined();
    observer.setBackgroundWork({ agents: 1 });
    observer.stopWaiting();
    observer.snapshotFor(client.socket, { id: 's' } as never);
    expect(frames(client, 'snapshot').at(-1)).toMatchObject({ background: { agents: 1 } });
    observer.startTurn('thinking', 'again');
    expect(observer.liveSnapshot()!.pendingBackground).toBeUndefined();
  });

  it('sends where the plan row began, for a window that reads the plan and not the marks', () => {
    const observer = new BroadcastObserver();
    observer.startTurn('thinking', 'go');
    observer.response('Before. ');
    observer.setPlan([{ content: 'one', status: 'in_progress' }]);
    expect(observer.liveSnapshot()!.planOffset).toBe(8);
  });

  it('keeps no outcome for a request the turn ended under', async () => {
    const observer = new BroadcastObserver();
    observer.startTurn('thinking', 'go');
    const approved = observer.approval('Run it?');
    const marksBefore = observer.liveSnapshot()!.marks ?? [];
    observer.stopWaiting();
    await expect(approved).resolves.toBe(false);
    expect(marksBefore).toEqual([]);
  });

  it('shares the journal\'s counter and hands it every mark', () => {
    const observer = new BroadcastObserver();
    const marks: unknown[] = [];
    const thoughts: unknown[] = [];
    const sequencer = new MarkSequencer();
    sequencer.raiseTo(40);
    observer.startTurn('thinking', 'go');
    observer.bindJournal({ sequencer, recordMark: (mark) => marks.push(mark), setThought: (thought) => thoughts.push(thought), steerOrder: () => undefined });
    observer.activityEvent({ kind: 'tool-start', label: 'x', id: 'x' });
    observer.activity('hello');
    observer.activityEvent({ kind: 'thinking', label: 'hmm', id: 'r' });
    observer.activityEvent({ kind: 'tool-start', label: 'y', id: 'y' });
    expect(observer.liveSnapshot()!.activities![0]!.event.seq).toBe(41);
    expect(marks).toMatchObject([{ kind: 'notice', seq: 42 }, { kind: 'thought', seq: 43, id: 'thought:r' }]);
    expect(thoughts).toMatchObject([{ id: 'r', text: 'hmm' }, undefined]);
  });
});

describe("a turn that is the vendor's own background work", () => {
  it('says so to every window, and to one that joins mid-way, until the turn ends', () => {
    const observer = new BroadcastObserver();
    const client = fakeClient();
    observer.attach(client.socket);
    observer.startTurn('background work', undefined, true);
    expect(client.frames.find((f) => f.type === 'waiting-start')).toMatchObject({ message: 'background work', vendorWork: true });
    expect(observer.liveSnapshot()).toMatchObject({ vendorWork: true });
    observer.stopWaiting();
    expect(observer.liveSnapshot()).toBeUndefined();
  });

  it('is absent on a turn ClikCode started, even right after one', () => {
    const observer = new BroadcastObserver();
    const client = fakeClient();
    observer.attach(client.socket);
    observer.startTurn('background work', undefined, true);
    observer.startTurn('thinking', 'fix the build');
    const starts = client.frames.filter((f) => f.type === 'waiting-start');
    expect(starts[1]).not.toHaveProperty('vendorWork');
    expect(observer.liveSnapshot()).not.toHaveProperty('vendorWork');
  });
});

describe('a snapshot taken after the turn\'s record is saved', () => {
  const session = { id: 's', route: 'local', messages: [{ role: 'user', content: 'go' }, { role: 'assistant', content: 'done' }] } as never;

  it('carries the live turn while the record is still being written', () => {
    const observer = new BroadcastObserver();
    const window = fakeClient();
    observer.startTurn('thinking', 'go');
    observer.snapshotFor(window.socket, session);
    expect(window.frames.at(-1)).toMatchObject({ type: 'snapshot', live: expect.any(Object) });
  });

  it('says the turn is over, so a window never draws the saved turn and its live rows both', () => {
    const observer = new BroadcastObserver();
    const window = fakeClient();
    observer.startTurn('thinking', 'go');
    observer.turnRecordFinal();
    // A queue change landing between the record being saved and the worker telling windows the turn ended.
    observer.snapshotFor(window.socket, session);
    expect(window.frames.at(-1)).not.toHaveProperty('live');
    // The next turn is live again.
    observer.startTurn('thinking', 'again');
    observer.snapshotFor(window.socket, session);
    expect(window.frames.at(-1)).toHaveProperty('live');
  });
});

describe('a snapshot and the journal it was read against', () => {
  const folded = { id: 's', route: 'local', messages: [{ role: 'user', content: 'go' }, { role: 'assistant', content: 'done' }] } as never;
  const journaled = { id: 's', route: 'local', messages: [], pendingTurn: { prompt: 'go', response: 'do' } } as never;
  const journal = (finished: boolean) => ({ sequencer: new MarkSequencer(), recordMark: () => undefined, setThought: () => undefined, steerOrder: () => undefined, finished });

  it('is live while the journal is unfinished, and over once the folded record is what it holds', () => {
    const observer = new BroadcastObserver();
    const window = fakeClient();
    observer.startTurn('thinking', 'go');
    let finished = false;
    observer.bindJournal({ ...journal(false), get finished() { return finished; } } as never);
    observer.snapshotFor(window.socket, journaled);
    expect(window.frames.at(-1)).toHaveProperty('live');
    finished = true;
    // Read before the final write landed: still the journal, still consistent with a live view.
    observer.snapshotFor(window.socket, journaled);
    expect(window.frames.at(-1)).toHaveProperty('live');
    // Read after it: the finished turn, which must not also be drawn live.
    observer.snapshotFor(window.socket, folded);
    expect(window.frames.at(-1)).not.toHaveProperty('live');
  });
});

describe('a snapshot for a window that reads the saved conversation itself', () => {
  const conversation = { id: 's', model: 'm', messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }] };

  it('leaves the messages out and says how many there were, to that window only', () => {
    const observer = new BroadcastObserver();
    const reads = fakeClient();
    const older = fakeClient();
    windowReadsSaved(reads.socket);
    observer.attach(reads.socket);
    observer.attach(older.socket);
    observer.render(conversation as never);
    const slim = reads.frames[0] as { session: Record<string, unknown>; saved?: { count: number } };
    expect(slim.session.messages).toBeUndefined();
    expect(slim.session).toMatchObject({ id: 's', model: 'm' });
    expect(slim.saved).toEqual({ count: 3 });
    // An older window is sent all of it, as before.
    const whole = older.frames[0] as { session: { messages: unknown[] }; saved?: unknown };
    expect(whole.session.messages).toHaveLength(3);
    expect(whole.saved).toBeUndefined();
  });

  it('is not the size of the conversation, which was what got a healthy window dropped', () => {
    const observer = new BroadcastObserver();
    const reads = fakeClient();
    windowReadsSaved(reads.socket);
    observer.attach(reads.socket);
    const large = { id: 's', messages: Array.from({ length: 20 }, () => ({ role: 'user', content: 'x'.repeat(1_000_000) })) };
    observer.render(large as never);
    expect(JSON.stringify(reads.frames[0]).length).toBeLessThan(1_000);
  });

  it('sends a conversation with no messages as it is', () => {
    const observer = new BroadcastObserver();
    const reads = fakeClient();
    windowReadsSaved(reads.socket);
    observer.attach(reads.socket);
    observer.render({ id: 's' } as never);
    expect(reads.frames[0]).toMatchObject({ type: 'snapshot', session: { id: 's' } });
    expect((reads.frames[0] as { saved?: unknown }).saved).toBeUndefined();
  });
});
