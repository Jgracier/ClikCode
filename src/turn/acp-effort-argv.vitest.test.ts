/** An effort the agent's ACP does not offer used to send the turn to its CLI, which takes the prompt as one argument. A
 * conversation carried over to the agent is far past that limit, so the CLI refused it before starting and the turn was
 * lost. Such a turn now stays on ACP at the agent's own effort; a short one still falls back to the CLI, as before. */
import { beforeEach, expect, it, vi } from 'vitest';
import { localHarnessForCommand } from '@clikcode/router/ai-local-harness';
import type { HarnessSession } from '../session/model.js';
import type { AiHarnessAccount } from '../harness/definition.js';
const { runAcpTurn } = vi.hoisted(() => ({ runAcpTurn: vi.fn() }));
vi.mock('../harness/transport/acp-client.js', async (original) => ({
  ...await original<typeof import('../harness/transport/acp-client.js')>(), runAcpTurn,
}));
const { runVendorSessionAttempt } = await import('./vendor-session-attempt.js');

const effortRefused = () => Object.assign(new Error('grok ACP does not offer effort high'), { acpUnsupportedEffort: true });
const attempt = (turnText: string, runCli: () => Promise<{ text: string }>) => runVendorSessionAttempt({
  harness: localHarnessForCommand('grok')!, account: { id: 'g', provider: 'xai' } as AiHarnessAccount,
  session: { id: 'grok-effort', workspace: process.cwd(), permissionMode: 'ask', effort: 'high' } as HarnessSession,
  transport: 'acp', turnText, model: null, effort: 'high', environment: {}, images: [],
  run: {}, checkpoint: { persistNow: async () => undefined } as never, sharedObserver: {},
  onSessionId: async () => undefined, runCli,
});

beforeEach(() => runAcpTurn.mockReset());

it('keeps a prompt past the CLI argv limit on ACP, at the agent\'s own effort', async () => {
  runAcpTurn.mockRejectedValueOnce(effortRefused()).mockResolvedValueOnce({ text: 'acp answer' });
  const runCli = vi.fn(async () => ({ text: 'cli answer' }));
  await expect(attempt('x'.repeat(200 * 1024), runCli)).resolves.toEqual({ text: 'acp answer' });
  expect(runCli).not.toHaveBeenCalled();
  expect(runAcpTurn).toHaveBeenCalledTimes(2);
  expect(runAcpTurn.mock.calls[0]![0]).toMatchObject({ effort: 'high' });
  expect(runAcpTurn.mock.calls[1]![0].effort).toBeUndefined();
});

it('still falls back to the CLI for a prompt it can take', async () => {
  runAcpTurn.mockRejectedValueOnce(effortRefused());
  const runCli = vi.fn(async () => ({ text: 'cli answer' }));
  await expect(attempt('a short request', runCli)).resolves.toEqual({ text: 'cli answer' });
  expect(runCli).toHaveBeenCalledOnce();
  expect(runAcpTurn).toHaveBeenCalledOnce();
});
