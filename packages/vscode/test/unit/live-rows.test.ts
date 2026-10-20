/** Running calls are rows in the live flow, the account's figures follow the
 * account, and the controller's small guards. */
import { describe, expect, it } from 'vitest';
import { applyEvent, emptyModel, turnMarks, type ChatModel } from '../../src/model';
import { DraftRestores, LatestRead } from '../../src/controller/reads';
import type { HarnessSession, IdeEvent } from '../../src/protocol';

const session = (patch: Partial<HarnessSession> = {}): HarnessSession => ({
  id: 's1', route: 'local', accountId: null, provider: 'opencode', model: 'm', effort: 'medium',
  permissionMode: 'ask', createdAt: '', updatedAt: '', status: 'active', nativeHarness: 'opencode', messages: [], ...patch,
});
const worker = (event: unknown): IdeEvent => ({ type: 'worker', sessionId: 's1', event } as IdeEvent);
const activity = (event: Record<string, unknown>): IdeEvent => worker({ type: 'activity', event });
const run = (events: IdeEvent[], start: ChatModel = emptyModel()): ChatModel => events.reduce(applyEvent, start);
const begin = (): ChatModel => run([
  { type: 'ready', version: '1', pid: 1 }, { type: 'session', session: session() },
  { type: 'turn-start', sessionId: 's1', prompt: 'hi' }, worker({ type: 'waiting-start', message: 'thinking' }),
]);
const flow = (model: ChatModel) => turnMarks(model.live!.text, model.live!.activities, model.live!.reasoning, model.live!.steers);

describe('running calls are rows in the live flow', () => {
  it('a running call and a running sub-agent are marks of the flow, in order, like finished ones', () => {
    const model = run([
      activity({ kind: 'tool-start', id: 't1', label: 'Read a.ts', category: 'read' }),
      activity({ kind: 'tool-start', id: 'a1', label: 'Agent explore', agent: true }),
    ], begin());
    const marks = flow(model);
    expect(marks.map((mark) => [mark.activity?.key, mark.activity?.kind])).toEqual([['t1', 'tool-start'], ['a1', 'tool-start']]);
  });

  it('the same row turns done where it stands: same key, start and place', () => {
    const running = run([
      activity({ kind: 'tool-start', id: 't1', label: 'Read a.ts', category: 'read' }),
      activity({ kind: 'tool-start', id: 't2', label: 'Run ls', category: 'run' }),
    ], begin());
    const done = run([activity({ kind: 'tool-done', id: 't1', label: 'Read a.ts', category: 'read' })], running);
    const before = flow(running).map((mark) => mark.activity!);
    const after = flow(done).map((mark) => mark.activity!);
    expect(after.map((row) => row.key)).toEqual(before.map((row) => row.key));
    expect(after[0]!.kind).toBe('tool-done');
    expect(after[0]!.startedAt).toBe(before[0]!.startedAt);
    expect(after[0]!.offset).toBe(before[0]!.offset);
    expect(after[1]!.kind).toBe('tool-start');
  });

  it('a running sub-agent\'s children are drawn in the flow under it', () => {
    const model = run([
      activity({ kind: 'tool-start', id: 'a1', label: 'Agent explore', agent: true }),
      activity({ kind: 'tool-start', id: 'c1', parentId: 'a1', label: 'Read c1', category: 'read' }),
    ], begin());
    const text = run([{ type: 'worker', sessionId: 's1', event: { type: 'delta', text: 'Meanwhile', mode: 'append' } } as IdeEvent,
      activity({ kind: 'tool-start', id: 'c2', parentId: 'a1', label: 'Read c2', category: 'read' })], model);
    expect(flow(text).map((mark) => mark.activity?.key ?? mark.child?.child.key)).toEqual(['a1', 'c2']);
  });
});

describe('the account\'s figures follow the account', () => {
  const usage = { type: 'usage', label: '42% used', reset: undefined, next: '2nd 10%', detail: 'detail' } as unknown as IdeEvent;
  it('a switch of account clears the old account\'s usage', () => {
    let model = run([{ type: 'ready', version: '1', pid: 1 }, { type: 'session', session: session(), account: 'a@x.com' }, usage]);
    expect(model.accountUsage).toBeTruthy();
    expect(model.accountUsageNext).toBeTruthy();
    model = applyEvent(model, { type: 'session', session: session(), account: 'b@x.com' });
    expect(model.accountUsage).toBeUndefined();
    expect(model.accountUsageNext).toBeUndefined();
    expect(model.accountUsageDetail).toBeUndefined();
  });

  it('the same account keeps its figures through a snapshot', () => {
    let model = run([{ type: 'ready', version: '1', pid: 1 }, { type: 'session', session: session(), account: 'a@x.com' }, usage]);
    model = applyEvent(model, { type: 'session', session: session(), account: 'a@x.com' });
    expect(model.accountUsage).toBeTruthy();
  });
});

describe('controller guards', () => {
  it('only the newest read of the accounts may land', () => {
    const reads = new LatestRead();
    const older = reads.begin();
    const newer = reads.begin();
    expect(reads.current(older)).toBe(false);
    expect(reads.current(newer)).toBe(true);
  });

  it('a failed send\'s draft is restored once, however many reports of it arrive', () => {
    const restores = new DraftRestores(3_000);
    expect(restores.take('hello', 1_000)).toBe(true);
    expect(restores.take('hello', 1_200)).toBe(false);
    expect(restores.take('other', 1_300)).toBe(true);
    expect(restores.take('hello', 9_000)).toBe(true);
  });
});
