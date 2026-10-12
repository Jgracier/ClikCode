import { describe, expect, it } from 'vitest';
import { NATIVE_USAGE_PROBES } from './accounts/usage-probes.js';
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

  it('derives image support from the CLI flag or from ACP, never from a name', () => {
    const byCommand = new Map(harnesses.map((h) => [h.command, h]));
    // ACP agents that advertise promptCapabilities.image (initialize, probed 2026-10-11) get real image blocks.
    for (const command of ['claude', 'gemini', 'goose', 'cursor', 'opencode', 'kilo', 'droid', 'cline', 'qwen', 'kimi', 'devin', 'vibe']) {
      expect(harnessSupportsImages(byCommand.get(command)!), command).toBe(true);
    }
    // Grok Build's initialize says image:false and it has no attach flag.
    expect(harnessSupportsImages(byCommand.get('grok')!)).toBe(false);
    // A CLI-only harness without an attach flag carries none.
    expect(harnessSupportsImages(byCommand.get('cn')!)).toBe(false);
    expect(harnessSupportsImages(byCommand.get('openclaw')!)).toBe(false);
  });

  it('only declares a plan mode the runtime can switch on', () => {
    // A plan switch is either an ACP session mode (acp.planModeId) or a CLI option with argv.
    for (const h of harnesses.filter((entry) => entry.planMode)) {
      const option = localHarnessCapabilityManifest(h).options.find((candidate) => candidate.id === h.planMode!.option);
      expect(Boolean(h.acp?.planModeId) || Boolean(option?.argv?.length), `${h.command}: planMode with no planModeId and no CLI option argv`).toBe(true);
    }
    // A harness whose preferred transport is ACP and whose plan mode exists there must name the session mode.
    for (const command of ['cursor', 'kimi', 'droid', 'cline', 'command', 'devin', 'qwen', 'junie', 'opencode', 'kilo', 'claude']) {
      expect(harnesses.find((h) => h.command === command)?.acp?.planModeId, command).toBeTruthy();
    }
  });

  it('never leaves a permission mapping unreachable or an ACP mode unowned', () => {
    for (const h of harnesses) {
      for (const mode of Object.keys(h.acp?.permissionArgv ?? {})) expect(h.permissionModes, `${h.command}: acp.permissionArgv.${mode}`).toContain(mode);
      for (const mode of Object.keys(h.acp?.permissionModeIds ?? {})) expect(h.permissionModes, `${h.command}: acp.permissionModeIds.${mode}`).toContain(mode);
    }
    // Two ClikCode modes on one ACP mode id (Cline: its modes are plan|act, not permission levels) must differ at launch.
    for (const h of harnesses) {
      const ids = h.acp?.permissionModeIds ?? {};
      const seen = new Map<string, string>();
      for (const [mode, id] of Object.entries(ids)) {
        const other = seen.get(id);
        if (other) expect(JSON.stringify(h.permissionArgv?.[mode as 'ask']?.argv), `${h.command}: ${mode} and ${other} share ACP mode ${id}`).not.toBe(JSON.stringify(h.permissionArgv?.[other as 'ask']?.argv));
        seen.set(id, mode);
      }
    }
  });

  it('maps Kimi onto what `kimi --help` and its ACP session say', () => {
    const kimi = harnesses.find((h) => h.command === 'kimi')!;
    // --yolo is "Ask When Needed", --auto is "Never Ask"; Ask is the unflagged default, --plan is plan mode.
    expect(kimi.permissionArgv).toEqual({ ask: { argv: [] }, bypass: { argv: ['--auto'] }, auto: { argv: ['--yolo'] } });
    expect(kimi.acp?.permissionModeIds).toEqual({ ask: 'default', auto: 'yolo', bypass: 'auto' });
    expect(kimi.acp?.planModeId).toBe('plan');
    expect(kimi.acp?.effortConfigId).toBe('thinking');
    expect(kimi.planMode).toEqual({ option: 'plan', value: true });
  });

  it('gives every harness one stated answer about reading its quota, matching the probe table', () => {
    for (const h of harnesses) {
      expect(h.quotaProbe, `${h.command} must declare quotaProbe: true or { none: reason }`).toBeDefined();
      if (h.quotaProbe === true) expect(NATIVE_USAGE_PROBES[h.command], `${h.command} claims a quota probe`).toBeTypeOf('function');
      else {
        expect(NATIVE_USAGE_PROBES[h.command], `${h.command} has a probe but says none`).toBeUndefined();
        expect((h.quotaProbe as { none: string }).none.length, `${h.command} needs a reason`).toBeGreaterThan(10);
      }
    }
    for (const command of Object.keys(NATIVE_USAGE_PROBES)) expect(harnesses.find((h) => h.command === command)?.quotaProbe, command).toBe(true);
  });

  it('gives every harness with a vendor sign-in a way to start it', () => {
    for (const h of harnesses.filter((entry) => entry.localAuth.includes('vendor-cli'))) {
      const way = h.loginArgv !== undefined || h.loginKeyCommand !== undefined || (h.authEnv?.length ?? 0) > 0;
      expect(way, `${h.command} lists vendor-cli sign-in but declares no loginArgv, key command or env key`).toBe(true);
    }
  });
});

describe('vendor knowledge lives in the catalog, not in branches', () => {
  it('writes the provider menu labels the key-route menus agree on once', () => {
    const labels = (command: string, provider: string) => harnesses.find((h) => h.command === command)?.loginKeyRoutes
      ?.find((route) => 'provider' in route && route.provider === provider)?.choose.at(-1);
    for (const provider of ['anthropic', 'openrouter', 'groq', 'cerebras', 'huggingface', 'mistral', 'deepseek', 'zai']) {
      const shared = labels('cline', provider);
      expect(shared, provider).toBeTruthy();
      expect(labels('opencode', provider), `opencode:${provider}`).toBe(shared);
      expect(labels('kilo', provider), `kilo:${provider}`).toBe(shared);
      expect(labels('pi', provider), `pi:${provider}`).toBe(shared);
    }
  });

  it('declares where each vendor model catalog is read from', () => {
    const byCommand = new Map(harnesses.map((h) => [h.command, h]));
    for (const command of ['codex', 'claude', 'hermes', 'openclaw', 'vibe']) {
      expect(byCommand.get(command)?.nativeStateDir, command).toMatch(/^\./);
      expect(byCommand.get(command)?.modelCatalogFiles?.length, command).toBeGreaterThan(0);
    }
    expect(byCommand.get('copilot')?.modelsDevCatalog).toBe(true);
    expect(byCommand.get('goose')?.modelsDevCatalog).toBe(true);
    expect(byCommand.get('hermes')?.effortHelpArgv).toEqual(['chat', '--help']);
  });
});
