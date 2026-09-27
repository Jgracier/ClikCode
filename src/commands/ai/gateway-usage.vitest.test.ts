import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindGlobalFlags } from '../../cli/flags.js';

vi.mock('../../gateway/credentials.js', () => ({
  getApiUrl: () => 'https://clikdeploy.com',
  getApiKeyForUrl: () => 'cd_live_key',
}));

const { aiGatewayUsage } = await import('./status.js');

const config = {} as never;

afterEach(() => { vi.restoreAllMocks(); bindGlobalFlags({}); });

describe('gateway usage', () => {
  it('reads the signed-in account\'s usage from the Gateway and reports it', async () => {
    bindGlobalFlags({ json: true });
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ success: true, data: { windowDays: 7, credit: { unlimited: true }, totals: { calls: 2 } } }), { status: 200 }));
    await aiGatewayUsage(config, { days: '7' }, fetchImpl as never);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe('https://clikdeploy.com/api/clikcode/v1/usage?days=7');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer cd_live_key');
    expect(JSON.parse(String(write.mock.calls[0]![0]))).toEqual({ apiUrl: 'https://clikdeploy.com', windowDays: 7, credit: { unlimited: true }, totals: { calls: 2 } });
  });

  it('says what went wrong, and refuses a window the Gateway would not honour', async () => {
    const refused = vi.fn(async () => new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 401 }));
    await expect(aiGatewayUsage(config, {}, refused as never)).rejects.toThrow('ClikDeploy Gateway usage: Unauthorized');
    const missing = vi.fn(async () => new Response('Not Found', { status: 404 }));
    await expect(aiGatewayUsage(config, {}, missing as never)).rejects.toThrow('this Gateway does not report usage yet');
    await expect(aiGatewayUsage(config, { days: '120' }, refused as never)).rejects.toThrow('--days must be a whole number from 1 to 90');
  });
});
