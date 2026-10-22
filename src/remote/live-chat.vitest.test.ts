/** A chat is live in one place, and opening a copy that moved opens that one
 * (move-terminal.ts liveChat / openedChat): on the machine it went to, under
 * the id it has here, or -- only when nothing can be reached -- the copy goes on. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HarnessSession, HarnessState } from '../session/model.js';
import { readState } from '../session/state/read.js';
import { writeState } from '../session/state/write.js';
import { newMachineRecord, updateMachines } from './machines.js';
import { liveChat, openedChat } from './move-terminal.js';

vi.mock('../worker/client.js', () => ({ warmSessionWorker: async () => undefined, retireMovedWorker: async () => undefined, runningWorker: async () => false }));

// The window loop, with the remote chat and the conversation claims as fakes.
const remote = vi.hoisted(() => ({ opened: [] as Array<{ machineId: string; chatId?: string }>, returns: [] as Array<string | undefined> }));
vi.mock('./terminal-chat.js', async (original) => ({
  ...(await original<typeof import('./terminal-chat.js')>()),
  runRemoteChat: async (_terminal: unknown, _localId: string, selection: { machineId: string; chatId?: string }) => { remote.opened.push(selection); return remote.returns.shift(); },
}));
// The window's connections: the machines in `answering` answer.
const answering = vi.hoisted(() => new Set<string>());
vi.mock('./connection.js', async (original) => ({
  ...(await original<typeof import('./connection.js')>()),
  holdWindowMachines: async () => ({
    views: () => [], onChange: () => () => undefined, reconnect: () => undefined, release: () => undefined,
    channel: async (id: string) => (answering.has(id) ? { revision: 6, request: async () => undefined, close: () => undefined } : undefined),
  }),
}));
vi.mock('../session/attach.js', async (original) => ({
  ...(await original<typeof import('../session/attach.js')>()),
  claimConversation: async () => undefined, leaveConversation: async () => undefined,
}));

const now = '2026-10-21T00:00:00.000Z';
const chat = (id: string, fields: Partial<HarnessSession> = {}): HarnessSession => ({
  id, conversationId: id, route: 'local', accountId: null, provider: 'anthropic', nativeHarness: 'claude', model: 'opus',
  effort: 'high', permissionMode: 'ask', createdAt: now, updatedAt: now, status: 'active', name: id,
  messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }], ...fields,
});
const stateOf = (sessions: HarnessSession[]): HarnessState => ({
  sessions, accounts: [], invocations: [], providerSettings: {}, globalSettings: { effort: 'medium', permissionMode: 'ask' },
} as unknown as HarnessState);

let prodId: string;
let here: string;
const reachable = new Set<string>();
const reach = async (id: string): Promise<boolean> => reachable.has(id);

beforeEach(async () => {
  await writeState(stateOf([]));
  here = (await readState({ transcripts: [] })).installationId!;
  const prod = newMachineRecord({ name: 'prod', sshTarget: 'prod', ready: true, installationId: 'prod-install' });
  prodId = prod.id;
  await updateMachines(() => [prod]);
  reachable.clear();
  answering.clear();
  remote.opened.length = 0;
  remote.returns.length = 0;
});

describe('opening a chat that moved opens the live one', () => {
  it('a live chat opens as it is', async () => {
    await writeState(stateOf([chat('a')]));
    expect(await openedChat('a', reach)).toBeUndefined();
  });

  it('moved to an added machine that answers: that machine\'s chat, nothing moved or reclaimed', async () => {
    await writeState(stateOf([chat('a', { movedTo: { machine: 'prod', installationId: 'prod-install', sessionId: 'p-1', at: now } })]));
    reachable.add(prodId);
    expect(await openedChat('a', reach)).toEqual({ here: { remote: { machineId: prodId, chatId: 'p-1' } } });
    // The copy here stays a copy.
    expect((await readState({ transcripts: [] })).sessions[0]!.movedTo).toMatchObject({ machine: 'prod' });
  });

  it('moved here under another id: that id, followed on when it moved again', async () => {
    await writeState(stateOf([
      chat('a', { movedTo: { machine: 'this', installationId: here, sessionId: 'b', at: now } }),
      chat('b', { movedTo: { machine: 'this', installationId: here, sessionId: 'c', at: now } }),
      chat('c'),
    ]));
    expect(await openedChat('a', reach)).toEqual({ here: { local: 'c' } });
    // ... and on to another machine from there.
    await writeState(stateOf([
      chat('a', { movedTo: { machine: 'this', installationId: here, sessionId: 'b', at: now } }),
      chat('b', { movedTo: { machine: 'prod', installationId: 'prod-install', sessionId: 'p-2', at: now } }),
    ]));
    reachable.add(prodId);
    expect(await openedChat('a', reach)).toEqual({ here: { remote: { machineId: prodId, chatId: 'p-2' } } });
  });

  it('the machine does not answer: the copy here goes on, and one line says so', async () => {
    await writeState(stateOf([chat('a', { movedTo: { machine: 'prod', installationId: 'prod-install', sessionId: 'p-1', at: now } })]));
    const live = await openedChat('a', reach);
    expect(live).toEqual({ here: { local: 'a' }, notice: 'This chat moved to prod, which does not answer: it goes on here.' });
    expect((await readState({ transcripts: [] })).sessions[0]!.movedTo).toBeUndefined();
  });

  it('the machine is not added here: the copy here goes on', async () => {
    await writeState(stateOf([chat('a', { movedTo: { machine: 'imac', installationId: 'imac-install', sessionId: 'i-1', at: now } })]));
    expect(await openedChat('a', reach)).toMatchObject({ here: { local: 'a' }, notice: expect.stringContaining('imac, which is not added here') });
  });

  it('a cycle of moves ends in the copy opened going on, not a loop', async () => {
    const reclaim = vi.fn(async () => ({ local: 'a' }));
    await writeState(stateOf([chat('b', { movedTo: { machine: 'this', installationId: here, sessionId: 'b', at: now } })]));
    expect(await liveChat({ machine: 'this', installationId: here, sessionId: 'b', at: now }, reclaim, reach)).toMatchObject({ here: { local: 'a' } });
    expect(reclaim).toHaveBeenCalledOnce();
  });
});

describe('the window loop', () => {
  it('a remote chat left for a moved copy here (the board) opens the live chat, not the copy', async () => {
    await writeState(stateOf([chat('here-1'), chat('old', { movedTo: { machine: 'prod', installationId: 'prod-install', sessionId: 'p-1', at: now } })]));
    // The window's connection to prod answers.
    answering.add(prodId);
    // In a chat on prod, Left -> the board -> this machine's old copy; then, from the live one, back to here-1.
    remote.returns.push('old', 'here-1');
    const { ChatLoop } = await import('../commands/ai/interactive/loop.js');
    const window = { ref: { id: 'here-1' }, session: chat('here-1') } as never;
    const loop = new ChatLoop(window) as unknown as { openRemote: (terminal: unknown, selection: unknown) => Promise<void>; w: { ref: { id: string } } };
    await loop.openRemote({}, { machineId: prodId, chatId: 'p-0' });
    // The board's pick was the copy: the live chat, on prod, opened in its place.
    expect(remote.opened).toEqual([{ machineId: prodId, chatId: 'p-0' }, { machineId: prodId, chatId: 'p-1' }]);
    // Nothing reclaimed here.
    expect((await readState({ transcripts: [] })).sessions.find((item) => item.id === 'old')!.movedTo).toMatchObject({ machine: 'prod' });
  });
});
