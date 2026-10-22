/** A chat moved to another machine (session/move.ts): what the machine it goes
 * to keeps of its settings, the folder it goes on in, the note its agent is
 * given once, and the copy left behind -- marked moved and read-only. Each
 * "machine" is a CLIKCODE_HOME of its own here; the two-machine run over the
 * real bridge is in remote/move.vitest.test.ts. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AiHarnessAccount } from '../harness/definition.js';
import type { HarnessSession, HarnessState } from './model.js';
import { readState } from './state/read.js';
import { writeState } from './state/write.js';
import { exportChat, importChat, markMoved, planImport, reclaimMovedChat, type MoveFacts } from './move.js';
import { chatHasContent, moveChat, CHAT_HAVE_REVISION, type ChatExport, type MoveEnd, type MoveRequest } from './move-chat.js';
import { answerMoveRequest } from './move.js';
import { withMoveNote } from '../turn/resource-notes.js';
import { completeTurnCheckpoint } from '../turn/turn-journal.js';
import { normalizeImportedTranscript } from '../turn/failover-prompt.js';

// The worker side of a move: started warm where it arrives, retired where it left (worker/client.ts).
const workers = vi.hoisted(() => ({ warmed: [] as string[], retired: [] as string[] }));
vi.mock('../worker/client.js', () => ({
  warmSessionWorker: async (id: string) => { workers.warmed.push(id); },
  retireMovedWorker: async (id: string) => { workers.retired.push(id); },
  runningWorker: async () => false,
}));

const now = '2026-10-21T00:00:00.000Z';
const names = { source: 'linux', target: 'clikdeploy-prod' };

const account = (fields: Partial<AiHarnessAccount>): AiHarnessAccount => ({
  id: fields.id ?? `a-${Math.random().toString(36).slice(2)}`, provider: 'anthropic', label: 'someone', authKind: 'vendor-cli',
  models: [], status: 'ready', credentialRef: 'native:claude:default', ...fields,
});

const chat = (fields: Partial<HarnessSession> = {}): HarnessSession => ({
  id: 's1', conversationId: 'c1', route: 'local', accountId: 'mine', provider: 'anthropic', nativeHarness: 'claude', model: 'opus',
  effort: 'high', permissionMode: 'bypass', name: 'Fix the parser', nameSource: 'user', createdAt: now, updatedAt: now,
  status: 'active', workspace: '/home/me/project', nativeSessionId: 'vendor-thread-1', nativeTransport: 'acp',
  messages: [{ role: 'user', content: 'read the parser' }, { role: 'assistant', content: 'It reads tokens.' }], ...fields,
});

const state = (sessions: HarnessSession[], accounts: AiHarnessAccount[] = []): HarnessState => ({
  sessions, accounts, invocations: [], providerSettings: {}, globalSettings: { effort: 'medium', permissionMode: 'ask' },
} as unknown as HarnessState);

const exported = (fields: Partial<ChatExport['settings']> = {}): ChatExport => ({
  version: 1, sessionId: 's1', conversationId: 'c1', name: 'Fix the parser', createdAt: now,
  messages: [{ role: 'user', content: 'read the parser' }, { role: 'assistant', content: 'It reads tokens.' }],
  settings: { route: 'local', provider: 'anthropic', nativeHarness: 'claude', model: 'opus', effort: 'high', permissionMode: 'bypass', account: 'justin@webpro.ai', ...fields },
  source: { folder: '/home/me/project' },
});

let home: string;
const facts = (overrides: Partial<MoveFacts> = {}): MoveFacts => ({
  installed: async () => true, gatewaySignedIn: () => false, vendorSignIn: async () => undefined, efforts: async () => undefined, home: () => home, ...overrides,
});

/** Each machine its own state. */
const machines: Record<string, string> = {};
const on = (machine: string): void => {
  machines[machine] ??= mkdtempSync(join(tmpdir(), `cc-move-${machine}-`));
  process.env.CLIKCODE_HOME = machines[machine];
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cc-move-home-'));
  vi.spyOn(process, 'getuid').mockReturnValue(1000);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const key of Object.keys(machines)) delete machines[key]; workers.warmed = []; workers.retired = []; });

