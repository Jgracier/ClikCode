import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HarnessSession } from '../../session/model';

// The engine is mocked throughout: what is under test is when the commands
// take and let go of a session's model, not llama.cpp.
const engine = vi.hoisted(() => ({
  ensureLocalModel: vi.fn(),
  releaseLocalModel: vi.fn(async () => undefined),
  localModelChoices: vi.fn(),
}));
const files = vi.hoisted(() => ({ missingBytes: vi.fn(async () => 0) }));
vi.mock('../../local-models/models', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../local-models/models')>(), missingBytes: files.missingBytes,
}));
vi.mock('../../local-models/index', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../local-models/index')>(),
  ensureLocalModel: engine.ensureLocalModel,
  releaseLocalModel: engine.releaseLocalModel,
  localModelChoices: engine.localModelChoices,
  releaseLocalModelsOnExit: () => undefined,
}));

// The bridge loads the bundled router, which a source test has not built;
// the catalog's own functions stand in for it.
vi.mock('../../runtime/lazy-bridge', async (importOriginal) => {
  const router = await import('@clikcode/router/ai-local-harness') as Record<string, unknown>;
  const original = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(Object.keys(original).map((name) => [name, router[name] ?? original[name]]));
});

const {
  ensureLocalModelForTurn, localModelChosen, localProgressText, reconcileLocalModelLeases, releaseHeldLocalModel, resetLocalModelHeldForTests,
} = await import('./local-model');
const { aiSessionClose, aiSessionCreate, aiSessionSet, applyClikCodeLocalSessionPolicy } = await import('./sessions');
const { aiSessionCommand } = await import('../../tui/slash/handlers');
const { localModelRows, localModelSelection } = await import('../../tui/pickers/model');
const { resolveLocalModelId, localModelLabel } = await import('../../local-models/catalog');
const { resolveSlashCommand, routeSlashInput, slashRouteAppliesDuringTurn } = await import('../../tui/slash/registry');
const { readState } = await import('../../session/state/read');
const { startOrResumeChat } = await import('./harness');
const { loadIndex } = await import('../../session/state/index-file');
const { writeState } = await import('../../session/state/write');

const session = (overrides: Partial<HarnessSession> = {}): HarnessSession => ({
  id: 's1', conversationId: 's1', route: 'clikcode-local', accountId: null, provider: 'clikcode-local', model: null, effort: 'auto',
  permissionMode: 'auto', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  status: 'active', ...overrides,
});

const previousHome = process.env.CLIKCODE_HOME;
beforeEach(() => {
  process.env.CLIKCODE_HOME = mkdtempSync(join(tmpdir(), 'cc-local-model-'));
  resetLocalModelHeldForTests();
  engine.ensureLocalModel.mockReset();
  engine.ensureLocalModel.mockResolvedValue({ baseUrl: 'http://127.0.0.1:1/v1', model: 'qwen3.5-4b', contextWindow: 8192 });
  engine.releaseLocalModel.mockClear();
  files.missingBytes.mockReset();
  files.missingBytes.mockResolvedValue(0);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => {
  vi.restoreAllMocks();
  if (previousHome === undefined) delete process.env.CLIKCODE_HOME;
  else process.env.CLIKCODE_HOME = previousHome;
});

async function stored(value: HarnessSession): Promise<void> {
  const state = await readState();
  state.sessions.push({ ...value, workspace: process.env.CLIKCODE_HOME! });
  await writeState(state);
}

describe('before a turn', () => {
  it('brings up the session\'s model from this process, and nothing for any other route', async () => {
    await ensureLocalModelForTurn(session({ model: 'qwen3.5-9b' }));
    expect(engine.ensureLocalModel).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'qwen3.5-9b', sessionId: 's1' }));
    engine.ensureLocalModel.mockClear();
    await ensureLocalModelForTurn(session({ route: 'gateway' }));
    await ensureLocalModelForTurn(undefined);
    expect(engine.ensureLocalModel).not.toHaveBeenCalled();
  });

  it('words download progress as a percentage', () => {
    expect(localProgressText({ stage: 'download', message: 'Qwen3.5-4B-Q4_K_M.gguf', bytes: 50, totalBytes: 200 })).toBe('downloading Qwen3.5-4B-Q4_K_M.gguf 25%');
    expect(localProgressText({ stage: 'start', message: 'loading Qwen3.5 4B… 12s' })).toBe('loading Qwen3.5 4B… 12s');
  });
});

