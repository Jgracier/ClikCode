import { describe, expect, it } from 'vitest';
import { adoptArgs, AGENT_SLICE, agentSliceDirectory, scopeUnitName, sliceArgs, userManagerOwns } from './own-scope.js';

describe('own scope', () => {
  it('names a valid, per-process unit from any session id', () => {
    expect(scopeUnitName('de679bc3-f5e2-43dd', 42)).toBe('clikcode-worker-de679bc3-f5e2-43dd-42.scope');
    expect(scopeUnitName('a b/c@d', 7)).toBe('clikcode-worker-a_b_c_d-7.scope');
  });

  it('adopts the given pid into the agent slice', () => {
    const args = adoptArgs('u.scope', 99);
    expect(args.slice(args.indexOf('PIDs'), args.indexOf('PIDs') + 4)).toEqual(['PIDs', 'au', '1', '99']);
    expect(args.slice(args.indexOf('Slice'), args.indexOf('Slice') + 3)).toEqual(['Slice', 's', AGENT_SLICE]);
    expect(args[args.indexOf('StartTransientUnit') + 2]).toBe('u.scope');
  });

  it('moves only processes the user manager owns', () => {
    expect(userManagerOwns('0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-code-1.scope\n')).toBe(true);
    expect(userManagerOwns('0::/user.slice/user-1000.slice/session-4.scope\n')).toBe(false);
    expect(userManagerOwns('0::/system.slice/tailscaled.service\n')).toBe(false);
    expect(userManagerOwns('')).toBe(false);
  });

  it('creates the agent slice with a memory ceiling in whole bytes', () => {
    const args = sliceArgs(1000.7);
    expect(args[args.indexOf('StartTransientUnit') + 2]).toBe(AGENT_SLICE);
    expect(args.slice(args.indexOf('MemoryHigh'), args.indexOf('MemoryHigh') + 3)).toEqual(['MemoryHigh', 't', '1000']);
  });

  it('finds the agent slice under the user manager, beside app.slice', () => {
    expect(agentSliceDirectory('0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-code-1.scope\n'))
      .toBe('/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/clikcode.slice');
    expect(agentSliceDirectory('0::/system.slice/tailscaled.service\n')).toBeUndefined();
  });
});