describe('what the machine it goes to keeps', () => {
  it('keeps everything it can, and says nothing when nothing changes', async () => {
    const mine = account({ label: 'justin@webpro.ai' });
    const plan = await planImport(state([], [mine]), exported(), facts());
    expect(plan.changes).toEqual([]);
    expect(plan.session).toMatchObject({ route: 'local', nativeHarness: 'claude', accountId: mine.id, model: 'opus', effort: 'high', permissionMode: 'bypass', conversationId: 'c1' });
    expect(plan.folder).toBe(home);
  });

  it('finds the same account by the email in its label', async () => {
    const mine = account({ label: 'Justin (JUSTIN@webpro.ai)' });
    const plan = await planImport(state([], [account({ label: 'other@x.io' }), mine]), exported(), facts());
    expect(plan.session.accountId).toBe(mine.id);
    expect(plan.changes).toEqual([]);
  });

  it('uses that machine’s signed-in account when the same one is not signed in there, and says so', async () => {
    const theirs = account({ label: 'gracierdigital@gmail.com' });
    const signedOut = account({ label: 'justin@webpro.ai', status: 'needs_login' });
    const plan = await planImport(state([], [signedOut, theirs]), exported(), facts());
    expect(plan.session.accountId).toBe(theirs.id);
    expect(plan.changes).toEqual(['account justin@webpro.ai is not signed in there; using gracierdigital@gmail.com.']);
  });

  it('with no account there at all, moves with none: the first message signs in', async () => {
    const plan = await planImport(state([]), exported(), facts());
    expect(plan.session.accountId).toBeNull();
    expect(plan.changes).toEqual(['account justin@webpro.ai is not signed in there; the first message there signs in.']);
  });

  it('takes the vendor’s own sign-in there for the account ClikCode has not made yet', async () => {
    const same = await planImport(state([]), exported(), facts({ vendorSignIn: async () => 'justin@webpro.ai' }));
    expect(same.changes).toEqual([]);
    const other = await planImport(state([]), exported(), facts({ vendorSignIn: async () => 'root@prod' }));
    expect(other.changes).toEqual(['account justin@webpro.ai is not signed in there; using root@prod.']);
  });

  it('keeps permissions only within what that machine allows: Bypass as root is Auto', async () => {
    vi.spyOn(process, 'getuid').mockReturnValue(0);
    vi.stubEnv('IS_SANDBOX', '');
    const theirs = account({ label: 'gracierdigital@gmail.com' });
    const plan = await planImport(state([], [theirs]), exported(), facts());
    expect(plan.session.permissionMode).toBe('auto');
    // Not asked about: what changed is in the log, and the info line shows the result.
    expect(plan.changes).toEqual(['account justin@webpro.ai is not signed in there; using gracierdigital@gmail.com.', 'Bypass → Auto (root).']);
  });

  it('keeps the model only when the account there lists it, and effort only when offered', async () => {
    const theirs = account({ label: 'justin@webpro.ai', models: ['sonnet', 'haiku'] });
    const plan = await planImport(state([], [theirs]), exported(), facts({ efforts: async () => ['low', 'medium'] }));
    expect(plan.session.model).toBe('sonnet');
    expect(plan.session.effort).toBe('medium');
    expect(plan.changes).toEqual(['model opus is not available there; using sonnet.', 'Effort high → medium.']);
  });

  it('a provider not installed there stays the chat’s: its first turn installs it and signs in', async () => {
    // That machine last ran Codex: the chat does not go to it.
    const plan = await planImport(state([chat({ id: 'there', conversationId: 'there', nativeHarness: 'codex', provider: 'openai', model: 'gpt-5' })]), exported(), facts({ installed: async () => false }));
    expect(plan.session).toMatchObject({ route: 'local', nativeHarness: 'claude', provider: 'anthropic', model: 'opus' });
    expect(plan.changes).toEqual(['Claude Code is not installed there; the first message installs it and signs in.']);
  });

  it('ClikDeploy Gateway is kept where it is signed in, with its settings', async () => {
    const plan = await planImport(state([]), exported({ route: 'gateway', provider: null, nativeHarness: undefined, model: 'claude-opus', account: undefined, speed: 'fast' }), facts({ gatewaySignedIn: () => true }));
    expect(plan.changes).toEqual([]);
    expect(plan.session).toMatchObject({ route: 'gateway', model: 'claude-opus', speed: 'fast', accountId: null });
  });

  it('goes on in the folder this conversation used on that machine before, else that machine’s home', async () => {
    const used = mkdtempSync(join(tmpdir(), 'cc-move-used-'));
    const moved = chat({ workspace: used, movedTo: { machine: 'linux', sessionId: 's1', at: now } });
    expect((await planImport(state([moved]), exported(), facts())).folder).toBe(used);
    const gone = chat({ workspace: join(used, 'removed-since') });
    expect((await planImport(state([gone]), exported(), facts())).folder).toBe(home);
    // Never the folder it had where it came from.
    expect((await planImport(state([]), exported(), facts())).folder).not.toBe('/home/me/project');
  });
});