describe('letting go', () => {
  it('releases only what this process took', async () => {
    await releaseHeldLocalModel('never-held');
    expect(engine.releaseLocalModel).not.toHaveBeenCalled();
    await ensureLocalModelForTurn(session());
    await releaseHeldLocalModel('s1');
    await releaseHeldLocalModel('s1');
    expect(engine.releaseLocalModel).toHaveBeenCalledTimes(1);
  });

  it('keeps the model only for the conversation the terminal shows, while it is on ClikCode Local', async () => {
    await ensureLocalModelForTurn(session());
    await ensureLocalModelForTurn(session({ id: 's2' }));
    await reconcileLocalModelLeases(session({ id: 's2' }));
    expect(engine.releaseLocalModel.mock.calls).toEqual([['s1']]);
    // The shown conversation moved to a vendor harness.
    await reconcileLocalModelLeases(session({ id: 's2', route: 'local' }));
    expect(engine.releaseLocalModel.mock.calls).toEqual([['s1'], ['s2']]);
  });

  it('releases on close', async () => {
    await stored(session({ messages: [{ role: 'user', content: 'hi' }] } as Partial<HarnessSession>));
    await ensureLocalModelForTurn(session());
    await aiSessionClose('s1');
    expect(engine.releaseLocalModel).toHaveBeenCalledWith('s1');
  });

  it('releases when /settings route moves the session away', async () => {
    await stored(session());
    await ensureLocalModelForTurn(session());
    await aiSessionCommand('s1', '/settings route gateway');
    expect(engine.releaseLocalModel).toHaveBeenCalledWith('s1');
    expect((await readState()).sessions[0]!.route).toBe('gateway');
  });

  it('/settings permissions is /permissions, which the agent routes take too', async () => {
    await stored(session());
    await aiSessionCommand('s1', '/settings permissions ask');
    expect((await readState()).sessions[0]!.permissionMode).toBe('ask');
  });
});

describe('/model on ClikCode Local', () => {
  it('requires an explicit download decision before a headless model switch', async () => {
    await stored(session());
    files.missingBytes.mockResolvedValue(2_000_000_000);
    await expect(aiSessionCommand('s1', '/model gpt-oss-20b')).rejects.toThrow(/needs a 2\.0 GB download.*--download/);
    expect(engine.ensureLocalModel).not.toHaveBeenCalled();
    await aiSessionCommand('s1', '/model --download gpt-oss-20b');
    expect(engine.ensureLocalModel).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'gpt-oss-20b', allowDownload: true }));
  });
  it('loads the model before the session switches to it', async () => {
    await stored(session({ model: 'qwen3.5-4b' }));
    await aiSessionCommand('s1', '/model gpt-oss 20B');
    expect(engine.ensureLocalModel).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'gpt-oss-20b', sessionId: 's1' }));
    expect((await readState()).sessions[0]!.model).toBe('gpt-oss-20b');
  });

  it('keeps the model it had when the new one fails to load', async () => {
    await stored(session({ model: 'qwen3.5-4b' }));
    engine.ensureLocalModel.mockRejectedValue(new Error('Qwen3.8 27B would exceed the memory this machine can spare'));
    await expect(aiSessionCommand('s1', '/model qwen3.8-27b')).rejects.toThrow(/exceed the memory/);
    expect((await readState()).sessions[0]!.model).toBe('qwen3.5-4b');
  });

  it('refuses a name outside the catalog before loading anything', async () => {
    await stored(session());
    await expect(aiSessionCommand('s1', '/model claude-opus')).rejects.toThrow(/not a ClikCode Local model.*Open \/model/);
    expect(engine.ensureLocalModel).not.toHaveBeenCalled();
    await localModelChosen('s1', 'qwen3.5-4b');
    expect(engine.ensureLocalModel).toHaveBeenCalledTimes(1);
  });

  it('is offered, waits for the turn boundary rather than applying mid-turn, and /effort says why it is not', () => {
    const local = session();
    expect(resolveSlashCommand('model')!.availability(local, undefined).available).toBe(true);
    expect(slashRouteAppliesDuringTurn(routeSlashInput('/model qwen3.5-9b'), local)).toBe(false);
    expect(slashRouteAppliesDuringTurn(routeSlashInput('/model sonnet'), session({ route: 'local' }))).toBe(true);
    expect(resolveSlashCommand('effort')!.availability(local, undefined)).toMatchObject({ available: false, reason: expect.stringContaining('ClikCode Local') });
  });

  it('lists every model: the current and recommended marked, one that does not fit explained rather than loaded', () => {
    const choices = [
      { id: 'ornith-1.5-35b-a3b', label: 'Ornith 1.5 35B-A3B', detail: 'CPU · measured 97 tok/s reading, 20 writing', fits: true, recommended: true, downloadBytes: 1 },
      { id: 'qwen3.5-4b', label: 'Qwen3.5 4B', detail: 'CPU · downloaded', fits: true, recommended: false, downloadBytes: 0 },
      { id: 'qwen3.8-27b', label: 'Qwen3.8 27B', detail: 'does not fit: needs 40 GB · 17 GB download', fits: false, recommended: true, downloadBytes: 1 },
    ];
    const rows = localModelRows(choices, 'qwen3.5-4b');
    expect(rows.map((row) => [row.label, row.detail])).toEqual([
      ['Ornith 1.5 35B-A3B', '· recommended · CPU · measured 97 tok/s reading, 20 writing'],
      ['Qwen3.5 4B', '· current · CPU · downloaded'],
      ['Qwen3.8 27B', '· does not fit: needs 40 GB · 17 GB download'],
    ]);
    expect(localModelSelection(choices, rows[0]!.value)).toBe('ornith-1.5-35b-a3b');
    expect(() => localModelSelection(choices, rows[2]!.value)).toThrow(/Qwen3\.8 27B cannot run on this machine: does not fit/);
  });
});

