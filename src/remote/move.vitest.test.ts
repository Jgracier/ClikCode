/** A chat moved between two machines, as they really are: this process is one
 * (its own HOME and state), and a FAKE machine reached through the fake ssh
 * (scripts/tui-e2e/fake-ssh.mjs) is the other, running this build's REAL
 * bridge in a HOME, user and folders of its own. Nothing connects to a real
 * machine or runs a vendor CLI. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
// @ts-expect-error -- a plain .mjs fixture module
import { host } from '../../scripts/tui-e2e/fake-remote.mjs';
import type { HarnessSession, HarnessState } from '../session/model.js';
import { moveChat, type MoveEnd, type MoveRequest } from '../session/move-chat.js';
import { listWorkerRecords, readWorkerRecord } from '../worker/registry.js';
import { newMachineRecord, updateMachines } from './machines.js';
import { localMoveEnd, movedChatPlace, moveTerminalChat, remoteMoveEnd } from './move-terminal.js';
import { TerminalBridge } from './terminal-chat.js';
import { closeWindowMachines, holdWindowMachines, RemoteMachines } from './connection.js';
import type { HarnessPrompter } from '../harness/prompter.js';
import { readMachines } from './machines.js';

const REPO = resolve(__dirname, '..', '..');
const FAKES = join(REPO, 'scripts', 'tui-e2e');
const entry = join(REPO, 'dist', 'index.js');
const built = existsSync(entry) && readFileSync(join(REPO, 'dist', 'cli.js'), 'utf8').includes('export-chat');
const savedEnv = { ...process.env };
let root: string;
let prod: { home: string; bin: string };
const now = '2026-10-21T00:00:00.000Z';

const chat = (fields: Partial<HarnessSession>): HarnessSession => ({
  id: 'x', conversationId: 'x', route: 'local', accountId: null, provider: 'anthropic', nativeHarness: 'claude', model: 'opus',
  effort: 'high', permissionMode: 'ask', createdAt: now, updatedAt: now, status: 'active',
  messages: [{ role: 'user', content: 'read the parser' }, { role: 'assistant', content: 'It reads tokens.' }], ...fields,
});
const stateOf = (sessions: HarnessSession[]): HarnessState => ({
  sessions, accounts: [], invocations: [], providerSettings: {}, globalSettings: { effort: 'medium', permissionMode: 'ask' },
} as unknown as HarnessState);

/** Reads or writes the fake machine's own state, then this one's again. */
async function onProd<T>(work: () => Promise<T>): Promise<T> {
  const previous = process.env.CLIKCODE_HOME;
  process.env.CLIKCODE_HOME = join(prod.home, '.clikcode');
  try { return await work(); } finally { process.env.CLIKCODE_HOME = previous; }
}
/** Each request a machine is asked, by name. */
const sent: string[] = [];
const recorded = (end: MoveEnd): MoveEnd => ({
  name: end.name,
  get revision() { return end.revision; },
  call: <T>(request: MoveRequest): Promise<T> => {
    const since = request.type === 'export-chat' && request.since ? ` since ${request.since.messages}` : '';
    sent.push(`${end.name} ${request.type}${since}${'dryRun' in request ? ' (dry run)' : ''}`);
    return end.call<T>(request);
  },
});
const until = async <T>(check: () => Promise<T | undefined | false>, ms = 20_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const read = async () => (await import('../session/state/read.js')).readState({ transcripts: ['here-1', 'prod-1'] });
const read2 = async () => (await import('../session/state/read.js')).readState({ transcripts: [] });
const write = async (state: HarnessState) => (await import('../session/state/write.js')).writeState(state);

beforeAll(async () => {
  const clientHome = join(savedEnv.HOME!, 'client-home');
  mkdirSync(clientHome, { recursive: true });
  process.env.HOME = clientHome;
  root = mkdtempSync(join(tmpdir(), 'cc-move-'));
  const bin = join(root, 'local-bin');
  mkdirSync(bin);
  symlinkSync(join(FAKES, 'fake-ssh.mjs'), join(bin, 'ssh'));
  // No vendor CLI of the real machine: a fake `claude` that only says its version, on both machines.
  const fakeClaude = '#!/bin/sh\necho "2.1.0 (Claude Code)"\n';
  writeFileSync(join(bin, 'claude'), fakeClaude, { mode: 0o755 });
  process.env.PATH = `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`;
  process.env.FAKE_SSH_ROOT = root;
  prod = host(root, 'prod', { env: { CLIKCODE_OWN_SCOPE: '0' } });
  writeFileSync(join(prod.bin, 'claude'), fakeClaude, { mode: 0o755 });
  mkdirSync(join(prod.home, '.local', 'bin'), { recursive: true });
  writeFileSync(join(prod.home, '.local', 'bin', 'clikcode'), `#!/bin/sh\nexec ${process.execPath} ${entry} "$@"\n`, { mode: 0o755 });
  await updateMachines(() => [newMachineRecord({ name: 'prod', sshTarget: 'prod', ready: true })]);
  // Workers this process starts (the chat moved here, warmed) run this build.
  process.env.CLIKCODE_WORKER_ENTRY = entry;
  process.env.CLIKCODE_OWN_SCOPE = '0';
});

afterAll(async () => {
  // Every worker either machine still runs, stopped.
  for (const records of [await listWorkerRecords(), await onProd(listWorkerRecords)]) {
    for (const record of records) { try { process.kill(record.pid, 'SIGTERM'); } catch { /* gone */ } }
  }
  delete process.env.CLIKCODE_WORKER_ENTRY;
  delete process.env.CLIKCODE_OWN_SCOPE;
  delete process.env.FAKE_SSH_ROOT;
  process.env.PATH = savedEnv.PATH;
  process.env.HOME = savedEnv.HOME;
});

describe.skipIf(!built)('moving a chat between two machines, over the real bridge', () => {
  it('moves a chat from here to the other machine, and back', async () => {
    const folderHere = mkdtempSync(join(tmpdir(), 'cc-move-here-'));
    await write(stateOf([chat({ id: 'here-1', conversationId: 'conv-1', name: 'Fix the parser', workspace: folderHere, nativeSessionId: 'thread-here' })]));
    // The chat has a worker here, as one being used does.
    const { WorkerClient } = await import('../worker/client.js');
    const attached = await WorkerClient.attach('here-1');
    const before = (await readWorkerRecord('here-1'))!;
    attached.close();
    const bridge = new TerminalBridge('prod');
    try {
      await bridge.connected();
      sent.length = 0;
      const there = await moveChat(recorded(localMoveEnd()), recorded(remoteMoveEnd(bridge, { name: 'prod' })), 'here-1');
      expect(there).toMatchObject({ moved: true, sessionId: 'here-1', folder: prod.home });
      // One pick: the chat sent once, nothing planned first.
      // Asked first what it holds of the chat (nothing): then all of it goes.
      expect(sent).toEqual(['prod chat-have', `${localMoveEnd().name} export-chat`, 'prod import-chat', `${localMoveEnd().name} mark-moved`]);
      expect(there).toMatchObject({ reused: 0, sent: 2 });
      // Warm there before anything is sent: its worker is up.
      const warmed = await until(() => onProd(() => readWorkerRecord('here-1')));
      expect(alive(warmed.pid)).toBe(true);
      // Gone here: the copy left is read-only, and its worker does not idle out holding it.
      await until(async () => !alive(before.pid));

      // On the other machine: the conversation, in its own home, no vendor thread, the note for its agent.
      const remote = (await onProd(read)).sessions.find((item) => item.id === 'here-1')!;
      expect(remote.messages?.map((message) => message.content)).toEqual(['read the parser', 'It reads tokens.']);
      expect(remote).toMatchObject({ conversationId: 'conv-1', name: 'Fix the parser', workspace: prod.home, nativeHarness: 'claude' });
      expect(remote.nativeSessionId).toBeUndefined();
      expect(remote.moveNote).toContain(`(folder ${folderHere}) to prod (folder ${prod.home})`);
      expect(JSON.stringify(remote.messages)).not.toContain('moved from');

      // Here: one live copy, the other machine's.
      const local = (await read()).sessions.find((item) => item.id === 'here-1')!;
      expect(local.movedTo).toMatchObject({ machine: 'prod', sessionId: 'here-1', installationId: expect.any(String) });
      expect(await movedChatPlace(local.movedTo!)).toMatchObject({ remote: { chatId: 'here-1' } });

      // Back again, through the same bridge: the copy here goes on, in its folder, and prod's is marked.
      await onProd(async () => {
        const state = await read();
        const moved = state.sessions.find((item) => item.id === 'here-1')!;
        moved.messages = [...moved.messages!, { role: 'user', content: 'on prod now' }, { role: 'assistant', content: 'Done on prod.' }];
        await write(state);
      });
      sent.length = 0;
      const back = await moveChat(recorded(remoteMoveEnd(bridge, { name: 'prod' })), recorded(localMoveEnd()), 'here-1');
      // Only what this machine lacks travels: the two turns said on prod.
      expect(back).toMatchObject({ moved: true, sessionId: 'here-1', folder: folderHere, reused: 2, sent: 2 });
      expect(sent).toEqual([`${localMoveEnd().name} chat-have`, 'prod export-chat since 2', `${localMoveEnd().name} import-chat`, 'prod mark-moved']);
      // Warm here now, and prod's worker for it gone.
      const home = await until(() => readWorkerRecord('here-1'));
      expect(alive(home.pid)).toBe(true);
      await until(async () => !alive(warmed.pid));
      const again = (await read()).sessions.find((item) => item.id === 'here-1')!;
      expect(again.movedTo).toBeUndefined();
      expect(again.messages).toHaveLength(4);
      expect(again.messages!.map((message) => message.content)).toEqual(['read the parser', 'It reads tokens.', 'on prod now', 'Done on prod.']);
      expect(again.moveNote).toContain(`moved from prod (folder ${prod.home})`);
      expect((await onProd(read)).sessions.find((item) => item.id === 'here-1')!.movedTo).toMatchObject({ machine: expect.any(String), sessionId: 'here-1' });
    } finally { bridge.close(); }
  }, 120_000);

  it('moves a chat from the other machine here', async () => {
    await onProd(() => write(stateOf([chat({ id: 'prod-1', conversationId: 'conv-2', name: 'On prod', workspace: prod.home })])));
    const bridge = new TerminalBridge('prod');
    try {
      await bridge.connected();
      const moved = await moveChat(remoteMoveEnd(bridge, { name: 'prod' }), localMoveEnd(), 'prod-1');
      expect(moved).toMatchObject({ moved: true, sessionId: 'prod-1', folder: process.env.HOME });
      const local = (await read()).sessions.find((item) => item.id === 'prod-1')!;
      expect(local).toMatchObject({ name: 'On prod', workspace: process.env.HOME, conversationId: 'conv-2' });
      // The other machine's folder is not used here.
      expect(local.workspace).not.toBe(prod.home);
      const remote = (await onProd(read)).sessions.find((item) => item.id === 'prod-1')!;
      expect(remote.movedTo).toMatchObject({ sessionId: 'prod-1' });
      // It is read-only there now: a second move of it is refused by that machine.
      await expect(moveChat(remoteMoveEnd(bridge, { name: 'prod' }), localMoveEnd(), 'prod-1')).rejects.toThrow(/moved to/);
    } finally { bridge.close(); }
  }, 120_000);

  it('moves over the connection the machine list already has: no other SSH connection', async () => {
    await write(stateOf([chat({ id: 'here-2', conversationId: 'conv-3', name: 'Over the list', workspace: process.env.HOME })]));
    const sshLog = join(root, 'ssh.log');
    const connections = (): number => (existsSync(sshLog) ? readFileSync(sshLog, 'utf8').trim().split('\n').filter((line) => line.includes('"prod"')).length : 0);
    const links = await new RemoteMachines({ autoUpdate: false }).open();
    try {
      const machine = (await readMachines()).find((item) => item.name === 'prod')!;
      await until(async () => links.views().find((view) => view.machine.id === machine.id)?.state === 'connected');
      const opened = connections();
      expect(opened).toBeGreaterThan(0);
      const channel = (await links.channel(machine.id))!;
      expect(channel.revision).toBeGreaterThanOrEqual(4);
      sent.length = 0;
      const moved = await moveChat(recorded(localMoveEnd()), recorded(remoteMoveEnd(channel, machine)), 'here-2');
      channel.close();
      expect(moved).toMatchObject({ moved: true, sessionId: 'here-2' });
      expect(sent.filter((line) => line.includes('import-chat'))).toEqual(['prod import-chat']);
      expect(connections()).toBe(opened);
      expect((await onProd(read2)).sessions.find((item) => item.id === 'here-2')).toMatchObject({ name: 'Over the list' });
    } finally { await links.close(); }
  }, 120_000);

  it('/machine after the board moves over the window\'s connection the board made: one SSH connection for both', async () => {
    await write(stateOf([chat({ id: 'here-3', conversationId: 'conv-4', name: 'Board then move', workspace: process.env.HOME })]));
    const sshLog = join(root, 'ssh.log');
    const connections = (): number => (existsSync(sshLog) ? readFileSync(sshLog, 'utf8').trim().split('\n').filter((line) => line.includes('"prod"')).length : 0);
    const before = connections();
    const machine = (await readMachines()).find((item) => item.name === 'prod')!;
    try {
      // The board opens, shows prod, and closes.
      const board = await holdWindowMachines();
      await until(async () => board.views().find((view) => view.machine.id === machine.id)?.state === 'connected');
      board.release();
      // /machine, picking prod.
      const picker = { select: async () => machine.id } as unknown as HarnessPrompter;
      const next = await moveTerminalChat(picker, { local: 'here-3' }, 'here-3', true, localMoveEnd());
      expect(next).toEqual({ remote: { machineId: machine.id, chatId: 'here-3' } });
      expect((await onProd(read2)).sessions.find((item) => item.id === 'here-3')).toMatchObject({ name: 'Board then move' });
      expect(connections() - before).toBe(1);
    } finally { await closeWindowMachines(); }
  }, 120_000);
});