describe('a move between two machines', () => {
  const sent: string[] = [];
  const end = (machine: string, name: string): MoveEnd => ({
    name,
    call: async <T>(request: MoveRequest): Promise<T> => {
      sent.push(`${name} ${request.type}${'dryRun' in request ? ' (dry run)' : ''}`);
      on(machine);
      return await answerMoveRequest(undefined, request) as T;
    },
  });
  beforeEach(() => { sent.length = 0; });

  it('carries the conversation, leaves one live copy, and tells the agent once, unseen', async () => {
    on('a');
    const mine = account({ id: 'mine', label: 'justin@webpro.ai' });
    await writeState(state([chat()], [mine]));
    on('b');
    mkdirSync(join(machines.b!), { recursive: true });
    await writeState(state([], [account({ label: 'justin@webpro.ai' })]));
    vi.stubEnv('HOME', home);
    const outcome = await moveChat(end('a', 'linux'), end('b', 'clikdeploy-prod'), 's1');
    expect(outcome).toMatchObject({ moved: true, sessionId: 's1', changes: [] });
    // The chat goes once: no dry run first.
    expect(sent).toEqual(['linux export-chat', 'clikdeploy-prod import-chat', 'linux mark-moved']);
    // Warmed where it arrived; the copy it left has its worker retired.
    expect(workers.warmed).toEqual(['s1']);
    expect(workers.retired).toEqual(['s1']);

    // There: the whole conversation, its name and id, no vendor thread, the folder there.
    on('b');
    const there = (await readState({ transcripts: ['s1'] })).sessions.find((item) => item.id === 's1')!;
    expect(there.messages?.map((message) => message.content)).toEqual(['read the parser', 'It reads tokens.']);
    expect(there).toMatchObject({ conversationId: 'c1', name: 'Fix the parser', nameSource: 'user', nativeHarness: 'claude', workspace: home, status: 'active' });
    expect(there.nativeSessionId).toBeUndefined();
    expect(there.movedTo).toBeUndefined();
    expect(there.moveNote).toBe(`This conversation moved from linux (folder /home/me/project) to clikdeploy-prod (folder ${home}). Files, processes and anything started before the move are on the previous machine; paths may differ. Check the state here before relying on earlier findings.`);
    // Here: marked moved, read-only.
    on('a');
    const here = (await readState({ transcripts: [] })).sessions.find((item) => item.id === 's1')!;
    expect(here.movedTo).toMatchObject({ machine: 'clikdeploy-prod', sessionId: 's1' });
    await expect(exportChat('s1')).rejects.toThrow(/moved to clikdeploy-prod/);
    const { runSessionTurn } = await import('../turn/session-turn.js');
    await expect(runSessionTurn({} as never, 's1', 'go on')).rejects.toThrow('This chat moved to clikdeploy-prod; continue it there.');
  });

  it('asks nothing when something changes: it moves, keeping what that machine allows', async () => {
    on('c');
    await writeState(state([chat({ id: 's2', conversationId: 'c2' })], [account({ id: 'mine', label: 'justin@webpro.ai' })]));
    on('d');
    const theirs = account({ label: 'gracierdigital@gmail.com' });
    await writeState(state([], [theirs]));
    const outcome = await moveChat(end('c', 'linux'), end('d', 'imac'), 's2');
    expect(outcome).toMatchObject({ moved: true, sessionId: 's2', changes: ['account justin@webpro.ai is not signed in there; using gracierdigital@gmail.com.'] });
    expect(sent.filter((line) => line.includes('import-chat'))).toEqual(['imac import-chat']);
    on('d');
    expect((await readState({ transcripts: [] })).sessions[0]).toMatchObject({ id: 's2', accountId: theirs.id });
    on('c');
    expect((await readState({ transcripts: [] })).sessions[0]!.movedTo).toMatchObject({ machine: 'imac' });
  });

  it('an older client’s dry run is answered with what would change, and imports nothing', async () => {
    on('c2');
    await writeState(state([], [account({ label: 'gracierdigital@gmail.com' })]));
    const plan = await answerMoveRequest(undefined, { type: 'import-chat', chat: exported(), names, dryRun: true } as MoveRequest);
    expect(plan).toEqual({ changes: ['account justin@webpro.ai is not signed in there; using gracierdigital@gmail.com.'], folder: expect.any(String) });
    expect((await readState({ transcripts: [] })).sessions).toEqual([]);
    expect(workers.warmed).toEqual([]);
  });

  it('moving back takes the copy left there up again, in its folder, with what was said meanwhile', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'cc-move-back-'));
    on('e');
    await writeState(state([chat({ id: 's3', conversationId: 'c3', workspace: folder, movedTo: { machine: 'prod', sessionId: 's3', at: now }, ownedThreads: ['claude:old'] })]));
    const back: ChatExport = { ...exported(), sessionId: 's3', conversationId: 'c3', messages: [...exported().messages, { role: 'user', content: 'and on prod' }, { role: 'assistant', content: 'Done on prod.' }] };
    const imported = await importChat(back, { source: 'prod', target: 'linux' }, facts());
    expect(imported).toMatchObject({ sessionId: 's3', folder });
    const session = (await readState({ transcripts: ['s3'] })).sessions.find((item) => item.id === 's3')!;
    expect(session.movedTo).toBeUndefined();
    expect(session.nativeSessionId).toBeUndefined();
    expect(session.messages).toHaveLength(4);
    expect(session.ownedThreads).toEqual(expect.arrayContaining(['claude:old', 'claude:vendor-thread-1']));
    expect((await readState({ transcripts: [] })).sessions.filter((item) => item.conversationId === 'c3')).toHaveLength(1);
  });

  it('a live chat of the same id there keeps its own; the moved one gets another id', async () => {
    on('f');
    await writeState(state([chat({ id: 's1', conversationId: 'other', workspace: home })]));
    const imported = await importChat(exported(), names, facts());
    expect(imported.sessionId).not.toBe('s1');
    expect((await readState({ transcripts: [] })).sessions).toHaveLength(2);
  });

  it('marks moved: the copy kept here is listed nowhere -- the chat is listed where it is live', async () => {
    on('g');
    await writeState(state([chat({ id: 's4', conversationId: 'c4', name: 'Moved one' }), chat({ id: 's6', conversationId: 'c6', name: 'Stays here' })]));
    await markMoved('s4', { machine: 'imac', sessionId: 'x' });
    const read = await readState({ transcripts: [] });
    // The bridge's list (VS Code's history, other machines' boards).
    const { conversationList } = await import('../ide/queries.js');
    expect((await conversationList(read, undefined)).map((row) => row.id)).toEqual(['s6']);
    // Even as the chat the bridge has open.
    expect((await conversationList(read, 's4')).map((row) => row.id)).toEqual(['s6']);
    // The terminal board's rows, a typed /resume name, --continue, search.
    const { conversationRows } = await import('./conversation-rows.js');
    expect(conversationRows(read.sessions).map((row) => row.latest.id)).toEqual(['s6']);
    const { chatNamed, latestChat } = await import('./options.js');
    expect(chatNamed(read.sessions, 'Moved one', 'other')).toBeUndefined();
    // By its id it is still found: opening it opens the live chat (move-terminal.ts liveChat).
    expect(chatNamed(read.sessions, 's4', 'other')).toBeUndefined();
    const copy = read.sessions.find((item) => item.id === 's4')!;
    expect(copy.movedTo).toBeDefined();
    expect(chatNamed([{ ...copy, id: 'moved-1234' }], 'moved-12', 'other')).toBe('moved-1234');
    expect(latestChat(read.sessions, '/home/me/project')?.id).toBe('s6');
    const { conversationGroups } = await import('../search/conversations.js');
    expect((await conversationGroups()).map((group) => group.id)).toEqual(['c6']);
    // A move back still finds the copy it reuses.
    const { chatHave } = await import('./move.js');
    expect(await chatHave('s4')).toMatchObject({ messages: 2 });
  });

  it('an older bridge\'s moved rows are not listed', async () => {
    const { listedChats } = await import('../ide/protocol.js');
    const row = { title: 't', updatedAt: now, messages: 1, current: false };
    expect(listedChats([{ ...row, id: 'a', movedTo: 'prod' }, { ...row, id: 'b' }]).map((item) => item.id)).toEqual(['b']);
  });
});

