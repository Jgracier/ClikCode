import { describe, expect, it } from 'vitest';
import { allLocalHarnesses, harnessAcpLaunch, harnessSupportsEffort, harnessSupportsImages, localHarnessCapabilityManifest } from '@clikcode/router/ai-local-harness';

/**
 * A declared capability must be a usable one.
 *
 * This exists because of Antigravity: the catalog declared
 * effortArgvPrefix ['--effort'] and effortValues [low,medium,high], so
 * ClikCode sent `--effort medium` on every turn -- and Antigravity encodes
 * effort in the model id and refuses the flag outright. Every turn on every
 * account failed, and because the refusal looked like the account's fault,
 * failover walked the whole account list failing identically. One wrong
 * declaration, twenty-one accounts' worth of symptom.
 *
 * These are contradictions inside a single entry, so they are catchable here
 * without running a vendor binary. What this CANNOT check is the other
 * direction -- a flag the vendor accepts that we never declare -- which needs
 * the real CLI. Antigravity proved that answer comes from running it, not
 * from reading docs.
 *
 * Two rules were deliberately NOT written, because a first draft of this
 * flagged both and both were wrong:
 *   - "acp declared but transport is not acp" is fine. `transport` is the
 *     PREFERRED transport, not the only supported one; gemini declares a real
 *     `--acp` (verified in its --help) while ClikCode prefers its CLI.
 *   - "session resume with no turn.resumeIdPrefix" is fine. amp resumes via
 *     turn.resumeArgv + resumeIdSuffix, which is a different spelling of the
 *     same capability.
 */
const harnesses = allLocalHarnesses();

describe('every declared capability is usable', () => {
  it('has harnesses to check', () => {
    expect(harnesses.length).toBeGreaterThanOrEqual(24);
  });

  it('never declares an effort flag without the values it accepts', () => {
    // A flag with no legal values is a picker control the user cannot use,
    // and a value ClikCode would then pass blind.
    const offenders = harnesses
      .filter((h) => (h.effortArgvPrefix?.length ?? 0) > 0 && (h.effortValues?.length ?? 0) === 0)
      .map((h) => h.command);
    expect(offenders, 'these declare an effort flag with no legal values').toEqual([]);
  });

  it('never declares effort values with no flag to pass them through', () => {
    const offenders = harnesses
      .filter((h) => (h.effortValues?.length ?? 0) > 0 && (h.effortArgvPrefix?.length ?? 0) === 0)
      .map((h) => h.command);
    expect(offenders, 'these declare effort values that cannot be sent').toEqual([]);
  });

  it('agrees with itself about whether effort is supported', () => {
    for (const h of harnesses) {
      const declared = (h.effortArgvPrefix?.length ?? 0) > 0;
      expect(harnessSupportsEffort(h), `${h.command}`).toBe(declared);
    }
  });

  it('publishes a non-empty value list for every enum option', () => {
    // This is what auggie failed: kind 'enum' with values []. The picker
    // renders a control with nothing to pick.
    const offenders: string[] = [];
    for (const h of harnesses) {
      for (const option of localHarnessCapabilityManifest(h).options ?? []) {
        if (option.kind === 'enum' && !(option.values?.length ?? 0)) offenders.push(`${h.command}:${option.id}`);
      }
    }
    expect(offenders, 'enum options with no values').toEqual([]);
  });

  it('maps every declared permission mode to real argv', () => {
    const offenders: string[] = [];
    for (const h of harnesses) {
      for (const mode of h.permissionModes ?? []) {
        if (!h.permissionArgv || !(mode in h.permissionArgv)) offenders.push(`${h.command}:${mode}`);
      }
    }
    expect(offenders, 'permission modes with no argv mapping').toEqual([]);
  });

  it('never declares permission argv with no modes, or modes with no argv', () => {
    for (const h of harnesses) {
      const modes = (h.permissionModes ?? []).length;
      const argv = Object.keys(h.permissionArgv ?? {}).length;
      expect(Boolean(modes) === Boolean(argv), `${h.command}: modes=${modes} argv=${argv}`).toBe(true);
    }
  });

  it('can actually build an ACP launch wherever ACP is declared', () => {
    for (const h of harnesses) {
      if (!h.acp) continue;
      expect(harnessAcpLaunch(h, { model: 'm', effort: null, permissionMode: 'ask' }), `${h.command}`).toBeDefined();
    }
  });

  it('agrees with itself about image support', () => {
    for (const h of harnesses) {
      const declared = (h.imageArgvPrefix?.length ?? 0) > 0;
      if (declared) expect(harnessSupportsImages(h), `${h.command}`).toBe(true);
    }
  });

  it('has a model flag wherever it discovers models', () => {
    const offenders = harnesses
      .filter((h) => (h.modelDiscoveryArgv?.length ?? 0) > 0 && !(h.modelArgvPrefix?.length ?? 0))
      .map((h) => h.command);
    expect(offenders, 'these list models they cannot select').toEqual([]);
  });

  it('declares a turn or an ACP contract for every runnable harness', () => {
    for (const h of harnesses) {
      if (h.surface !== 'terminal') continue;
      expect(Boolean(h.turn || h.acp), `${h.command} cannot run a turn at all`).toBe(true);
    }
  });
});
