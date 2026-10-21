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
import { moveChat } from '../session/move-chat.js';
import { newMachineRecord, updateMachines } from './machines.js';
import { localMoveEnd, movedChatPlace, remoteMoveEnd } from './move-terminal.js';
import { TerminalBridge } from './terminal-chat.js';

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
const read = async () => (await import('../session/state/read.js')).readState({ transcripts: ['here-1', 'prod-1'] });
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
  prod = host(root, 'prod', {});
  writeFileSync(join(prod.bin, 'claude'), fakeClaude, { mode: 0o755 });
  mkdirSync(join(prod.home, '.local', 'bin'), { recursive: true });
  writeFileSync(join(prod.home, '.local', 'bin', 'clikcode'), `#!/bin/sh\nexec ${process.execPath} ${entry} "$@"\n`, { mode: 0o755 });
  await updateMachines(() => [newMachineRecord({ name: 'prod', sshTarget: 'prod', ready: true })]);
});

afterAll(() => {
  delete process.env.FAKE_SSH_ROOT;
  process.env.PATH = savedEnv.PATH;
  process.env.HOME = savedEnv.HOME;
});

describe.skipIf(!built)('moving a chat between two machines, over the real bridge', () => {
  it('moves a chat from here to the other machine, and back', async () => {
    const folderHere = mkdtempSync(join(tmpdir(), 'cc-move-here-'));
    await write(stateOf([chat({ id: 'here-1', conversationId: 'conv-1', name: 'Fix the parser', workspace: folderHere, nativeSessionId: 'thread-here' })]));
    const bridge = new TerminalBridge('prod');
    try {
      await bridge.connected();
      const asked: string[] = [];
      const there = await moveChat(localMoveEnd(), remoteMoveEnd(bridge, { name: 'prod' }), 'here-1', async (text) => { asked.push(text); return true; });
      expect(there).toMatchObject({ moved: true, sessionId: 'here-1', folder: prod.home });

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
      const back = await moveChat(remoteMoveEnd(bridge, { name: 'prod' }), localMoveEnd(), 'here-1', async () => true);
      expect(back).toMatchObject({ moved: true, sessionId: 'here-1', folder: folderHere });
      const again = (await read()).sessions.find((item) => item.id === 'here-1')!;
      expect(again.movedTo).toBeUndefined();
      expect(again.messages).toHaveLength(4);
      expect(again.moveNote).toContain(`moved from prod (folder ${prod.home})`);
      expect((await onProd(read)).sessions.find((item) => item.id === 'here-1')!.movedTo).toMatchObject({ machine: expect.any(String), sessionId: 'here-1' });
      expect(asked).toEqual([]);
    } finally { bridge.close(); }
  }, 120_000);

  it('moves a chat from the other machine here', async () => {
    await onProd(() => write(stateOf([chat({ id: 'prod-1', conversationId: 'conv-2', name: 'On prod', workspace: prod.home })])));
    const bridge = new TerminalBridge('prod');
    try {
      await bridge.connected();
      const moved = await moveChat(remoteMoveEnd(bridge, { name: 'prod' }), localMoveEnd(), 'prod-1', async () => true);
      expect(moved).toMatchObject({ moved: true, sessionId: 'prod-1', folder: process.env.HOME });
      const local = (await read()).sessions.find((item) => item.id === 'prod-1')!;
      expect(local).toMatchObject({ name: 'On prod', workspace: process.env.HOME, conversationId: 'conv-2' });
      // The other machine's folder is not used here.
      expect(local.workspace).not.toBe(prod.home);
      const remote = (await onProd(read)).sessions.find((item) => item.id === 'prod-1')!;
      expect(remote.movedTo).toMatchObject({ sessionId: 'prod-1' });
      // It is read-only there now: a second move of it is refused by that machine.
      await expect(moveChat(remoteMoveEnd(bridge, { name: 'prod' }), localMoveEnd(), 'prod-1', async () => true)).rejects.toThrow(/moved to/);
    } finally { bridge.close(); }
  }, 120_000);
});
