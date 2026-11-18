import { beforeEach, expect, it, vi } from 'vitest';
const review = vi.hoisted(() => vi.fn());
vi.mock('../gateway/agreement.js', () => ({ reviewGatewayModelAgreement: review }));
import { chooseSetting } from './bridge-choose-settings.js';

beforeEach(() => vi.resetAllMocks());
function context() {
  return {
    host: { current: async () => ({ session: { route: 'gateway' } }), prompter: {} },
    setting: vi.fn(async () => {}), done: vi.fn(),
  };
}
it('reviews the agreement before applying a model from the editor', async () => {
  review.mockResolvedValue(true);
  const cx = context();
  expect(await chooseSetting(cx as never, { kind: 'model', model: 'uncensored' })).toBe(true);
  expect(review).toHaveBeenCalledWith('uncensored', cx.host.prompter);
  expect(cx.setting).toHaveBeenCalledWith('/model uncensored');
  expect(review.mock.invocationCallOrder[0]).toBeLessThan(cx.setting.mock.invocationCallOrder[0]);
});
it('cancelling the review keeps the current model', async () => {
  review.mockResolvedValue(false);
  const cx = context();
  await chooseSetting(cx as never, { kind: 'model', model: 'uncensored' });
  expect(cx.setting).not.toHaveBeenCalled();
  expect(cx.done).toHaveBeenCalledOnce();
});
it('a failed review cannot apply the model or report success', async () => {
  review.mockRejectedValue(new Error('agreement changed'));
  const cx = context();
  await expect(chooseSetting(cx as never, { kind: 'model', model: 'uncensored' })).rejects.toThrow('agreement changed');
  expect(cx.setting).not.toHaveBeenCalled();
  expect(cx.done).not.toHaveBeenCalled();
});
