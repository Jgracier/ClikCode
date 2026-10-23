import { afterEach, describe, expect, it, vi } from 'vitest';
import { startingModelPhase, waitForModelStart } from './turn-model-step.js';

describe('the status while the user\'s own model starts', () => {
  it('says it is finding a server until a machine is handed over', () => {
    expect(startingModelPhase(0, { phase: 'finding-server' })).toBe('Finding an available server');
    expect(startingModelPhase(20_000, { phase: 'finding-server' })).toBe('Finding an available server · 20 s');
  });

  it('then says it is starting the model, with what is left of the usual start where it landed', () => {
    const loading = { phase: 'starting-model', elapsedS: 90, expectedS: 480, remainingS: 390 } as const;
    expect(startingModelPhase(95_000, loading)).toBe('Starting model · about 6 min 30 s left');
    // Between two readings the countdown carries on from the last one.
    expect(startingModelPhase(95_000, loading, 30_000)).toBe('Starting model · about 6 min left');
    expect(startingModelPhase(500_000, loading, 390_000)).toBe('Starting model · almost ready');
  });

  it('is honest when a start runs past its usual time, or when nothing is known about it', () => {
    expect(startingModelPhase(0, { phase: 'starting-model', elapsedS: 600, expectedS: 480, remainingS: 0, overdue: true }, 5_000))
      .toBe('Starting model · taking longer than usual · 10 min');
    expect(startingModelPhase(0, { phase: 'starting-model', elapsedS: 45 })).toBe('Starting model · 45 s');
    // A Gateway with nothing to say: the plain wait, as before.
    expect(startingModelPhase(500)).toBe('Starting model');
    expect(startingModelPhase(7_000)).toBe('Starting model · 7 s');
  });
});

describe('waiting for the model to start', () => {
  afterEach(() => vi.useRealTimers());

  it('asks how it is going at once and every 5 s, and keeps the line moving in between', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    const readings = [
      { phase: 'finding-server' } as const,
      { phase: 'starting-model', elapsedS: 0, expectedS: 60, remainingS: 60 } as const,
    ];
    const poll = vi.fn(async () => readings[Math.min(poll.mock.calls.length - 1, readings.length - 1)]);
    const phases: string[] = [];
    const done = waitForModelStart({ waitS: 10, since: Date.now(), onPhase: (phase) => phases.push(phase), poll });
    await vi.advanceTimersByTimeAsync(10_500);
    await done;
    expect(poll).toHaveBeenCalledTimes(2);
    expect(phases[0]).toBe('Finding an available server');
    expect(phases).toContain('Finding an available server · 4 s');
    expect(phases.at(-1)).toMatch(/^Starting model · about .* left$/);
    expect(phases.length).toBeGreaterThanOrEqual(9);
  });

  it('keeps the last reading when asking fails, and still waits the whole time', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    const poll = vi.fn()
      .mockResolvedValueOnce({ phase: 'finding-server' })
      .mockRejectedValue(new Error('gateway unreachable'));
    const phases: string[] = [];
    const done = waitForModelStart({ waitS: 7, since: Date.now(), onPhase: (phase) => phases.push(phase), poll });
    await vi.advanceTimersByTimeAsync(7_500);
    await done;
    expect(phases.every((phase) => phase.startsWith('Finding an available server'))).toBe(true);
    expect(phases).toHaveLength(7);
  });

  it('shows the plain wait when the client has nothing to say about the start', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    const phases: string[] = [];
    const done = waitForModelStart({ waitS: 3, since: Date.now(), onPhase: (phase) => phases.push(phase) });
    await vi.advanceTimersByTimeAsync(3_500);
    await done;
    expect(phases).toEqual(['Starting model', 'Starting model · 1 s', 'Starting model · 2 s']);
  });
});
