/** A bypass chat on a root machine runs the turn in auto, and the chat is not changed. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { localHarnessForCommand } from '@clikcode/router/ai-local-harness';
import { turnPermissionMode } from './turn-permission.js';

const claude = localHarnessForCommand('claude')!;
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('turnPermissionMode', () => {
  it('runs bypass in auto where the harness refuses it as root', () => {
    vi.spyOn(process, 'getuid').mockReturnValue(0);
    vi.stubEnv('IS_SANDBOX', '');
    expect(turnPermissionMode(claude, 'bypass')).toBe('auto');
    expect(turnPermissionMode(claude, 'ask')).toBe('ask');
    expect(turnPermissionMode(claude, undefined)).toBe('ask');
  });
  it('is a pure function of the machine: back on a non-root machine the chosen bypass is used again', () => {
    vi.spyOn(process, 'getuid').mockReturnValue(1000);
    expect(turnPermissionMode(claude, 'bypass')).toBe('bypass');
  });
  it('leaves other harnesses alone as root', () => {
    vi.spyOn(process, 'getuid').mockReturnValue(0);
    vi.stubEnv('IS_SANDBOX', '');
    expect(turnPermissionMode(localHarnessForCommand('devin')!, 'bypass')).toBe('bypass');
  });
});
