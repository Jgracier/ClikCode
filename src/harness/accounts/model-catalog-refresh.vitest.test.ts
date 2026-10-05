import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiHarnessAccount, AiLocalHarnessDefinition } from '../definition.js';

const queryAcp = vi.hoisted(() => vi.fn());
vi.mock('./acp-query.js', async (original) => ({
  ...(await original<typeof import('./acp-query.js')>()),
  queryAcp,
}));

const { nativeModelCatalog, recordLiveModelCatalog, resetModelCatalogMemo } = await import('./model-catalog.js');

afterEach(() => {
  vi.restoreAllMocks();
  queryAcp.mockReset();
  resetModelCatalogMemo();
});

describe('ACP model catalog refresh', () => {
  it('takes a live session\'s list as the catalog, and never re-reads it on a clock', async () => {
    const harness = {
      command: 'test-acp-model-refresh', binary: 'missing-test-acp-model-refresh', transport: 'acp',
      acp: { argv: [] },
    } as unknown as AiLocalHarnessDefinition;
    queryAcp.mockImplementation(async () => ({ models: ['model-one'], labels: {} }));
    const start = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(start);

    // No session yet and nothing cached: discovery starts the agent once.
    expect((await nativeModelCatalog(harness)).models).toEqual(['model-one']);
    expect(queryAcp).toHaveBeenCalledTimes(1);

    // Hours later the cached list is still the answer: no second spawn.
    vi.spyOn(Date, 'now').mockReturnValue(start + 3 * 60 * 60_000);
    expect((await nativeModelCatalog(harness)).models).toEqual(['model-one']);
    expect(queryAcp).toHaveBeenCalledTimes(1);

    // A live session offering a changed list replaces it, with no spawn.
    await recordLiveModelCatalog(harness, undefined, {
      models: { availableModels: [{ modelId: 'model-two', name: 'Model Two' }], currentModelId: 'model-two' },
    }, true);
    const catalog = await nativeModelCatalog(harness);
    expect(catalog.models).toEqual(['model-two']);
    expect(catalog.labels).toEqual({ 'model-two': 'Model Two' });
    expect(catalog.configured).toBe('model-two');
    expect(queryAcp).toHaveBeenCalledTimes(1);
  });

  it('starts no agent at all when a live session reported first', async () => {
    const harness = {
      command: 'test-acp-live-first', binary: 'missing-test-acp-live-first', transport: 'acp',
      acp: { argv: [], listsModels: true },
    } as unknown as AiLocalHarnessDefinition;
    await recordLiveModelCatalog(harness, undefined, {
      configOptions: [{ id: 'model', currentValue: 'b', options: [{ value: 'a' }, { value: 'b' }] }],
    }, true);
    const catalog = await nativeModelCatalog(harness);
    expect(catalog.models).toEqual(['a', 'b']);
    expect(catalog.configured).toBe('b');
    expect(queryAcp).not.toHaveBeenCalled();
  });

  it('keeps the default model when a loaded chat reports the model it last used', async () => {
    const harness = {
      command: 'test-acp-live-load', binary: 'missing-test-acp-live-load', transport: 'acp',
      acp: { argv: [], listsModels: true },
    } as unknown as AiLocalHarnessDefinition;
    const answer = (current: string) => ({ models: { availableModels: [{ modelId: 'a' }, { modelId: 'b' }], currentModelId: current } });
    await recordLiveModelCatalog(harness, undefined, answer('a'), true);
    await recordLiveModelCatalog(harness, undefined, answer('b'), false);
    expect((await nativeModelCatalog(harness)).configured).toBe('a');
  });

  it('leaves a harness with a models command to that command', async () => {
    const harness = {
      command: 'test-acp-live-cli-list', binary: 'missing-test-acp-live-cli-list', transport: 'acp',
      acp: { argv: [] }, modelDiscoveryArgv: ['models'],
    } as unknown as AiLocalHarnessDefinition;
    await recordLiveModelCatalog(harness, undefined, { models: { availableModels: [{ modelId: 'from-acp' }] } }, true);
    expect((await nativeModelCatalog(harness)).models).not.toContain('from-acp');
  });

  it('keeps ACP model lists separate for two logged-in profiles', async () => {
    const harness = {
      command: 'test-acp-account-models', binary: 'missing-test-acp-account-models', transport: 'acp',
      acp: { argv: [] },
    } as unknown as AiLocalHarnessDefinition;
    const account = (id: string): AiHarnessAccount => ({
      id, provider: 'test', label: id, models: [], status: 'ready',
      nativeProfile: { env: 'HOME', path: `/tmp/clikcode-model-${id}` },
    }) as AiHarnessAccount;
    queryAcp.mockImplementation(async (_binary, _argv, environment) => ({
      models: [environment.HOME.endsWith('first') ? 'first-model' : 'second-model'], labels: {},
    }));

    expect((await nativeModelCatalog(harness, account('first'))).models).toEqual(['first-model']);
    expect((await nativeModelCatalog(harness, account('second'))).models).toEqual(['second-model']);
    expect((await nativeModelCatalog(harness, account('first'))).models).toEqual(['first-model']);
    expect(queryAcp).toHaveBeenCalledTimes(2);
  });

  it('runs one discovery for callers that ask at once, and a new one for a changed source', async () => {
    const harness = {
      command: 'test-acp-single-flight', binary: 'missing-test-acp-single-flight', transport: 'acp',
      acp: { argv: [] },
    } as unknown as AiLocalHarnessDefinition;
    let answer!: () => void;
    queryAcp.mockImplementation(() => new Promise((resolve) => { answer = () => resolve({ models: ['only-model'], labels: {} }); }));
    const asked = [nativeModelCatalog(harness), nativeModelCatalog(harness), nativeModelCatalog(harness)];
    await vi.waitFor(() => expect(queryAcp).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    answer();
    for (const result of await Promise.all(asked)) expect(result.models).toEqual(['only-model']);
    expect(queryAcp).toHaveBeenCalledTimes(1);

    // Another account is another source: never answered by this one's run.
    const other = { id: 'other', provider: 'test', label: 'other', models: [], status: 'ready' } as unknown as AiHarnessAccount;
    queryAcp.mockImplementation(async () => ({ models: ['other-model'], labels: {} }));
    expect((await nativeModelCatalog(harness, other)).models).toEqual(['other-model']);
    expect(queryAcp).toHaveBeenCalledTimes(2);
  });

  it('is not invalidated by the account model list its own discovery wrote', async () => {
    const harness = {
      command: 'test-acp-own-sync', binary: 'missing-test-acp-own-sync', transport: 'acp',
      acp: { argv: [] },
    } as unknown as AiLocalHarnessDefinition;
    const account = (models: string[]): AiHarnessAccount => ({ id: 'acct', provider: 'test', label: 'acct', models, status: 'ready' }) as unknown as AiHarnessAccount;
    queryAcp.mockImplementation(async () => ({ models: ['m1', 'm2'], labels: {} }));
    expect((await nativeModelCatalog(harness, account([]))).models).toEqual(['m1', 'm2']);
    // The account as it reads after the sync: the same list.
    expect((await nativeModelCatalog(harness, account(['m1', 'm2']))).models).toEqual(['m1', 'm2']);
    expect(queryAcp).toHaveBeenCalledTimes(1);
    // A model the account gained since is a reason to read again.
    expect((await nativeModelCatalog(harness, account(['m1', 'm2', 'custom']))).models).toContain('custom');
    expect(queryAcp).toHaveBeenCalledTimes(2);
  });

  it('starts the discovery child with the vendor switch that keeps MCP servers off', async () => {
    const harness = {
      command: 'test-acp-probe-argv', binary: 'missing-test-acp-probe-argv', transport: 'acp',
      acp: { argv: ['--acp'], probeArgv: ['--allowed-mcp-server-names', 'none'] },
    } as unknown as AiLocalHarnessDefinition;
    queryAcp.mockImplementation(async () => ({ models: ['m'], labels: {} }));
    await nativeModelCatalog(harness);
    expect(queryAcp.mock.calls[0]![1]).toEqual(['--acp', '--allowed-mcp-server-names', 'none']);
  });

  it('discovers once per machine: a window already running takes another window\'s answer', async () => {
    const acpHarness = (command: string) => ({
      command, binary: `missing-${command}`, transport: 'acp', acp: { argv: [] },
    } as unknown as AiLocalHarnessDefinition);
    const first = acpHarness('test-shared-first');
    const second = acpHarness('test-shared-second');
    queryAcp.mockImplementation(async () => ({ models: ['m'], labels: {} }));
    // A second module instance stands for another ClikCode process that has
    // already read the catalog file.
    vi.resetModules();
    const other = await import('./model-catalog.js');
    await other.nativeModelCatalog(second);
    expect(queryAcp).toHaveBeenCalledTimes(1);
    await nativeModelCatalog(first);
    expect(queryAcp).toHaveBeenCalledTimes(2);
    // The running window reads the answer this one wrote...
    expect((await other.nativeModelCatalog(first)).models).toEqual(['m']);
    // ...and this one's write kept the other's entry.
    resetModelCatalogMemo();
    await nativeModelCatalog(second);
    expect(queryAcp).toHaveBeenCalledTimes(2);
  });
});