describe('the model on a session', () => {
  it('is validated against the catalog and named by its label', () => {
    expect(resolveLocalModelId('Qwen3.5 4B')).toBe('qwen3.5-4b');
    expect(resolveLocalModelId('GPT-OSS-20B')).toBe('gpt-oss-20b');
    expect(() => resolveLocalModelId('llama3')).toThrow(/not a ClikCode Local model/);
    expect(localModelLabel('ornith-1.5-35b-a3b')).toBe('Ornith 1.5 35B-A3B');
    expect(localModelLabel(null)).toBeUndefined();
  });

  it('survives the route policy only when it is a catalog model', () => {
    const kept = session({ model: 'qwen3.5-9b' });
    applyClikCodeLocalSessionPolicy(kept);
    expect(kept.model).toBe('qwen3.5-9b');
    const vendor = session({ route: 'local', model: 'sonnet' });
    applyClikCodeLocalSessionPolicy(vendor);
    expect(vendor.model).toBeNull();
  });

  it('sheds the vendor thread as ClikCode\'s own, so discovery does not offer it back', () => {
    const vendor = session({ route: 'local', nativeHarness: 'codex', nativeSessionId: 't1', nativeTransport: 'cli' } as Partial<HarnessSession>);
    applyClikCodeLocalSessionPolicy(vendor);
    expect(vendor.ownedThreads).toEqual(['codex:t1']);
    expect(vendor.nativeSessionId).toBeUndefined();
    expect(vendor.nativeTransport).toBeUndefined();
    expect(vendor.nativeHarness).toBeUndefined();
  });

  it('can be set on create and set, and a wrong one is refused', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await aiSessionCreate({ route: 'clikcode-local', model: 'qwen3.5-4b' });
    const created = (await readState()).sessions[0]!;
    expect(created).toMatchObject({ route: 'clikcode-local', model: 'qwen3.5-4b' });
    await aiSessionSet(created.id, { model: 'gpt-oss-20b' });
    expect((await readState()).sessions[0]!.model).toBe('gpt-oss-20b');
    await expect(aiSessionSet(created.id, { model: 'sonnet' })).rejects.toThrow(/not a ClikCode Local model/);
    await expect(aiSessionCreate({ route: 'clikcode-local', effort: 'high' })).rejects.toThrow(/effort/);
  });
});

describe('clikcode send --harness clikcode-local', () => {
  it.each(['clikcode-local', 'gateway'] as const)('stores a new %s chat before a worker is asked for it', async (harness) => {
    const id = await startOrResumeChat({ harness });
    // The index on disk, which is all a worker reads: readState also returns
    // drafts held in this process's memory.
    expect((await loadIndex())?.sessions.some((item) => item.id === id)).toBe(true);
  });

  it('starts a ClikCode Local chat with the model and approval mode asked for', async () => {
    const id = await startOrResumeChat({ harness: 'clikcode-local', model: 'Qwen3.5 4B', permissions: 'auto' });
    expect((await readState()).sessions.find((item) => item.id === id)).toMatchObject({
      route: 'clikcode-local', provider: 'clikcode-local', model: 'qwen3.5-4b', permissionMode: 'auto', accountId: null,
    });
  });

  it('refuses a model outside the catalog and a mode that does not exist', async () => {
    await expect(startOrResumeChat({ harness: 'clikcode-local', model: 'sonnet' })).rejects.toThrow(/not a ClikCode Local model/);
    await expect(startOrResumeChat({ harness: 'clikcode-local', permissions: 'yolo' })).rejects.toThrow(/permission modes/);
  });

  it('continues a chat only on the route it is on', async () => {
    await stored(session({ id: 'aaaaaaaa-1111', route: 'gateway', messages: [{ role: 'user', content: 'hi' }] } as Partial<HarnessSession>));
    await expect(startOrResumeChat({ harness: 'clikcode-local', chat: 'aaaaaaaa-1111' })).rejects.toThrow(/runs on ClikDeploy Gateway/);
  });
});
