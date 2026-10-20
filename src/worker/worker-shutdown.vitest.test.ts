import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const log = vi.hoisted(() => ({ lines: [] as Array<[string, unknown]> }));
vi.mock('../runtime/lifecycle-log.js', () => ({ lifecycle: (event: string, data: unknown) => { log.lines.push([event, data]); } }));
vi.mock('../turn/vendor-process.js', () => ({ closePersistentTransport: () => new Promise<void>(() => undefined) }));
vi.mock('../agent/session-state.js', () => ({ disposeSessionState: () => undefined, takeShellNotifications: () => [] }));
vi.mock('../agent/background-agents.js', () => ({ existingSessionAgents: () => undefined }));
vi.mock('../session/store/paths.js', () => ({ stateDirectory: () => '/nonexistent' }));
vi.mock('../agent/lsp/servers.js', () => ({ shutdownLanguageServers: async () => undefined }));
vi.mock('../agent/computer/browser.js', () => ({ closeComputerPage: async () => undefined }));
vi.mock('./registry.js', () => ({ removeWorkerRecord: async () => undefined }));

const { boundedStep, createShutdown } = await import('./worker-shutdown.js');

beforeEach(() => { vi.useFakeTimers(); log.lines = []; });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('shutdown is bounded', () => {
  it('boundedStep gives up on a hung step, names it, and a throwing step is swallowed', async () => {
    const done = boundedStep('hung', () => new Promise(() => undefined), 1000);
    await vi.advanceTimersByTimeAsync(1000);
    await done;
    expect(log.lines).toContainEqual(['worker.shutdown.stalled', { step: 'hung', afterMs: 1000 }]);
    await expect(boundedStep('boom', async () => { throw new Error('x'); }, 1000)).resolves.toBeUndefined();
  });

  it('a vendor close and an out-of-turn settle that never finish do not stop the worker exiting', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const ctx = {
      observer: { attachedCount: 0 }, sessionId: 's', token: 't', hold: { held: async () => false, release: async () => undefined }, socketPath: '/nonexistent',
      connections: new Map(), turnRunning: false, agentSession: {}, outOfTurn: { settle: () => new Promise<void>(() => undefined) },
      server: { close: () => undefined }, recordWrite: Promise.resolve(), resumeWaiter: { stop: () => undefined, pending: false },
    };
    const shutdown = createShutdown(ctx as never);
    const done = shutdown('idle timeout');
    await vi.advanceTimersByTimeAsync(60_000);
    await done;
    expect(exit).toHaveBeenCalledWith(0);
    const steps = log.lines.filter(([event]) => event === 'worker.shutdown.stalled').map(([, data]) => (data as { step: string }).step);
    expect(steps).toEqual(['out-of-turn settle', 'vendor close']);
  });
});
