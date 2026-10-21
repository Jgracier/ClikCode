/** Claude Code refuses bypass when it runs as root (unless IS_SANDBOX is set), so a chat on a
 * machine where ClikCode runs as root is offered ask and auto only; elsewhere bypass, ask, auto. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { harnessSupportsPermissionMode, localHarnessForCommand } from '@clikcode/router/ai-local-harness';
import { sessionPermissionModes } from './options.js';

const claude = localHarnessForCommand('claude')!;
const local = { route: 'local' as const };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('Claude Code permission modes', () => {
  it('offers bypass, ask and auto to a normal user', () => {
    vi.spyOn(process, 'getuid').mockReturnValue(1000);
    expect([...sessionPermissionModes(local, claude)].sort()).toEqual(['ask', 'auto', 'bypass']);
  });

  it('offers no bypass as root', () => {
    vi.spyOn(process, 'getuid').mockReturnValue(0);
    vi.stubEnv('IS_SANDBOX', '');
    expect([...sessionPermissionModes(local, claude)].sort()).toEqual(['ask', 'auto']);
    expect(harnessSupportsPermissionMode(claude, 'bypass')).toBe(false);
  });

  it('offers bypass as root inside a sandbox, as Claude Code itself does', () => {
    vi.spyOn(process, 'getuid').mockReturnValue(0);
    vi.stubEnv('IS_SANDBOX', '1');
    expect(harnessSupportsPermissionMode(claude, 'bypass')).toBe(true);
  });

  it('leaves other harnesses alone as root', () => {
    vi.spyOn(process, 'getuid').mockReturnValue(0);
    vi.stubEnv('IS_SANDBOX', '');
    const devin = localHarnessForCommand('devin')!;
    expect(harnessSupportsPermissionMode(devin, 'bypass')).toBe(true);
  });
});
