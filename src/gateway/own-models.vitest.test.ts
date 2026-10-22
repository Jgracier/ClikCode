import { describe, expect, it, vi } from 'vitest';

vi.mock('../agent/models/for-session.js', () => ({ gatewayConnection: () => ({ baseUrl: 'https://gw.test', apiKey: 'k' }) }));
const { idleWords, ownModelIdleMinutes, setOwnModelIdleMinutes, wakeOwnModel } = await import('./own-models.js');

const answer = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

describe("the user's own models on the Gateway", () => {
  it('starts one now, and says whether it was already up', async () => {
    const fetchImpl = answer(200, { data: { model: 'Qwen/Qwen3-8B', state: 'starting' } });
    expect(await wakeOwnModel('Qwen/Qwen3-8B', { config: {} as never, fetchImpl })).toBe('starting');
    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('https://gw.test/v1/models/wake');
    expect(JSON.parse(String(init.body))).toEqual({ model: 'Qwen/Qwen3-8B' });
    await expect(wakeOwnModel('x', { config: {} as never, fetchImpl: answer(404, { error: { message: 'x is not one of your models' } }) })).rejects.toThrow('not one of your models');
  });

  it('reads and changes how long they may sit idle (0 = never)', async () => {
    expect(await ownModelIdleMinutes({ config: {} as never, fetchImpl: answer(200, { data: { model_idle_minutes: 5 } }) })).toBe(5);
    const patch = answer(200, { data: { model_idle_minutes: 0 } });
    expect(await setOwnModelIdleMinutes(0, { config: {} as never, fetchImpl: patch })).toBe(0);
    expect(JSON.parse(String((patch.mock.calls[0]! as unknown as [string, RequestInit])[1].body))).toEqual({ model_idle_minutes: 0 });
    expect([idleWords(5), idleWords(60), idleWords(0)]).toEqual(['5 min', '1 hr', 'never']);
  });
});
