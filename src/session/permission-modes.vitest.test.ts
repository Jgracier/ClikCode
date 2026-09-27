import { describe, expect, it, vi } from 'vitest';
import { localHarnessForCommand } from '@clikcode/router/ai-local-harness';

// The bridge loads the bundled router, which a source test has not built; the
// catalog's own functions stand in for it, so these are real harness facts.
vi.mock('../runtime/lazy-bridge', async () => {
  const router = await import('@clikcode/router/ai-local-harness');
  return {
    harnessSupportsPermissionMode: router.harnessSupportsPermissionMode, harnessSupportsEffort: router.harnessSupportsEffort,
    harnessTierRank: router.harnessTierRank, harnessIntegrationLevel: router.harnessIntegrationLevel,
    localHarnessCapabilityManifest: router.localHarnessCapabilityManifest,
  };
});

const { sessionPermissionModes } = await import('./options');

describe('the approval modes a conversation can use', () => {
  it('are all three on the Gateway route, where the agent is ClikCode\'s own', () => {
    expect(sessionPermissionModes({ route: 'gateway' }, undefined)).toEqual(['ask', 'bypass', 'auto']);
  });

  it('are the ones a local harness carries to a real flag', () => {
    // Copilot maps ask and bypass, and has no auto.
    expect(sessionPermissionModes({ route: 'local' }, localHarnessForCommand('copilot')!)).toEqual(['ask', 'bypass']);
    expect(sessionPermissionModes({ route: 'local' }, undefined)).toEqual([]);
  });
});
