import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { localHarnessForCommand } from '@clikcode/router/ai-local-harness';
import { stateDirectory } from '../../session/store/paths.js';
import type { AiHarnessAccount } from '../definition.js';

const { capture, queryAcp } = vi.hoisted(() => ({ capture: vi.fn(), queryAcp: vi.fn() }));
vi.mock('../transport/native/command.js', () => ({ captureNativeHarnessOutput: capture }));
vi.mock('../transport/native/binary.js', () => ({ resolveBinaryPath: async () => undefined }));
vi.mock('./acp-query.js', async (original) => ({
  ...await original<typeof import('./acp-query.js')>(), queryAcp,
}));
const { nativeModelCatalog, recordLiveModelCatalog, resetModelCatalogMemo } = await import('./model-catalog.js');

const harness = localHarnessForCommand('antigravity')!;
// Captured from agy 1.4.12 in vendor-sandbox: the CLI lists six models;
// both signed-out and credential-linked ACP sessions list only the first three.
const nativeRows = [
  ['gemini-3.8-flash-high', 'Gemini 3.8 Flash (High)'],
  ['gemini-3.8-flash-medium', 'Gemini 3.8 Flash (Medium)'],
  ['gemini-3.8-flash-low', 'Gemini 3.8 Flash (Low)'],
  ['claude-sonnet-4-6', 'Claude Sonnet 4.6 (Thinking)'],
  ['claude-opus-4-6-thinking', 'Claude Opus 4.6 (Thinking)'],
  ['gpt-oss-120b-medium', 'GPT-OSS 120B (Medium)'],
];
const models = nativeRows.map(([id]) => id);
const printed = nativeRows.map(row => row.join('\t')).join('\n');
const acpAnswer = {
  models: {
    availableModels: nativeRows.slice(0, 3).map(([modelId, name]) => ({ modelId, name })),
    currentModelId: models[0],
  },
  configOptions: [{
    id: 'model', category: 'model', type: 'select', currentValue: 'gemini-3.8-flash',
    options: [{ value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' }],
  }],
};
const memoPath = () => join(stateDirectory(), 'model-catalog.json');

beforeEach(async () => {
  resetModelCatalogMemo();
  await rm(memoPath(), { force: true });
  capture.mockResolvedValue(printed);
});
afterEach(() => {
  vi.restoreAllMocks();
  capture.mockReset();
  queryAcp.mockReset();
  resetModelCatalogMemo();
});

describe('Antigravity model discovery after the ACP migration', () => {
  it('uses the full native inventory with the account profile, without a metadata session', async () => {
    const account = { models: models.slice(0, 3), nativeProfile: { env: 'HOME', path: join(process.env.HOME!, 'agy-profile') } } as AiHarnessAccount;
    expect((await nativeModelCatalog(harness, account)).models).toEqual(models);
    expect(capture).toHaveBeenCalledWith(harness, ['models'], expect.objectContaining({ HOME: account.nativeProfile!.path }), undefined);
    expect(queryAcp).not.toHaveBeenCalled();
  });

  it.each([true, false])('never replaces the full catalog with a partial live session (fresh=%s)', async fresh => {
    expect((await nativeModelCatalog(harness)).models).toEqual(models);
    await recordLiveModelCatalog(harness, undefined, acpAnswer, fresh);
    resetModelCatalogMemo(); // The persisted answer must be complete too.
    expect((await nativeModelCatalog(harness)).models).toEqual(models);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(queryAcp).not.toHaveBeenCalled();
  });

  it('uses native discovery even when a live ACP session reports first', async () => {
    await recordLiveModelCatalog(harness, undefined, acpAnswer, true);
    expect((await nativeModelCatalog(harness)).models).toEqual(models);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(queryAcp).not.toHaveBeenCalled();
  });

  it('expires a native server list while ACP is the turn transport', async () => {
    const start = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(start);
    await nativeModelCatalog(harness);
    vi.spyOn(Date, 'now').mockReturnValue(start + 299_999);
    await nativeModelCatalog(harness);
    expect(capture).toHaveBeenCalledTimes(1);
    capture.mockResolvedValue(`${printed}\nnew-native-model\tNew Native Model`);
    vi.spyOn(Date, 'now').mockReturnValue(start + 300_000);
    expect((await nativeModelCatalog(harness)).models).toEqual([...models, 'new-native-model']);
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it('invalidates the pre-fix ACP cache without requiring a vendor binary or credential change', async () => {
    await nativeModelCatalog(harness);
    const memo = JSON.parse(await readFile(memoPath(), 'utf8'));
    const entry = memo.entries['antigravity:default'];
    const split = entry.fingerprint.indexOf('|');
    entry.fingerprint = JSON.stringify({
      transport: harness.transport,
      acp: { argv: harness.acp!.argv, listsModels: harness.acp!.listsModels },
    }) + entry.fingerprint.slice(split);
    entry.result = { models: models.slice(0, 3) };
    await writeFile(memoPath(), JSON.stringify(memo));
    resetModelCatalogMemo();
    expect((await nativeModelCatalog(harness)).models).toEqual(models);
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it('retries a failed native discovery instead of caching an empty or partial ACP answer', async () => {
    capture.mockRejectedValueOnce(new Error('offline'));
    expect((await nativeModelCatalog(harness)).models).toEqual([]);
    expect((await nativeModelCatalog(harness)).models).toEqual(models);
    expect(capture).toHaveBeenCalledTimes(2);
    expect(queryAcp).not.toHaveBeenCalled();
  });
});