describe('a moved chat is never locked out', () => {
  it('reclaiming the copy kept here makes it live again, its vendor thread forgotten', async () => {
    on('r');
    await writeState(state([chat({ id: 's5' })]));
    await markMoved('s5', { machine: 'imac', sessionId: 'x' });
    expect(await reclaimMovedChat('s5')).toBe('s5');
    const back = (await readState({ transcripts: ['s5'] })).sessions.find((item) => item.id === 's5')!;
    expect(back.movedTo).toBeUndefined();
    expect(back.nativeSessionId).toBeUndefined();
    expect(back.messages).toHaveLength(2);
    expect(workers.warmed).toContain('s5');
  });

  it('a client that reaches no machine it went to has the copy go on there (reclaim-moved)', async () => {
    on('r2');
    await writeState(state([chat({ id: 's7' })]));
    await markMoved('s7', { machine: 'imac', sessionId: 'x' });
    expect(await answerMoveRequest(undefined, { type: 'reclaim-moved', sessionId: 's7' })).toBe('s7');
    expect((await readState({ transcripts: [] })).sessions[0]!.movedTo).toBeUndefined();
  });
});

describe('a move sends only what the target lacks', () => {
  const sent: string[] = [];
  const imports: ChatExport[] = [];
  /** Whether each import arrived packed: to a target at revision 5 it does. */
  const packedSeen: boolean[] = [];
  /** A machine at the revision that answers chat-have; `before` runs ahead of each request. */
  const end = (machine: string, name: string, before?: (request: MoveRequest) => Promise<void>): MoveEnd => ({
    name, revision: CHAT_HAVE_REVISION,
    call: async <T>(request: MoveRequest): Promise<T> => {
      const since = request.type === 'export-chat' && request.since ? ` since ${request.since.messages}` : '';
      sent.push(`${name} ${request.type}${since}`);
      if (request.type === 'import-chat') {
        packedSeen.push('packed' in request.chat);
        imports.push(await (await import('./move.js')).unpackChat(request.chat));
      }
      await before?.(request);
      on(machine);
      return await answerMoveRequest(undefined, request) as T;
    },
  });
  beforeEach(() => { sent.length = 0; imports.length = 0; packedSeen.length = 0; });
  const said = (count: number): HarnessSession['messages'] => Array.from({ length: count }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `turn ${index}` }));
  const addOn = async (machine: string, id: string, extra: NonNullable<HarnessSession['messages']>): Promise<void> => {
    on(machine);
    const current = await readState({ transcripts: [id] });
    const session = current.sessions.find((item) => item.id === id)!;
    session.messages = [...session.messages!, ...extra];
    await writeState(current);
  };
  const messagesOn = async (machine: string, id: string) => {
    on(machine);
    return (await readState({ transcripts: [id] })).sessions.find((item) => item.id === id)!.messages;
  };

  it('back to a machine that holds the old copy: only the new turns travel, and the chat there is whole', async () => {
    on('h1');
    await writeState(state([chat({ id: 'd1', conversationId: 'cd1', messages: said(174) })]));
    on('h2');
    await writeState(state([]));
    // Away: the target holds nothing of it, so all of it goes.
    const away = await moveChat(end('h1', 'linux'), end('h2', 'prod'), 'd1');
    expect(away).toMatchObject({ moved: true, reused: 0, sent: 174 });
    expect(packedSeen).toEqual([true]);
    expect(sent).toEqual(['prod chat-have', 'linux export-chat', 'prod import-chat', 'linux mark-moved']);
    expect(imports[0]).toMatchObject({ version: 1 });
    expect(imports[0]!.base).toBeUndefined();

    // Three more turns there, then back: the 174 are not sent again.
    await addOn('h2', 'd1', [{ role: 'user', content: 'on prod' }, { role: 'assistant', content: 'Done on prod.' }, { role: 'user', content: 'and one more' }]);
    sent.length = 0; imports.length = 0;
    const back = await moveChat(end('h2', 'prod'), end('h1', 'linux'), 'd1');
    expect(back).toMatchObject({ moved: true, sessionId: 'd1', reused: 174, sent: 3 });
    expect(sent).toEqual(['linux chat-have', 'prod export-chat since 174', 'linux import-chat', 'prod mark-moved']);
    expect(imports[0]).toMatchObject({ version: 2, base: { messages: 174 } });
    expect(imports[0]!.messages.map((message) => message.content)).toEqual(['on prod', 'Done on prod.', 'and one more']);
    // Here: the whole conversation, exactly as the other machine had it.
    const here = await messagesOn('h1', 'd1');
    const there = await messagesOn('h2', 'd1');
    expect(here).toHaveLength(177);
    // As a whole-chat move would have left it: the other machine's messages, each saying whose it was.
    const origin = { harness: 'claude', route: 'local', provider: 'anthropic', model: 'opus' };
    expect(here).toEqual(there!.map((message) => ({ ...message, origin: message.origin ?? origin })));
    on('h1');
    const session = (await readState({ transcripts: ['d1'] })).sessions.find((item) => item.id === 'd1')!;
    expect(session.movedTo).toBeUndefined();
    expect(session.moveNote).toContain('moved from prod');

    // And away again: the other machine's copy is a prefix, so only the new turn goes.
    await addOn('h1', 'd1', [{ role: 'assistant', content: 'Back on linux.' }]);
    sent.length = 0;
    expect(await moveChat(end('h1', 'linux'), end('h2', 'prod'), 'd1')).toMatchObject({ reused: 177, sent: 1 });
    const again = await messagesOn('h2', 'd1');
    expect(again).toHaveLength(178);
    expect(again!.slice(0, 177)).toEqual(here);
    expect(again![177]).toMatchObject({ content: 'Back on linux.', origin });
  });

  it('a copy there that differs from this chat\'s start gets the whole chat', async () => {
    on('i1');
    await writeState(state([chat({ id: 'd2', conversationId: 'cd2', messages: said(6) })]));
    on('i2');
    // The old copy there says something else at its start (this chat was rewound and went another way).
    await writeState(state([chat({ id: 'd2', conversationId: 'cd2', messages: [{ role: 'user', content: 'something else' }, ...said(6).slice(1, 4)], movedTo: { machine: 'linux', sessionId: 'd2', at: now } })]));
    const moved = await moveChat(end('i1', 'linux'), end('i2', 'prod'), 'd2');
    expect(moved).toMatchObject({ reused: 0, sent: 6 });
    expect(sent).toEqual(['prod chat-have', 'linux export-chat since 4', 'prod import-chat', 'linux mark-moved']);
    expect((await messagesOn('i2', 'd2'))!.map((message) => message.content)).toEqual(said(6)!.map((message) => message.content));
  });

  it('a copy there that changed after it said what it holds: the whole chat is sent instead', async () => {
    on('j1');
    await writeState(state([chat({ id: 'd3', conversationId: 'cd3', messages: said(8) })]));
    on('j2');
    await writeState(state([chat({ id: 'd3', conversationId: 'cd3', messages: said(6), movedTo: { machine: 'linux', sessionId: 'd3', at: now } })]));
    let changed = false;
    const target = end('j2', 'prod', async (request) => {
      if (request.type !== 'import-chat' || changed) return;
      changed = true;
      on('j2');
      const current = await readState({ transcripts: ['d3'] });
      current.sessions[0]!.messages = [{ role: 'user', content: 'rewritten' }, ...said(6)!.slice(1)];
      await writeState(current);
    });
    const moved = await moveChat(end('j1', 'linux'), target, 'd3');
    expect(moved).toMatchObject({ reused: 0, sent: 8 });
    expect(sent).toEqual(['prod chat-have', 'linux export-chat since 6', 'prod import-chat', 'linux export-chat', 'prod import-chat', 'linux mark-moved']);
    expect(await messagesOn('j2', 'd3')).toHaveLength(8);
  });

  it('a target from before chat-have is not asked, and gets the whole chat', async () => {
    on('k1');
    await writeState(state([chat({ id: 'd4', conversationId: 'cd4', messages: said(4) })]));
    on('k2');
    await writeState(state([chat({ id: 'd4', conversationId: 'cd4', messages: said(2), movedTo: { machine: 'linux', sessionId: 'd4', at: now } })]));
    const old = { ...end('k2', 'prod'), revision: 4 };
    expect(await moveChat(end('k1', 'linux'), old, 'd4')).toMatchObject({ reused: 0, sent: 4 });
    expect(sent).toEqual(['linux export-chat', 'prod import-chat', 'linux mark-moved']);
    // Not packed: an older ClikCode could not open it.
    expect(packedSeen).toEqual([false]);
  });

  it('an importer refuses a delta whose base it does not hold', async () => {
    on('l1');
    await writeState(state([]));
    const delta: ChatExport = { ...exported(), version: 2, base: { messages: 3, hash: 'nope' } };
    await expect(importChat(delta, names, facts())).rejects.toThrow(/changed/);
    expect((await readState({ transcripts: [] })).sessions).toEqual([]);
  });
});

