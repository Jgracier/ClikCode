import { expect, it, vi } from 'vitest';
import { interactiveHostedPicker } from './model.js';
import { aiSessionCommand } from '../slash/handlers.js';

vi.mock('../../session/state/read.js', () => ({ readState: async () => ({ sessions: [{ id: 'gw', route: 'gateway' }] }) }));
vi.mock('../slash/handlers.js', () => ({ aiSessionCommand: vi.fn() }));
vi.mock('../../gateway/own-models.js', () => ({ alwaysStartOwnModels: () => true, setAlwaysStartOwnModels: () => undefined }));
const local = vi.hoisted(() => ({ choices: [] as Array<{ id: string; label: string; detail: string; fits: boolean; recommended: boolean; downloadBytes: number }> }));
vi.mock('../../local-models/index.js', () => ({ localModelChoices: async () => local.choices }));
const route = vi.hoisted(() => ({ selectProviderConversation: vi.fn(async () => 'moved') }));
vi.mock('./conversation.js', () => ({ selectProviderConversation: route.selectProviderConversation }));
vi.mock('../../gateway/private-models.js', () => ({
  searchDeployableModels: async () => [{ sourceId: 'huggingface', modelId: 'owner/model', displayName: 'model', gated: false }],
  quotePrivateModel: async () => ({ sku: { displayName: 'GPU' }, pricePerHour: 1 }),
  quoteSummary: () => ({ title: 'model on ClikDeploy', body: 'GPU: GPU' }),
  deployPrivateModel: async () => ({ id: 'dep-1', modelId: 'owner/model', status: 'LOADING', gatewayModelId: 'private-deployment:dep-1' }),
}));

it('selects the newly created private deployment without a model-list publication race', async () => {
  const select = vi.fn(async (_title, rows) => rows[0].value);
  await interactiveHostedPicker({ select } as never, 'gw');
  expect(aiSessionCommand).toHaveBeenCalledWith('gw', '/model --any private-deployment:dep-1');
});

it('asks once for a download of a model for this computer -- the size in the question, no panel of numbers -- and no price', async () => {
  local.choices = [{ id: 'qwen', label: 'Qwen', detail: 'GPU · first reply 3s · 30 tok/s reading · 32K context', brief: '12.0 GB download · ~30 tok/s', fits: true, recommended: true, downloadBytes: 12e9 }];
  const asked: string[] = [];
  const panels: string[] = [];
  const select = vi.fn(async (title: string, rows: Array<{ value: unknown }>) => { asked.push(title); return rows[0]!.value; });
  await interactiveHostedPicker({ select, panel: (title: string) => { panels.push(title); } } as never, 'gw');
  expect(asked).toEqual(['Hosted AI', 'Download Qwen (12.0 GB)?']);
  expect(panels).toEqual([]);
  // The chat is not moved first: the command moves it once the model is on this machine, and until then it is as it was, so a download
  // that takes minutes (or fails) never leaves it on a route with no model.
  expect(route.selectProviderConversation).not.toHaveBeenCalled();
  expect(aiSessionCommand).toHaveBeenCalledWith('gw', '/model --download qwen');
});

it('asks nothing for a model that is already on this computer: choosing it is the decision', async () => {
  local.choices = [{ id: 'gemma', label: 'Gemma 4 12B', detail: 'long', brief: 'downloaded · ~8 tok/s', fits: true, recommended: false, downloadBytes: 0 }];
  const listed: Array<{ label: string; detail?: string; group?: string }> = [];
  const asked: string[] = [];
  const select = vi.fn(async (title: string, rows: Array<{ value: unknown; label: string; detail?: string; group?: string }>) => {
    asked.push(title);
    if (!listed.length) listed.push(...rows);
    return rows[0]!.value;
  });
  await interactiveHostedPicker({ select, panel: () => undefined } as never, 'gw');
  expect(asked).toEqual(['Hosted AI']);
  // The row says what it takes and how fast it writes; where it runs is the group it is under.
  expect(listed[0]).toMatchObject({ label: 'Gemma 4 12B', group: 'Run on this computer' });
  expect(listed[0]!.detail).toBe('· downloaded · ~8 tok/s');
  expect(aiSessionCommand).toHaveBeenLastCalledWith('gw', '/model --download gemma');
});
