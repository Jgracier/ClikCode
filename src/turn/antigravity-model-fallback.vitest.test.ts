import { expect, it, vi } from 'vitest';
import { localHarnessForCommand } from '@clikcode/router/ai-local-harness';
import type { HarnessSession } from '../session/model.js';
import type { AiHarnessAccount } from '../harness/definition.js';
import { sessionTurnTransport } from '../harness/transport/select.js';
const { runAcpTurn } = vi.hoisted(() => ({ runAcpTurn: vi.fn() }));
vi.mock('../harness/transport/acp-client.js', async original => ({
  ...await original<typeof import('../harness/transport/acp-client.js')>(), runAcpTurn,
}));
const { runVendorSessionAttempt } = await import('./vendor-session-attempt.js');

it('uses the shared-history native transport when Antigravity ACP omits a native model', async () => {
  runAcpTurn.mockRejectedValueOnce(Object.assign(new Error('model absent from ACP'), { acpUnsupportedModel: true }));
  const runCli = vi.fn(async () => ({ text: 'native answer' }));
  const session = { id: 'agy-fallback', workspace: process.cwd(), nativeSessionId: 'existing-thread', nativeSessionPreallocated: true, permissionMode: 'ask' } as HarnessSession;
  await expect(runVendorSessionAttempt({
    harness: localHarnessForCommand('antigravity')!, account: { id: 'agy', provider: 'antigravity' } as AiHarnessAccount,
    session, transport: 'acp', turnText: 'continue', model: 'claude-sonnet-4-6', environment: {}, images: [],
    run: {}, checkpoint: { persistNow: async () => undefined } as never, sharedObserver: {},
    onSessionId: async () => undefined, runCli,
  })).resolves.toEqual({ text: 'native answer' });
  expect(runAcpTurn).toHaveBeenCalledWith(expect.objectContaining({ plansListModels: false }));
  expect(runCli).toHaveBeenCalledOnce();
  expect(session.nativeSessionId).toBeUndefined();
  expect(session.nativeSessionPreallocated).toBeUndefined();
  expect(session.nativeTransport).toBe('structured-cli');
  expect(sessionTurnTransport(localHarnessForCommand('antigravity')!, session)).toBe('structured-cli');
});
