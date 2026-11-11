import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forwardParentSignals } from './parent-signals.js';

describe('passing ClikCode\'s signals on to its vendor processes', () => {
  let saved: Array<(...args: unknown[]) => void>;
  let kill: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    // The test runner's own listeners would decide for it; this is about a ClikCode with none.
    saved = process.listeners('SIGTERM') as Array<(...args: unknown[]) => void>;
    process.removeAllListeners('SIGTERM');
    kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
  });
  afterEach(() => {
    kill.mockRestore();
    process.removeAllListeners('SIGTERM');
    for (const listener of saved) process.on('SIGTERM', listener);
  });

  it('stops every child, then lets SIGTERM end ClikCode as it would have', () => {
    const stopped: string[] = [];
    forwardParentSignals((signal) => stopped.push(`a ${signal}`));
    forwardParentSignals((signal) => stopped.push(`b ${signal}`), ['SIGTERM', 'SIGHUP']);
    process.emit('SIGTERM', 'SIGTERM');
    expect(stopped).toEqual(['a SIGTERM', 'b SIGTERM']);
    expect(process.listenerCount('SIGTERM')).toBe(0);
    expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTERM');
  });

  it('leaves the decision to a handler the process installed itself', () => {
    const own = vi.fn();
    process.on('SIGTERM', own);
    const stop = vi.fn();
    forwardParentSignals(stop);
    process.emit('SIGTERM', 'SIGTERM');
    expect(stop).toHaveBeenCalledWith('SIGTERM');
    expect(own).toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });

  it('a released child is not stopped, and leaves no listener behind', () => {
    const stop = vi.fn();
    const release = forwardParentSignals(stop, ['SIGTERM']);
    expect(process.listenerCount('SIGTERM')).toBe(1);
    release();
    expect(process.listenerCount('SIGTERM')).toBe(0);
    expect(stop).not.toHaveBeenCalled();
  });
});
