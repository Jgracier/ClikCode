import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiHarnessAccount, AiLocalHarnessDefinition } from '../definition.js';

const queryAcp = vi.hoisted(() => vi.fn());
vi.mock('./acp-query.js', async (original) => ({
  ...(await original<typeof import('./acp-query.js')>()),
  queryAcp,
}));

const { nativeModelCatalog, resetModelCatalogMemo } = await import('./model-catalog.js');

afterEach(() => {
  vi.restoreAllMocks();
  queryAcp.mockReset();
  resetModelCatalogMemo();
});

describe('ACP model catalog refresh', () => {
  it('refreshes a server-side model change even when the binary and account files do not change', async () => {
    const harness = {
      command: 'test-acp-model-refresh', binary: 'missing-test-acp-model-refresh', transport: 'acp',
      acp: { argv: [] },
    } as unknown as AiLocalHarnessDefinition;
    let offered = 'model-one';
    queryAcp.mockImplementation(async () => ({ models: [offered], labels: {} }));
    const start = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(start);

    expect((await nativeModelCatalog(harness)).models).toContain('model-one');
    offered = 'model-two';
    expect((await nativeModelCatalog(harness)).models).toContain('model-one');
    expect(queryAcp).toHaveBeenCalledTimes(1);

    vi.spyOn(Date, 'now').mockReturnValue(start + 5 * 60_000);
    expect((await nativeModelCatalog(harness)).models).toContain('model-two');
    expect(queryAcp).toHaveBeenCalledTimes(2);
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
});
