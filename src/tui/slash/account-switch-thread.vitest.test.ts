/** `/accounts use` to another account of the same harness keeps the vendor's
 * own thread wherever it can be carried, exactly as an automatic failover
 * does, and starts a fresh one (re-seeded from ClikCode's copy) only where it
 * cannot. HOME and CLIKCODE_HOME are throwaway; no vendor CLI runs. */
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
const { clearManualAccountSwitch, manualSwitchPending } = await import('../../turn/manual-account');

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
  clearManualAccountSwitch('s1');
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

describe('switching account by hand', () => {
  it('carries the vendor thread into the new account and keeps resuming it', async () => {
    const { project } = await chatOnAccountA(true);
    await aiSessionCommand('s1', '/accounts use b');
    const session = (await readState()).sessions.find((item) => item.id === 's1')!;
    expect(session.accountId).toBe('b');
    expect(session.nativeSessionId).toBe(THREAD);
    await expect(readFile(join(root, 'profiles', 'b', 'projects', project, `${THREAD}.jsonl`), 'utf8')).resolves.toBe('{"type":"user"}\n');
  });

  it('waits for the next call while a turn is in flight, and keeps the thread where the live process has it', async () => {
    const { project } = await chatOnAccountA(true);
    const state = await readState();
    const session = state.sessions.find((item) => item.id === 's1')!;
    const now = new Date().toISOString();
    session.pendingTurn = { prompt: 'hello', response: '', startedAt: now, updatedAt: now, outputStarted: false };
    await writeState(state);
    await aiSessionCommand('s1', '/accounts use b');
    const stored = (await readState()).sessions.find((item) => item.id === 's1')!;
    expect(stored.accountId).toBe('b');
    expect(stored.nativeSessionId).toBe(THREAD);
    expect(manualSwitchPending('s1')).toEqual({ fromId: 'a', toId: 'b' });
    await expect(readFile(join(root, 'profiles', 'a', 'projects', project, `${THREAD}.jsonl`), 'utf8')).resolves.toBe('{"type":"user"}\n');
    await expect(readFile(join(root, 'profiles', 'b', 'projects', project, `${THREAD}.jsonl`), 'utf8')).rejects.toThrow();
    await aiSessionCommand('s1', '/accounts use a');
    expect(manualSwitchPending('s1')).toBeUndefined();
    expect((await readState()).sessions.find((item) => item.id === 's1')!.accountId).toBe('a');
    await expect(readFile(join(root, 'profiles', 'a', 'projects', project, `${THREAD}.jsonl`), 'utf8')).resolves.toBe('{"type":"user"}\n');
  });

  it('starts a fresh thread when the old one cannot be carried', async () => {
    await chatOnAccountA(false);
    await aiSessionCommand('s1', '/accounts use b');
    const session = (await readState()).sessions.find((item) => item.id === 's1')!;
    expect(session.accountId).toBe('b');
    expect(session.nativeSessionId).toBeUndefined();
    expect(session.nativeTransport).toBeUndefined();
  });
});
