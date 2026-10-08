/** `/accounts use` to another account of the same harness records the pick;
 * the vendor's own thread then follows it into the new account's profile
 * before the conversation's next turn (reconcileNativeThread), exactly as an
 * automatic failover carries it, and a fresh one (re-seeded from ClikCode's
 * copy) starts only where the thread cannot be found. The command runs in the
 * window or the editor's bridge and the turn in the worker, so nothing may
 * depend on the two sharing memory. HOME and CLIKCODE_HOME are throwaway; no
 * vendor CLI runs. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiHarnessAccount } from '../../harness/definition';
import type { HarnessSession } from '../../session/model';
import { resetNativeSessionDiscoveryCache } from '../../session/discovery/cache';

// The bridge loads the bundled router; the catalog's own functions stand in.
vi.mock('../../runtime/lazy-bridge', async (importOriginal) => {
  const router = await import('@clikcode/router/ai-local-harness') as Record<string, unknown>;
  const original = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(Object.keys(original).map((name) => [name, router[name] ?? original[name]]));
});

const { aiSessionCommand } = await import('./handlers');
const { readState } = await import('../../session/state/read');
const { writeState } = await import('../../session/state/write');
const { reconcileNativeThread } = await import('../../session/carry');
const { localHarnessForCommand } = await import('../../runtime/lazy-bridge');

const saved = { ...process.env };
let root: string;
const THREAD = '11111111-2222-3333-4444-555555555555';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cc-account-switch-'));
  Object.assign(process.env, { HOME: join(root, 'home'), USERPROFILE: join(root, 'home'), CLIKCODE_HOME: join(root, 'clikcode') });
  await mkdir(join(root, 'home'), { recursive: true });
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(async () => {
  vi.restoreAllMocks();
  resetNativeSessionDiscoveryCache();
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  await rm(root, { recursive: true, force: true });
});

const claudeAccount = (id: string): AiHarnessAccount => ({
  id, provider: 'anthropic', label: id, authKind: 'vendor-cli', models: [], status: 'ready',
  nativeProfile: { env: 'CLAUDE_CONFIG_DIR', path: join(root, 'profiles', id) },
} as unknown as AiHarnessAccount);

/** A Claude Code chat on account a, its thread in a's profile (or not). */
async function chatOnAccountA(threadFileExists: boolean): Promise<{ workspace: string; project: string }> {
  const workspace = join(root, 'work');
  await mkdir(workspace, { recursive: true });
  const project = workspace.replace(/[^a-zA-Z0-9]/g, '-');
  if (threadFileExists) {
    await mkdir(join(root, 'profiles', 'a', 'projects', project), { recursive: true });
    await writeFile(join(root, 'profiles', 'a', 'projects', project, `${THREAD}.jsonl`), '{"type":"user"}\n');
  }
  const state = await readState();
  state.accounts.push(claudeAccount('a'), claudeAccount('b'));
  const now = new Date().toISOString();
  state.sessions.push({
    id: 's1', conversationId: 's1', route: 'local', accountId: 'a', provider: 'anthropic', model: null, nativeHarness: 'claude',
    nativeSessionId: THREAD, nativeTransport: 'acp', nativeStartedAt: now, workspace,
    effort: 'medium', permissionMode: 'ask', createdAt: now, updatedAt: now, status: 'active',
    messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }],
  } as HarnessSession);
  await writeState(state);
  return { workspace, project };
}

const claude = () => localHarnessForCommand('claude')!;
const threadIn = (account: string, project: string): string => join(root, 'profiles', account, 'projects', project, `${THREAD}.jsonl`);

/** What the worker does at the start of its next turn. */
async function nextTurn(account: string): Promise<{ outcome: string; session: HarnessSession }> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === 's1')!;
  const outcome = await reconcileNativeThread(session, claude(), state.accounts, state.accounts.find((item) => item.id === account)!);
  await writeState(state);
  return { outcome, session: (await readState()).sessions.find((item) => item.id === 's1')! };
}

describe('switching account by hand', () => {
  it('records the pick, keeps the thread, and the next turn carries it into the new account', async () => {
    const { project } = await chatOnAccountA(true);
    await aiSessionCommand('s1', '/accounts use b');
    const picked = (await readState()).sessions.find((item) => item.id === 's1')!;
    expect(picked.accountId).toBe('b');
    expect(picked.nativeSessionId).toBe(THREAD);
    // Not moved by the command: the turn that runs it is another process.
    await expect(readFile(threadIn('b', project), 'utf8')).rejects.toThrow();
    const { outcome, session } = await nextTurn('b');
    expect(outcome).toBe('carried');
    expect(session.nativeSessionId).toBe(THREAD);
    expect(session.nativeThreadAccountId).toBe('b');
    await expect(readFile(threadIn('b', project), 'utf8')).resolves.toBe('{"type":"user"}\n');
    await expect(readFile(threadIn('a', project), 'utf8')).resolves.toBe('{"type":"user"}\n');
  });

  it('carries after a turn that failed and left its journal open (the "Resource not found" chat)', async () => {
    // The turn ended "All accounts exhausted" and kept pendingTurn for a
    // continuation. The switch used to take that for a turn still running,
    // keep the pick in memory for the worker, and never move the thread.
    const { project } = await chatOnAccountA(true);
    const state = await readState();
    const now = new Date().toISOString();
    const stored = state.sessions.find((item) => item.id === 's1')!;
    stored.nativeThreadAccountId = 'a';
    stored.pendingTurn = { prompt: 'continue', startedAt: now, updatedAt: now, outputStarted: false, failedAt: now };
    await writeState(state);
    await aiSessionCommand('s1', '/accounts use b');
    expect((await readState()).sessions.find((item) => item.id === 's1')!.accountId).toBe('b');
    expect((await nextTurn('b')).outcome).toBe('carried');
    await expect(readFile(threadIn('b', project), 'utf8')).resolves.toBe('{"type":"user"}\n');
  });

  it('is already in place when the pick is undone', async () => {
    const { project } = await chatOnAccountA(true);
    const state = await readState();
    state.sessions.find((item) => item.id === 's1')!.nativeThreadAccountId = 'a';
    await writeState(state);
    await aiSessionCommand('s1', '/accounts use b');
    await aiSessionCommand('s1', '/accounts use a');
    const { outcome } = await nextTurn('a');
    expect(outcome).toBe('present');
    await expect(readFile(threadIn('b', project), 'utf8')).rejects.toThrow();
  });

  it('starts a fresh thread when the old one is in no account', async () => {
    await chatOnAccountA(false);
    await aiSessionCommand('s1', '/accounts use b');
    const { outcome, session } = await nextTurn('b');
    expect(outcome).toBe('forgotten');
    expect(session.accountId).toBe('b');
    expect(session.nativeSessionId).toBeUndefined();
    expect(session.nativeThreadAccountId).toBeUndefined();
    expect(session.nativeTransport).toBeUndefined();
  });
});
