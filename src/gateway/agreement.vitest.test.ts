import { beforeEach, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({ list: vi.fn(), consent: vi.fn(), accept: vi.fn(), output: vi.fn() }));
vi.mock('./models.js', () => ({
  gatewayModels: api.list,
  gatewayModelForWord: (models: Array<{ id: string }>, id: string) => models.find((model) => model.id === id),
  gatewayUncensoredConsent: api.consent,
  acceptGatewayUncensoredTerms: api.accept,
}));
vi.mock('../cli/structured-output.js', () => ({ emitResult: api.output }));
import { reviewGatewayModelAgreement } from './agreement.js';
import { gatewayAgreement } from '../commands/gateway-agreement.js';

beforeEach(() => {
  vi.resetAllMocks();
  api.list.mockResolvedValue({ models: [{ id: 'chat' }, { id: 'uncensored', tags: ['uncensored'] }] });
  api.consent.mockResolvedValue({ version: 'v2', terms: 'Read these terms', accepted: false, acceptedAt: null });
  api.accept.mockResolvedValue({ version: 'v2', terms: 'Read these terms', accepted: true, acceptedAt: 'now' });
});

it('shows the exact terms in the editor and accepts only after its explicit choice', async () => {
  const select = vi.fn(async (_title: string, _options: unknown[]) => true);
  expect(await reviewGatewayModelAgreement('uncensored', { select } as never)).toBe(true);
  expect(select.mock.calls[0]?.[0]).toContain('Read these terms');
  expect(api.accept).toHaveBeenCalledWith('v2');
});

it('cancellation records nothing and ordinary models need no agreement', async () => {
  const select = vi.fn(async () => false);
  expect(await reviewGatewayModelAgreement('uncensored', { select } as never)).toBe(false);
  expect(api.accept).not.toHaveBeenCalled();
  select.mockClear();
  expect(await reviewGatewayModelAgreement('chat', { select } as never)).toBe(true);
  expect(select).not.toHaveBeenCalled();
});

it('does not ask again after acceptance and surfaces refused acceptance', async () => {
  const select = vi.fn(async (_title: string, _options: unknown[]) => true);
  api.consent.mockResolvedValueOnce({ accepted: true });
  expect(await reviewGatewayModelAgreement('uncensored', { select } as never)).toBe(true);
  expect(select).not.toHaveBeenCalled();
  api.accept.mockResolvedValueOnce({ accepted: false });
  await expect(reviewGatewayModelAgreement('uncensored', { select } as never)).rejects.toThrow('not recorded');
});

it('headless reading never accepts, and a stale version cannot be accepted', async () => {
  await gatewayAgreement({} as never, {});
  expect(api.output).toHaveBeenCalledWith(expect.objectContaining({ terms: 'Read these terms', accepted: false }));
  expect(api.accept).not.toHaveBeenCalled();
  await expect(gatewayAgreement({} as never, { acceptVersion: 'v1' })).rejects.toThrow('version has changed');
  expect(api.accept).not.toHaveBeenCalled();
  const config = {} as never;
  await gatewayAgreement(config, { acceptVersion: 'v2' });
  expect(api.accept).toHaveBeenCalledWith('v2', { config });
  expect(api.output).toHaveBeenLastCalledWith(expect.objectContaining({ accepted: true }));
});

it('requires an interactive review or explicit headless acceptance without a picker', async () => {
  await expect(reviewGatewayModelAgreement('uncensored', {} as never)).rejects.toThrow('gateway agreement');
  expect(api.accept).not.toHaveBeenCalled();
});
