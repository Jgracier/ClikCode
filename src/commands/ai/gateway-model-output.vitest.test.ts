import { expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ list: vi.fn(), emit: vi.fn() }));
vi.mock('../../gateway/models.js', () => ({ gatewayModels: mocks.list, gatewayPriceLabel: () => '$3 / $15' }));
vi.mock('../../cli/structured-output.js', () => ({ emitResult: mocks.emit }));
import { aiGatewayModels } from './status.js';

it('keeps customer pricing and only propagates access markers the Gateway actually sends', async () => {
  const price = { full: { inMTok: 3, outMTok: 15 }, charged: { inMTok: 3, outMTok: 15 }, discountPercent: 0 };
  mocks.list.mockResolvedValue({ models: [{ id: 'customer', price, tags: ['uncensored'] }, { id: 'operator', access: 'subscription', tags: ['abliterated'] }] });
  await aiGatewayModels({} as never);
  expect(mocks.emit).toHaveBeenCalledWith({ models: [
    { id: 'customer', price: '$3 / $15', priceUsdPerMTok: price, tags: ['uncensored'] },
    { id: 'operator', access: 'subscription', tags: ['abliterated'] },
  ] });
});
