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
  prefetchLocalModel: vi.fn(),
}));
const files = vi.hoisted(() => ({ missingBytes: vi.fn(async () => 0) }));
// The Gateway's own list, which a name typed on a chat running a model on this computer is checked against.
const gateway = vi.hoisted(() => ({ models: [{ id: 'claude-opus-5.5' }, { id: 'claude-sonnet-5.5' }] as Array<{ id: string }> }));
vi.mock('../../gateway/models', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../gateway/models')>(),
  gatewayModels: async () => ({ models: gateway.models }),
}));
vi.mock('../../local-models/models', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../local-models/models')>(), missingBytes: files.missingBytes,
}));
vi.mock('../../local-models/index', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../local-models/index')>(),
  ensureLocalModel: engine.ensureLocalModel,
  releaseLocalModel: engine.releaseLocalModel,
  localModelChoices: engine.localModelChoices,
  prefetchLocalModel: engine.prefetchLocalModel,
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

  it('moves only the label of a band already up, and gives it back: the band never drops, its clock never restarts', async () => {
    const { TERMINAL } = await import('../../tui/active-terminal');
    const calls: string[] = [];
    let label: string | undefined = 'thinking';
    TERMINAL.active = {
      waitingLabel: () => label,
      startWaiting: (text: string) => { calls.push(`start ${text}`); label = text; },
      stopWaiting: () => { calls.push('stop'); label = undefined; },
      updateWaitingLabel: (text: string) => { calls.push(`label ${text}`); label = text; },
    } as never;
    engine.ensureLocalModel.mockImplementation(async (options: { progress: (update: unknown) => void }) => {
      options.progress({ stage: 'download', message: 'downloading model.gguf (200 B)', bytes: 50, totalBytes: 200 });
      return { baseUrl: 'http://127.0.0.1:1/v1', model: 'qwen3.5-4b', contextWindow: 8192 };
    });
    try {
      await ensureLocalModelForTurn(session({ model: 'qwen3.5-4b' }));
    } finally { TERMINAL.active = undefined; }
    expect(calls).toEqual(['label downloading model.gguf (200 B) 25%', 'label thinking']);
  });

  it('sends its progress to the surface that asked (the editor\'s busy line), not to stderr', async () => {
    engine.ensureLocalModel.mockImplementation(async (options: { progress: (update: unknown) => void }) => {
      options.progress({ stage: 'download', message: 'downloading model.gguf (200 B)', bytes: 150, totalBytes: 200 });
      return { baseUrl: 'http://127.0.0.1:1/v1', model: 'qwen3.5-4b', contextWindow: 8192 };
    });
    const shown: string[] = [];
    await ensureLocalModelForTurn(session({ model: 'qwen3.5-4b' }), (label) => shown.push(label));
    expect(shown).toEqual(['downloading model.gguf (200 B) 75%']);
    expect(process.stderr.write).not.toHaveBeenCalled();
  });

  it('words download progress as its own message and a percentage: "downloading" once, for the weights and for the runtime', () => {
    expect(localProgressText({ stage: 'download', message: 'downloading gemma-4-12b-it-Q4_0.gguf (6.7 GB)', bytes: 1_072_000_000, totalBytes: 6_700_000_000 }))
      .toBe('downloading gemma-4-12b-it-Q4_0.gguf (6.7 GB) 16%');
    expect(localProgressText({ stage: 'runtime', message: 'downloading llama.cpp b11194 (vulkan, 90.0 MB)', bytes: 45_000_000, totalBytes: 90_000_000 }))
      .toBe('downloading llama.cpp b11194 (vulkan, 90.0 MB) 50%');
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

  it('moves the chat to the Gateway with a Gateway model typed on it, because both are the Gateway provider', async () => {
    await stored(session({ model: 'qwen3.5-4b' }));
    await aiSessionCommand('s1', '/model opus');
    expect((await readState()).sessions[0]!).toMatchObject({ route: 'gateway', model: 'claude-opus-5.5' });
    // Nothing was loaded on this computer for it.
    expect(engine.ensureLocalModel).not.toHaveBeenCalled();
  });

  it('keeps the chat on its model on this computer when the typed name is not a Gateway model either, and loads nothing', async () => {
    await stored(session({ model: 'qwen3.5-4b' }));
    await expect(aiSessionCommand('s1', '/model nonesuch')).rejects.toThrow(/is not a model ClikDeploy Gateway offers you/);
    expect((await readState()).sessions[0]!).toMatchObject({ route: 'clikcode-local', model: 'qwen3.5-4b' });
    expect(engine.ensureLocalModel).not.toHaveBeenCalled();
    await localModelChosen('s1', 'qwen3.5-4b');
    expect(engine.ensureLocalModel).toHaveBeenCalledTimes(1);
  });

  it('still takes one of this computer\'s own models by its label, as before', async () => {
    await stored(session({ model: 'qwen3.5-4b' }));
    await aiSessionCommand('s1', '/model gpt-oss 20B');
    expect((await readState()).sessions[0]!).toMatchObject({ route: 'clikcode-local', model: 'gpt-oss-20b' });
  });

  it('is offered, waits for the turn boundary rather than applying mid-turn, and /effort says why it is not', () => {
    const local = session();
    expect(resolveSlashCommand('model')!.availability(local, undefined).available).toBe(true);
    expect(slashRouteAppliesDuringTurn(routeSlashInput('/model qwen3.5-9b'), local)).toBe(false);
    expect(slashRouteAppliesDuringTurn(routeSlashInput('/model sonnet'), session({ route: 'local' }))).toBe(true);
    expect(resolveSlashCommand('effort')!.availability(local, undefined)).toMatchObject({ available: false, reason: expect.stringContaining('model on this computer') });
  });
});

describe('the model on a session', () => {
  it('is validated against the catalog and named by its label', () => {
    expect(resolveLocalModelId('Qwen3.5 4B')).toBe('qwen3.5-4b');
    expect(resolveLocalModelId('GPT-OSS-20B')).toBe('gpt-oss-20b');
    expect(() => resolveLocalModelId('llama3')).toThrow(/not a model this computer can run/);
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
    await expect(aiSessionSet(created.id, { model: 'sonnet' })).rejects.toThrow(/not a model this computer can run/);
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
    await expect(startOrResumeChat({ harness: 'clikcode-local', model: 'sonnet' })).rejects.toThrow(/not a model this computer can run/);
    await expect(startOrResumeChat({ harness: 'clikcode-local', permissions: 'yolo' })).rejects.toThrow(/permission modes/);
  });

  it('refuses --model for a harness that has no model selector, recording nothing', async () => {
    await stored(session({ id: 'bbbbbbbb-2222', route: 'local', nativeHarness: 'cn', provider: 'cn', model: null } as Partial<HarnessSession>));
    await expect(startOrResumeChat({ chat: 'bbbbbbbb-2222', model: 'gpt-5' })).rejects.toThrow(/does not publish a model selector/);
    expect((await readState()).sessions.find((item) => item.id === 'bbbbbbbb-2222')!.model).toBeNull();
  });

  it('continues a chat only on the route it is on', async () => {
    await stored(session({ id: 'aaaaaaaa-1111', route: 'gateway', messages: [{ role: 'user', content: 'hi' }] } as Partial<HarnessSession>));
    await expect(startOrResumeChat({ harness: 'clikcode-local', chat: 'aaaaaaaa-1111' })).rejects.toThrow(/runs on ClikDeploy Gateway/);
  });
});


describe('/model --download while the window is free to do other things', () => {
  // A chat that has been used: one with no messages is a draft that lives only in this process, which two writes at once do not merge.
  const GATEWAY = { route: 'gateway' as const, provider: 'gateway', model: 'claude-sonnet-5.5', messages: [{ role: 'user' as const, content: 'hello' }] };
  let outcomes: Array<{ sessionId: string; switched: boolean; level: string; text: string }>;
  let stopOutcomes: () => void;
  let withdraw: () => void;
  let release: (() => void) | undefined;
  let failWith: ((error: Error) => void) | undefined;

  beforeEach(async () => {
    const { onDownloadOutcome, allowBackgroundDownloads } = await import('../../local-models/downloads');
    outcomes = [];
    stopOutcomes = onDownloadOutcome((outcome) => outcomes.push(outcome));
    withdraw = allowBackgroundDownloads();
    files.missingBytes.mockResolvedValue(6_700_000_000);
    engine.prefetchLocalModel.mockReset();
    // Stops when told to, as the real fetch does, so a test that fails part way cannot leave a download holding the next one up.
    engine.prefetchLocalModel.mockImplementation((_model: string, _progress: unknown, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
      release = resolve; failWith = reject;
      signal?.addEventListener('abort', () => reject(new Error('cancelled')));
    }));
  });
  afterEach(async () => {
    stopOutcomes(); withdraw();
    // A download a test left running must not be the next test's.
    const { modelDownloads } = await import('../../local-models/downloads');
    for (const job of modelDownloads()) { job.cancel(); await job.done.catch(() => undefined); }
    release = undefined; failWith = undefined;
  });

  const waitFor = async (check: () => boolean | Promise<boolean>): Promise<void> => {
    const deadline = Date.now() + 5_000;
    while (!await check()) { if (Date.now() > deadline) throw new Error('timed out'); await new Promise((resolve) => setTimeout(resolve, 10)); }
  };

  it('returns at once, leaves the chat exactly as it was while the model downloads, and moves it when the files are there', async () => {
    await stored(session(GATEWAY));
    const started = Date.now();
    await aiSessionCommand('s1', '/model --download qwen3.5-9b');
    // Nothing waited for the download: the command is over, and the chat is where it was.
    expect(Date.now() - started).toBeLessThan(2_000);
    expect((await readState()).sessions[0]!).toMatchObject({ route: 'gateway', model: 'claude-sonnet-5.5' });
    expect(outcomes.map((outcome) => [outcome.switched, outcome.level])).toEqual([[false, 'info']]);
    expect(outcomes[0]!.text).toMatch(/^Downloading Qwen3\.5 9B \(6\.7 GB\) in the background/);
    expect(engine.ensureLocalModel).not.toHaveBeenCalled();

    await waitFor(() => release !== undefined);
    // Shown in the chat that asked, and in no other.
    expect([...(await import('../../local-models/downloads')).modelDownloads()[0]!.askers]).toEqual(['s1']);
    release!();
    await waitFor(() => outcomes.length === 2);
    expect(outcomes[1]).toMatchObject({ switched: true, level: 'info', sessionId: 's1' });
    expect(outcomes[1]!.text).toContain('is downloaded');
    expect((await readState()).sessions[0]!).toMatchObject({ route: 'clikcode-local', model: 'qwen3.5-9b' });
    // The first turn loads it, on that turn's own wait: the download did not start a server or take a lease.
    expect(engine.ensureLocalModel).not.toHaveBeenCalled();
  });

  it('leaves the chat as it was when the download fails, and says the fetch resumes', async () => {
    await stored(session(GATEWAY));
    await aiSessionCommand('s1', '/model --download qwen3.5-9b');
    await waitFor(() => failWith !== undefined);
    failWith!(new Error('Download failed (HTTP 503) for https://huggingface.co/x.'));
    await waitFor(() => outcomes.length === 2);
    expect(outcomes[1]).toMatchObject({ switched: false, level: 'error' });
    expect(outcomes[1]!.text).toMatch(/failed: Download failed \(HTTP 503\).*resumes from where it stopped.*as it was/);
    expect((await readState()).sessions[0]!).toMatchObject({ route: 'gateway', model: 'claude-sonnet-5.5' });
  });

  it('does not pull the chat back when the user moved it while the model downloaded', async () => {
    await stored(session(GATEWAY));
    await aiSessionCommand('s1', '/model --download qwen3.5-9b');
    await waitFor(() => release !== undefined);
    // Meanwhile the user chose another model for the chat.
    const state = await readState();
    state.sessions[0]!.model = 'claude-opus-5.5';
    await writeState(state);
    release!();
    await waitFor(() => outcomes.length === 2);
    expect(outcomes[1]).toMatchObject({ switched: false, level: 'info' });
    expect(outcomes[1]!.text).toMatch(/downloaded.*changed while it downloaded.*left as it is: \/model qwen3\.5-9b moves it/);
    expect((await readState()).sessions[0]!).toMatchObject({ route: 'gateway', model: 'claude-opus-5.5' });
  });

  it('is one download for two chats asking for the same model, and each chat moves when it is done', async () => {
    await stored(session({ ...GATEWAY, id: 's1' }));
    await stored(session({ ...GATEWAY, id: 's2', conversationId: 's2' }));
    await aiSessionCommand('s1', '/model --download qwen3.5-9b');
    await aiSessionCommand('s2', '/model --download qwen3.5-9b');
    await waitFor(() => release !== undefined);
    expect(engine.prefetchLocalModel).toHaveBeenCalledTimes(1);
    // One download, shown in each of the two chats that asked for it and in no third.
    expect([...(await import('../../local-models/downloads')).modelDownloads()[0]!.askers]).toEqual(['s1', 's2']);
    release!();
    await waitFor(() => outcomes.filter((outcome) => outcome.switched).length === 2);
    expect((await readState()).sessions.map((chat) => [chat.id, chat.route, chat.model])).toEqual([['s1', 'clikcode-local', 'qwen3.5-9b'], ['s2', 'clikcode-local', 'qwen3.5-9b']]);
  });

  it('moves a new chat with nothing in it too -- the model chosen before the first message', async () => {
    await stored(session({ route: 'gateway', provider: 'gateway', model: 'claude-sonnet-5.5' }));
    await aiSessionCommand('s1', '/model --download qwen3.5-9b');
    await waitFor(() => release !== undefined);
    expect((await readState()).sessions[0]!).toMatchObject({ route: 'gateway', model: 'claude-sonnet-5.5' });
    release!();
    await waitFor(() => outcomes.some((outcome) => outcome.switched));
    expect((await readState()).sessions[0]!).toMatchObject({ route: 'clikcode-local', model: 'qwen3.5-9b' });
  });

  it('moves a chat to a model already on this machine at once, from any route, with nothing downloaded', async () => {
    files.missingBytes.mockResolvedValue(0);
    await stored(session(GATEWAY));
    await aiSessionCommand('s1', '/model --download qwen3.5-9b');
    expect(engine.prefetchLocalModel).not.toHaveBeenCalled();
    expect((await readState()).sessions[0]!).toMatchObject({ route: 'clikcode-local', model: 'qwen3.5-9b' });
  });

  it('waits for the download where nothing outlives the command (a script), as it always did', async () => {
    withdraw();
    await stored(session({ ...GATEWAY, route: 'clikcode-local', provider: 'clikcode-local', model: 'qwen3.5-4b' }));
    await aiSessionCommand('s1', '/model --download qwen3.5-9b');
    expect(engine.prefetchLocalModel).not.toHaveBeenCalled();
    expect(engine.ensureLocalModel).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'qwen3.5-9b', allowDownload: true }));
    expect(outcomes).toEqual([]);
  });
});
