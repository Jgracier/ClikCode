import { expect, it, vi } from 'vitest';
import { interactivePrivateModelsPicker } from './model.js';
import { aiSessionCommand } from '../slash/handlers.js';

vi.mock('../../session/state/read.js', () => ({ readState: async () => ({ sessions: [{ id: 'gw', route: 'gateway' }] }) }));
vi.mock('../slash/handlers.js', () => ({ aiSessionCommand: vi.fn() }));
vi.mock('../../gateway/own-models.js', () => ({ alwaysStartOwnModels: () => true }));
vi.mock('../../gateway/private-models.js', () => ({
  searchDeployableModels: async () => [{ sourceId: 'huggingface', modelId: 'owner/model', displayName: 'model', gated: false }],
  quotePrivateModel: async () => ({ sku: { displayName: 'GPU' } }),
  deployPrivateModel: async () => ({ id: 'dep-1', modelId: 'owner/model', status: 'LOADING', gatewayModelId: 'private-deployment:dep-1' }),
}));

it('selects the newly created private deployment without a model-list publication race', async () => {
  const select = vi.fn(async (_title, rows) => rows[0].value);
  await interactivePrivateModelsPicker({ select } as never, 'gw');
  expect(aiSessionCommand).toHaveBeenCalledWith('gw', '/model --any private-deployment:dep-1');
});
