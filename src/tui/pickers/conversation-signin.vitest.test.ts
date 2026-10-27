/** Choosing the Gateway while signed out: a model on this computer needs no sign-in, so the choice offers it. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { selectProviderConversation } from './conversation.js';

const mocks = vi.hoisted(() => ({
  apiKey: undefined as string | undefined,
  asked: [] as Array<{ title: string; values: unknown[] }>,
  answer: undefined as unknown,
  hosted: vi.fn(async () => undefined),
  login: vi.fn(async () => undefined),
}));

vi.mock('../../gateway/credentials.js', () => ({ getApiKeyForUrl: () => mocks.apiKey, getApiUrl: () => 'https://gateway.test' }));
vi.mock('../../commands/gateway.js', () => ({ gatewayLogin: mocks.login }));
vi.mock('./choose.js', () => ({
  chooseOption: async (_rl: unknown, title: string, options: Array<{ value: unknown }>) => { mocks.asked.push({ title, values: options.map((option) => option.value) }); return mocks.answer; },
}));
vi.mock('./model.js', () => ({ interactiveHostedPicker: mocks.hosted }));
vi.mock('../../session/state/read.js', () => ({ readState: async () => ({ sessions: [{ id: 's1', route: 'gateway' }] }) }));
vi.mock('../../session/state/write.js', () => ({ writeState: async () => undefined }));
vi.mock('../../commands/ai/conversations.js', () => ({ moveToProvider: async () => undefined, turnIsRunning: async () => false }));
vi.mock('../../turn/handoff.js', () => ({ synchronizeNativeTranscript: async () => undefined }));
vi.mock('../../commands/ai/sessions.js', () => ({ applyClikCodeAgentSessionPolicy: () => undefined }));

const config = {} as never;
const rl = {} as never;

beforeEach(() => { mocks.apiKey = undefined; mocks.asked.length = 0; mocks.answer = undefined; mocks.hosted.mockClear(); mocks.login.mockClear(); });

describe('the Gateway chosen while signed out', () => {
  it('offers a model on this computer beside the sign-ins, and opens hosted AI for it without signing in', async () => {
    mocks.answer = 'local';
    expect(await selectProviderConversation(config, rl, 's1', '__gateway__', { offerLocal: true })).toBe('s1');
    expect(mocks.asked[0]!.values).toEqual(['google', 'github', 'local']);
    expect(mocks.hosted).toHaveBeenCalledWith(rl, 's1');
    expect(mocks.login).not.toHaveBeenCalled();
  });

  it('does not offer it where the Gateway was asked for by name or to start a GPU, which need the sign-in', async () => {
    mocks.answer = undefined;
    await selectProviderConversation(config, rl, 's1', '__gateway__');
    expect(mocks.asked[0]!.values).toEqual(['google', 'github']);
    expect(mocks.hosted).not.toHaveBeenCalled();
  });

  it('moves nothing when the choice is closed', async () => {
    mocks.answer = undefined;
    expect(await selectProviderConversation(config, rl, 's1', '__gateway__', { offerLocal: true })).toBe('s1');
    expect(mocks.hosted).not.toHaveBeenCalled();
    expect(mocks.login).not.toHaveBeenCalled();
  });

  it('asks nothing of a user who is signed in', async () => {
    mocks.apiKey = 'key';
    await selectProviderConversation(config, rl, 's1', '__gateway__', { offerLocal: true });
    expect(mocks.asked).toEqual([]);
    expect(mocks.hosted).not.toHaveBeenCalled();
  });
});
