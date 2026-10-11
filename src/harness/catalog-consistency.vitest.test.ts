import { describe, expect, it } from 'vitest';
import { HOME_REDIRECT_ENV_DEFAULTS, harnessSupportsPermissionMode, allLocalHarnesses, harnessAcpLaunch, harnessSupportsEffort, harnessSupportsImages, localHarnessCapabilityManifest } from '@clikcode/router/ai-local-harness';

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
      .filter((h) => (h.effortValues?.length ?? 0) > 0 && !h.effortArgvPrefix?.length && !h.acp?.effortArgvPrefix?.length && !h.acp?.effortConfigId)
      .map((h) => h.command);
    expect(offenders, 'these declare effort values that cannot be sent').toEqual([]);
  });

  it('agrees with itself about whether effort is supported', () => {
    for (const h of harnesses) {
      // A one-shot flag, or over ACP only: a flag (Copilot) or a session option (Goose).
      const declared = (h.effortArgvPrefix?.length ?? 0) > 0 || (h.acp?.effortArgvPrefix?.length ?? 0) > 0 || Boolean(h.acp?.effortConfigId);
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

  it('carries every declared permission mode to the vendor somehow', () => {
    // Either argv or environment -- a mode that reaches the vendor by neither
    // route is a control that silently does nothing, which is the one outcome
    // a permission setting must never have. Goose is why "somehow": it has no
    // per-run mode flag at all, only GOOSE_MODE.
    const offenders: string[] = [];
    for (const h of harnesses) {
      for (const mode of h.permissionModes ?? []) {
        if (!h.permissionArgv?.[mode] && !h.permissionEnv?.[mode] && !h.acp?.permissionModeIds?.[mode]) offenders.push(`${h.command}:${mode}`);
      }
    }
    expect(offenders, 'permission modes that reach the vendor by none of argv, env or an ACP session mode').toEqual([]);
  });

  it('never declares a mapping with no modes, or modes with no mapping', () => {
    for (const h of harnesses) {
      const modes = (h.permissionModes ?? []).length;
      const mapped = new Set([...Object.keys(h.permissionArgv ?? {}), ...Object.keys(h.permissionEnv ?? {}), ...Object.keys(h.acp?.permissionModeIds ?? {})]).size;
      expect(Boolean(modes) === Boolean(mapped), `${h.command}: modes=${modes} mapped=${mapped}`).toBe(true);
    }
  });

  it('agrees with harnessSupportsPermissionMode, which is what the pickers offer', () => {
    // The picker and the catalog must not disagree: a mode offered but not
    // carried, or carried but not offered, both mislead.
    for (const h of harnesses) {
      for (const mode of ['ask', 'bypass', 'auto'] as const) {
        const declared = Boolean(h.permissionModes?.includes(mode));
        const carried = Boolean(h.permissionArgv?.[mode] ?? h.permissionEnv?.[mode] ?? h.acp?.permissionModeIds?.[mode]);
        expect(harnessSupportsPermissionMode(h, mode), `${h.command}:${mode}`).toBe(declared && carried);
      }
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
      expect(Boolean(h.turn || h.acp), `${h.command} cannot run a turn at all`).toBe(true);
    }
  });
  it('matches what the installed vendor binaries were verified to accept', () => {
    const byCommand = new Map(harnesses.map((h) => [h.command, h]));
    // droid refuses --disable-builtin-skills in every ACP mode (0.223.0).
    expect(JSON.stringify(localHarnessCapabilityManifest(byCommand.get('droid')!).options)).not.toContain('disable-builtin-skills');
    // cn --model ADDS a hub model (owner/package); it is no model selector (1.5.47).
    expect(byCommand.get('cn')?.modelArgvPrefix).toBeUndefined();
    // junie's launcher finds its builds through JUNIE_DATA, empty under a private HOME.
    expect(HOME_REDIRECT_ENV_DEFAULTS.JUNIE_DATA).toBe('~/.local/share/junie');
    // devin session/new offers accept-edits|smart|ask|plan|bypass and starts in accept-edits.
    expect(byCommand.get('devin')?.acp?.permissionModeIds).toEqual({ ask: 'ask', auto: 'smart', bypass: 'bypass' });
    expect(byCommand.get('devin')?.acp?.planModeId).toBe('plan');
    for (const command of ['opencode', 'kilo']) expect(byCommand.get(command)?.acp?.planModeId, command).toBe('plan');
    // grok 1.0.50 accepts none|minimal|low|medium|high|xhigh|max.
    expect(byCommand.get('grok')?.effortValues).toContain('xhigh');
  });
});
