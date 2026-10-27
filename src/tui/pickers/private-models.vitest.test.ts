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

it('sends a Gateway chat to a model that runs on this computer, after telling the download, with no price asked and no move first', async () => {
  local.choices = [{ id: 'qwen', label: 'Qwen', detail: 'GPU · 30 tok/s', fits: true, recommended: true, downloadBytes: 12e9 }];
  const asked: string[] = [];
  const select = vi.fn(async (title: string, rows: Array<{ value: unknown }>) => { asked.push(title); return rows[0]!.value; });
  await interactiveHostedPicker({ select, panel: () => undefined } as never, 'gw');
  // The list, then one confirmation of the download; this computer's models never ask about a price.
  expect(asked[0]).toBe('Hosted AI');
  expect(asked.some((title) => /Start /.test(title))).toBe(false);
  // The chat is not moved first: the command moves it once the model is on this machine, and until then it is as it was, so a download
  // that takes minutes (or fails) never leaves it on a route with no model.
  expect(route.selectProviderConversation).not.toHaveBeenCalled();
  expect(aiSessionCommand).toHaveBeenCalledWith('gw', '/model --download qwen');
});
