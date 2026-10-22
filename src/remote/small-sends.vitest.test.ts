/** A chat on another machine is sent whole when opened, and per prompt only
 * what changed: measured on the wire, over the FAKE ssh
 * (scripts/tui-e2e/fake-ssh.mjs) to a fake machine running this build's REAL
 * bridge, worker and turn, with the fake Grok (fake-grok.mjs) answering
 * there. Nothing connects to a real machine or runs a vendor CLI. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
// @ts-expect-error -- a plain .mjs fixture module
import { host } from '../../scripts/tui-e2e/fake-remote.mjs';
import type { HarnessSession, HarnessState } from '../session/model.js';
import type { IdeEvent } from '../ide/protocol.js';
import { listWorkerRecords } from '../worker/registry.js';
import { remoteResume, TerminalBridge } from './terminal-chat.js';
import { spawnSsh } from './ssh.js';
import { bridgeScript } from './install.js';

const REPO = resolve(__dirname, '..', '..');
const FAKES = join(REPO, 'scripts', 'tui-e2e');
const entry = join(REPO, 'dist', 'index.js');
const built = existsSync(entry);
const savedEnv = { ...process.env };
let prod: { home: string; bin: string };
const now = '2026-10-21T00:00:00.000Z';

/** A long chat: 200 messages of about 2 KB each. */
const history = (): NonNullable<HarnessSession['messages']> => Array.from({ length: 200 }, (_, index) => ({
  role: index % 2 ? 'assistant' : 'user', content: `turn ${index}: ${'the parser reads tokens and builds a tree. '.repeat(48)}`,
}) as NonNullable<HarnessSession['messages']>[number]);

async function onProd<T>(work: () => Promise<T>): Promise<T> {
  const previous = process.env.CLIKCODE_HOME;
  process.env.CLIKCODE_HOME = join(prod.home, '.clikcode');
  try { return await work(); } finally { process.env.CLIKCODE_HOME = previous; }
}

beforeAll(async () => {
  const clientHome = join(savedEnv.HOME!, 'client-home');
  mkdirSync(clientHome, { recursive: true });
  process.env.HOME = clientHome;
  const root = mkdtempSync(join(tmpdir(), 'cc-small-'));
  const bin = join(root, 'local-bin');
  mkdirSync(bin);
  symlinkSync(join(FAKES, 'fake-ssh.mjs'), join(bin, 'ssh'));
  process.env.PATH = `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`;
  process.env.FAKE_SSH_ROOT = root;
  prod = host(root, 'prod', { env: {
    CLIKCODE_OWN_SCOPE: '0', FAKE_FAMILY: 'claude', FAKE_STATE: join(root, 'turns'),
    FAKE_TURNS: JSON.stringify([1, 2, 3, 4, 5, 6].map((turn) => ({ blocks: [`Answer ${turn} from prod.`] }))),
  } });
  copyFileSync(join(FAKES, 'fake-grok.mjs'), join(prod.bin, 'grok'));
  mkdirSync(join(prod.home, '.grok'), { recursive: true });
  writeFileSync(join(prod.home, '.grok', 'auth.json'), '{}');
  mkdirSync(join(prod.home, '.local', 'bin'), { recursive: true });
  writeFileSync(join(prod.home, '.local', 'bin', 'clikcode'), `#!/bin/sh\nexec ${process.execPath} ${entry} "$@"\n`, { mode: 0o755 });
});

afterAll(async () => {
  for (const record of await onProd(listWorkerRecords)) { try { process.kill(record.pid, 'SIGTERM'); } catch { /* gone */ } }
  delete process.env.FAKE_SSH_ROOT;
  process.env.PATH = savedEnv.PATH;
  process.env.HOME = savedEnv.HOME;
});

/** A bridge on prod whose every byte back is counted. */
function counted(): { bridge: TerminalBridge; bytes: () => number; events: IdeEvent[] } {
  let bytes = 0;
  const bridge = new TerminalBridge('prod', (target) => {
    const child = spawnSsh(target, bridgeScript());
    child.stdout.on('data', (chunk: Buffer) => { bytes += chunk.length; });
    return child;
  });
  const events: IdeEvent[] = [];
  bridge.onEvent = (event) => { events.push(event); };
  return { bridge, bytes: () => bytes, events };
}

/** One prompt, until the bridge says it is done: the bytes it cost. */
async function prompt(chat: ReturnType<typeof counted>, text: string): Promise<number> {
  const before = chat.bytes();
  const id = randomUUID();
  chat.bridge.post({ type: 'send', text, id });
  const end = Date.now() + 60_000;
  while (!chat.events.some((event) => event.type === 'send-complete' && event.id === id)) {
    if (Date.now() > end) throw new Error(`no send-complete for "${text}"`);
    await new Promise((done) => setTimeout(done, 25));
  }
  return chat.bytes() - before;
}

/** The conversation as the client holds it: its last session or snapshot, whole again. */
const shown = (events: IdeEvent[]): HarnessSession | undefined => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type === 'session') return event.session;
    if (event.type === 'worker' && event.event.type === 'snapshot') return event.event.session;
  }
  return undefined;
};

describe.skipIf(!built)('a chat on another machine, over the real bridge', () => {
  it('is sent whole on opening, and per prompt only the prompt and its answer', async () => {
    const messages = history();
    const transcript = JSON.stringify(messages).length;
    await onProd(async () => {
      const { writeState } = await import('../session/state/write.js');
      await writeState({
        sessions: [{
          id: 'big-1', conversationId: 'big-1', route: 'local', accountId: null, provider: null, model: null,
          effort: 'high', permissionMode: 'ask', createdAt: now, updatedAt: now, status: 'active', name: 'Long chat', workspace: prod.home, messages,
        } as unknown as HarnessSession],
        accounts: [], invocations: [], providerSettings: {}, globalSettings: { effort: 'medium', permissionMode: 'ask' },
      } as unknown as HarnessState);
    });

    // Today's client, which names no feature: every event whole.
    const old = counted();
    await old.bridge.connected();
    await old.bridge.request({ type: 'open', mode: 'resume', sessionId: 'big-1' });
    const oldTurn = await prompt(old, 'first, the old way');
    old.bridge.close();

    const chat = counted();
    await chat.bridge.connected();
    const beforeOpen = chat.bytes();
    await chat.bridge.request(remoteResume('big-1'));
    const opened = chat.bytes() - beforeOpen;
    expect(shown(chat.events)?.messages).toHaveLength(202);
    const turns: number[] = [];
    for (const text of ['second', 'third', 'fourth']) turns.push(await prompt(chat, text));
    // The chat ends right: every message, the last answer included, in order.
    const final = shown(chat.events)!;
    expect(final.messages).toHaveLength(208);
    expect(final.messages!.slice(0, 200).map((message) => message.content)).toEqual(messages.map((message) => message.content));
    expect(final.messages!.slice(-6).map((message) => message.role === 'user' ? message.content : message.content.trim())).toEqual(
      ['second', 'Answer 2 from prod.', 'third', 'Answer 3 from prod.', 'fourth', 'Answer 4 from prod.']);
    console.log(`transcript ${transcript} B; open ${opened} B; per turn: whole events ${oldTurn} B, small ${turns.join(' / ')} B`);
    // Opening sends it whole; a turn without the feature sends it whole several times over.
    expect(opened).toBeGreaterThan(transcript);
    expect(oldTurn).toBeGreaterThan(2 * transcript);
    // A turn with it: a few KB, whatever the chat's length.
    for (const bytes of turns) expect(bytes).toBeLessThan(40_000);
    chat.bridge.close();
  }, 180_000);
});