describe('the note to the agent', () => {
  it('rides in front of the first turn’s text, as ClikCode’s own, and only while it is on the chat', () => {
    expect(withMoveNote({}, 'go on')).toBe('go on');
    const sent = withMoveNote({ moveNote: 'This conversation moved from a to b.' }, 'go on');
    expect(sent).toBe('<clikcode_resource_note>\nThis conversation moved from a to b.\n</clikcode_resource_note>\n\ngo on');
    // A vendor's copy of that turn, read back into the transcript, is the user's words only.
    expect(normalizeImportedTranscript([{ role: 'user', content: sent }])).toEqual([{ role: 'user', content: 'go on' }]);
  });

  it('is cleared when the first turn completes, and never stored as a message', async () => {
    const session = chat({ moveNote: 'This conversation moved from a to b.' });
    const saved: string[] = [];
    await completeTurnCheckpoint(session, { complete: async (text: string) => { saved.push(text); } } as never, 'answer');
    expect(session.moveNote).toBeUndefined();
    expect(JSON.stringify(session.messages)).not.toContain('moved from');
  });

  it('is not part of what the chat exports', async () => {
    on('h');
    await writeState(state([chat({ id: 's5', nativeSessionId: undefined, moveNote: 'This conversation moved from a to b.' })]));
    const out = await exportChat('s5');
    expect(JSON.stringify(out)).not.toContain('moved from');
    expect(out.settings).not.toHaveProperty('moveNote');
  });
});

describe('an empty chat', () => {
  it('has nothing to move', () => {
    expect(chatHasContent({ messages: [] })).toBe(false);
    expect(chatHasContent({ messages: [{ role: 'user', content: 'x' }] })).toBe(true);
  });
});

describe('a chat as it travels', () => {
  it('is packed to a fraction of its size and unpacked exactly', async () => {
    const { packChat, unpackChat } = await import('./move.js');
    const messages = Array.from({ length: 200 }, (_, index) => ({ role: index % 2 ? 'assistant' as const : 'user' as const, content: `turn ${index}: ${'the same kind of text again and again. '.repeat(40)}` }));
    const chat = { version: 1 as const, sessionId: 's', conversationId: 'c', createdAt: '', messages, settings: { route: 'local' as const, provider: null, model: null, effort: 'high' }, source: {} } as never;
    const packed = await packChat(chat);
    expect(packed).toMatchObject({ sessionId: 's', count: 200 });
    expect(packed.packed.length).toBeLessThan(JSON.stringify(chat).length / 3);
    expect(await unpackChat(packed)).toEqual(chat);
    expect(await unpackChat(chat)).toBe(chat);
  });
});
