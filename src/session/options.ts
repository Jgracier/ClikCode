/**
 * How a session and its harness are described and configured.
 *
 * Pure functions: what a conversation's identity is, what options a harness
 * accepts and how one is applied, and how sessions, providers and accounts
 * become rows in a picker. No I/O, no prompter, no turn.
 *
 * It is split out because two callers need exactly this and nothing else --
 * the turn loop and the interactive pickers -- and while it sat inside the
 * turn loop's file the pickers could not be lifted out without the two
 * importing each other.
 */
import chalk from 'chalk';
import { commonControlFor, optionIdsForControl } from '../harness/options.js';
import { harnessTierRank } from '../runtime/lazy-bridge.js';
import { nativeModelLabel } from '../harness/accounts/model-catalog.js';
import { sessionProviderLabel } from '../harness/protocol/labels.js';
import { harnessIntegrationLevel, harnessSupportsEffort, harnessSupportsPermissionMode, localHarnessCapabilityManifest } from '../runtime/lazy-bridge.js';
import type { AiHarnessAccount, AiHarnessOptionDefinition, AiHarnessPermissionMode, AiLocalHarnessDefinition } from '../harness/definition.js';
import type { PickerOption } from '../harness/prompter.js';
import type { HarnessDefaultSettings, HarnessSession } from './model.js';

/** Effort words every harness understands, narrowed per harness by
 * harnessSupportsEffort. */
export const VALID_EFFORTS = ['off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
export const VALID_PERMISSION_MODES: readonly AiHarnessPermissionMode[] = ['ask', 'bypass', 'auto'];

type ProviderChoice =
  | { kind: 'gateway' }
  | { kind: 'provider'; harness: string };

export type ProviderAccountChoice =
  | { kind: 'account'; harness: string; accountId: string }
  | { kind: 'add-account'; harness: string };

export function conversationIdFor(session: HarnessSession): string {
  return session.conversationId ?? session.id;
}

export function hasConversationContent(session: HarnessSession): boolean {
  return Boolean(session.nativeSessionId || session.pendingTurn || (session.messages ?? []).length > 0);
}

export function requiresProviderHandoff(session: HarnessSession, targetHarness: string): boolean {
  return hasConversationContent(session) && (session.route !== 'local' || session.nativeHarness !== targetHarness);
}

/** One row per ClikCode conversation. Provider-native hops stay available via
 * the row's Tab history instead of appearing as duplicate/fork rows. */
export function sessionPickerOptions(
  sessions: readonly HarnessSession[],
  currentId: string,
  providerLabel: (session: HarnessSession) => string = sessionProviderLabel,
): PickerOption<string>[] {
  const groups = new Map<string, HarnessSession[]>();
  for (const session of sessions) {
    const root = conversationIdFor(session);
    const group = groups.get(root) ?? [];
    group.push(session);
    groups.set(root, group);
  }
  const timestamp = (session: HarnessSession): number => {
    const value = Date.parse(session.updatedAt);
    return Number.isNaN(value) ? -Infinity : value;
  };
  const createdTimestamp = (session: HarnessSession): number => {
    const value = Date.parse(session.createdAt);
    return Number.isNaN(value) ? timestamp(session) : value;
  };
  const orderedGroups = [...groups.values()].sort((left, right) =>
    Math.max(...right.map(timestamp)) - Math.max(...left.map(timestamp)));

  return orderedGroups.map((group) => {
    const history = [...group].sort((left, right) => createdTimestamp(left) - createdTimestamp(right));
    const byId = new Map(history.map((session) => [session.id, session]));
    const depthFor = (session: HarnessSession): number => {
      let depth = 0;
      let parentId = session.parentSessionId;
      const seen = new Set<string>();
      while (parentId && byId.has(parentId) && !seen.has(parentId)) {
        seen.add(parentId);
        depth += 1;
        parentId = byId.get(parentId)?.parentSessionId;
      }
      return depth;
    };
    const active = group.filter((session) => session.status === 'active');
    const latest = [...(active.length ? active : group)].sort((left, right) => timestamp(right) - timestamp(left))[0]!;
    const title = latest.name?.replace(/\s+\(from [^)]+\)$/i, '').trim() || 'Untitled chat';
    const model = nativeModelLabel(latest.nativeHarness, latest.model);
    return {
      label: title,
      // The model segment is dropped entirely when there is no real one,
      // rather than printed as "default" -- see resolveNativeModel.
      detail: [
        `· ${providerLabel(latest)}${group.some((session) => session.id === currentId) ? ' · current' : ''}`,
        model, new Date(latest.updatedAt).toLocaleString(),
        ...(history.length > 1 ? [`Tab: ${history.length} history entries`] : []),
      ].filter(Boolean).join(' · '),
      value: latest.id,
      alternates: history.length > 1 ? history.map((session) => ({
        label: `${'  '.repeat(depthFor(session))}${providerLabel(session)} · ${!session.parentSessionId || !byId.has(session.parentSessionId) ? 'original' : session.handoff ? 'handed off' : 'fork'}${session.id === latest.id ? ' · latest' : ''} · ${new Date(session.updatedAt).toLocaleString()}`,
        value: session.id,
      })) : undefined,
    };
  });
}

/** An option by id, falling back to the other spellings of whatever control
 * owns that id. `--add-dir` and `--include-directories` are one concept, so
 * asking any harness for `add-dir` must find the one it actually publishes --
 * looking up the literal id is what made /add-dir refuse on Gemini and Qwen. */
export function optionForHarness(harness: AiLocalHarnessDefinition, id: string): AiHarnessOptionDefinition | undefined {
  const options = localHarnessCapabilityManifest(harness).options;
  const exact = options.find((option) => option.id === id);
  if (exact) return exact;
  const control = commonControlFor(id);
  if (!control) return undefined;
  const ids = optionIdsForControl(control);
  return options.find((option) => ids.includes(option.id));
}

/** The option a ClikCode command drives on THIS harness, whatever the vendor
 * spells it. */
export function optionForControl(
  harness: AiLocalHarnessDefinition, control: string,
): AiHarnessOptionDefinition | undefined {
  const ids = optionIdsForControl(control);
  return localHarnessCapabilityManifest(harness).options.find((option) => ids.includes(option.id));
}

export function parseHarnessOption(option: AiHarnessOptionDefinition, raw: string): unknown {
  const value = raw.trim();
  if (option.kind === 'boolean') {
    if (['true', 'on', 'yes', '1', 'enabled'].includes(value.toLowerCase())) return true;
    if (['false', 'off', 'no', '0', 'disabled'].includes(value.toLowerCase())) return false;
    throw new Error(`${option.label} must be on or off`);
  }
  if (option.kind === 'number') {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${option.label} must be a non-negative number`);
    return parsed;
  }
  if (option.kind === 'string-list' || option.kind === 'path-list') {
    const values = value.split(',').map((item) => item.trim()).filter(Boolean);
    if (!values.length) throw new Error(`${option.label} requires at least one value`);
    return values;
  }
  if (option.values?.length && !option.values.includes(value)) throw new Error(`${option.label} must be one of ${option.values.join(', ')}`);
  if (!value) throw new Error(`${option.label} cannot be empty`);
  return value;
}

export function setSessionHarnessOption(session: HarnessSession, harness: AiLocalHarnessDefinition, id: string, raw: string): void {
  const option = optionForHarness(harness, id);
  if (!option) throw new Error(`${harness.displayName} does not support option "${id}"`);
  const parsed = parseHarnessOption(option, raw);
  // Keyed by the option the harness actually publishes, never by the id the
  // caller asked for: a value stored under `add-dir` on a harness that spells
  // it `include-directories` is a value no turn ever reads.
  if (option.id === 'model') session.model = String(parsed);
  else if (option.id === 'effort') session.effort = String(parsed);
  else if (option.id === 'workspace') session.workspace = String(parsed);
  else if (option.id === 'permissions') session.permissionMode = String(parsed) as AiHarnessPermissionMode;
  else session.harnessOptions = { ...(session.harnessOptions ?? {}), [option.id]: parsed };
  if (option.requiresNewSession) {
    session.nativeSessionId = undefined;
    session.nativeStartedAt = undefined;
  }
}

export function normalizeFailoverWord(value: string): 'never' | 'on-quota-exhausted' {
  if (value === 'auto') return 'on-quota-exhausted';
  if (value === 'never') return 'never';
  throw new Error('failover must be auto or never');
}

/** 'auto' and 'default' mean "no explicit override" rather than being stored
 * as literal model ids -- no vendor CLI has a model named either word. Every
 * entry point that can set a model (slash commands, `/settings`, and the
 * `sessions create`/`sessions set` CLI flags) routes through this so they
 * can't drift out of sync on which words clear it.
 *
 * Returning null is a request to RESOLVE, not an instruction to store null.
 * Callers must follow it with resolveNativeModel(); a session persisted with
 * a null model is what used to surface in the UI as "automatic", and then as
 * "default" after that word was merely renamed. A session must always name a
 * model its harness really publishes. */
export function normalizeModelWord(value: string): string | null {
  return value === 'auto' || value === 'default' ? null : value;
}

/** Both `/settings global <key> <value>` and `/settings provider <id> <key> <value>`
 * write into the same three fields; this is the one place that validates a value
 * for a given key so the two entry points can't drift out of sync.
 *
 * `harness`, when given (the provider-scoped path only — a global default has
 * no single harness to check against), gates effort and permission mode on
 * what the catalog actually declares that vendor CLI supports. Without this,
 * a provider override could be accepted and then silently do nothing: the
 * turn-argv builder already only applies effort when `effortArgvPrefix` is
 * declared, and only applies permission mode when the harness's declared
 * `permissionModes` includes it. */
export function applyDefaultSetting(target: Partial<HarnessDefaultSettings & { model: string }>, key: string, value: string, harness?: AiLocalHarnessDefinition): void {
  const normalizedKey = key.toLowerCase();
  if (normalizedKey === 'effort') {
    if (harness && !harnessSupportsEffort(harness)) throw new Error(`${harness.displayName} does not publish a configurable reasoning-effort flag; setting one here would silently do nothing.`);
    if (!VALID_EFFORTS.includes(value as (typeof VALID_EFFORTS)[number])) throw new Error(`effort must be one of ${VALID_EFFORTS.join(', ')}`);
    target.effort = value;
  } else if (normalizedKey === 'permissions' || normalizedKey === 'permissionmode') {
    if (!VALID_PERMISSION_MODES.includes(value as AiHarnessPermissionMode)) throw new Error('permissions must be ask, bypass, or auto');
    if (harness && !harnessSupportsPermissionMode(harness, value as AiHarnessPermissionMode)) throw new Error(`${harness.displayName} does not map ClikCode's permission modes to a real flag; setting one here would silently do nothing.`);
    target.permissionMode = value as AiHarnessPermissionMode;
  } else if (normalizedKey === 'failover') {
    target.accountFailover = normalizeFailoverWord(value);
  } else if (normalizedKey === 'model' && 'model' in target) {
    target.model = normalizeModelWord(value) ?? undefined;
  } else {
    throw new Error(`unknown setting "${key}"; choose ${'model' in target ? 'model, ' : ''}effort, permissions, or failover`);
  }
}

export function integrationLabel(harness: AiLocalHarnessDefinition): string {
  return ({
    native: 'full integration',
    structured: 'structured integration',
    compatibility: 'basic compatibility',
    'editor-only': 'editor only',
  } as const)[harnessIntegrationLevel(harness)];
}

/** Keep the provider list deliberately sparse. Account switching belongs to
 * the composer shortcut and /account, not this provider-only menu. */
export function providerPickerOptions(
  available: ReadonlyArray<{ harness: AiLocalHarnessDefinition; inspection: { installed: boolean; version?: string } }>,
  session: HarnessSession,
  gatewayConnected: boolean,
  configuredProviders: ReadonlySet<string> = new Set(),
): PickerOption<ProviderChoice>[] {
  // Installed first, then the catalog's declared tier, then catalog order
  // (Array.prototype.sort is stable) -- never a hardcoded name ranking.
  const ordered = [...available].sort((left, right) => Number(right.inspection.installed) - Number(left.inspection.installed)
    || harnessTierRank(left.harness) - harnessTierRank(right.harness));
  // Every provider, in one list. Splitting it left the catalog's own entries
  // behind a "More providers…" row, so the answer to "what can I use?" was
  // two screens deep and looked like a shorter catalog than it is. Installed
  // ones still sort to the top, which is what the split was really for.
  const visible = ordered;
  return [{
    label: 'ClikDeploy Gateway',
    detail: `· ${gatewayConnected ? 'connected' : 'sign in with OAuth'}${session.route === 'gateway' ? ' · current' : ''}`,
    value: { kind: 'gateway' },
  }, ...visible.map(({ harness, inspection }) => ({
      label: harness.displayName,
      detail: `${inspection.installed
        ? `· installed${inspection.version ? ` ${inspection.version}` : ''}`
        : harness.npmPackage ? '· install when needed' : '· vendor install required'} · ${integrationLabel(harness)}${session.route === 'local' && session.nativeHarness === harness.command ? ' · current' : ''}`,
      value: { kind: 'provider' as const, harness: harness.command },
    })),
  ];
}

/** Whether the account menu can actually complete an add operation. */
function harnessCanAddAccount(harness: AiLocalHarnessDefinition): boolean {
  return harness.localAuth.includes('api-key') || Boolean(harness.loginArgv);
}

/** Account usage is loaded only after its provider is opened, avoiding a
 * wall of rows and avoiding quota probes for providers the user never views. */
function providerAccountPickerOptions(
  harness: AiLocalHarnessDefinition,
  accounts: ReadonlyArray<{ account: AiHarnessAccount; usage?: string; usagePending?: boolean }>,
  session: HarnessSession,
): PickerOption<ProviderAccountChoice>[] {
  return [
    ...[...accounts].sort((left, right) => left.account.label.localeCompare(right.account.label)).map(({ account, usage, usagePending }) => {
      const actions = [
        ...(harness.loginArgv && account.authKind === 'vendor-cli' && account.status !== 'ready'
          ? [{ label: 'Reauthenticate', value: 'reauthenticate' }] : []),
      ];
      const deleteAction = harness.logoutArgv && account.authKind === 'vendor-cli' && account.status === 'ready'
        ? { label: 'Disconnect', value: 'disconnect' }
        : { label: 'Remove', value: 'remove' };
      return {
        label: account.label,
        detail: `${usage ? `· ${usage} ` : usagePending ? '· checking usage… ' : '· usage unavailable '}${account.authKind === 'api-key' ? '· direct API ' : '· native CLI '}${account.status === 'needs_login' ? `· ${chalk.yellow('needs reauthentication')} ` : ''}${account.quotaState === 'exhausted' ? `· ${chalk.yellow('quota exhausted')} ` : ''}${account.id === session.accountId ? '· current' : ''}${actions.length ? ` ${chalk.dim('(Tab for options)')}` : ''}`.trim(),
        value: { kind: 'account' as const, harness: harness.command, accountId: account.id },
        actions,
        deleteAction,
      };
    }),
    ...(harnessCanAddAccount(harness)
      ? [{ label: '+ Add account…', detail: `· ${harness.displayName}`, value: { kind: 'add-account' as const, harness: harness.command } }]
      : []),
  ];
}

/** Composer account choices are scoped to the selected provider. */
export function accountPickerOptions(
  accounts: ReadonlyArray<{ account: AiHarnessAccount; usage?: string; usagePending?: boolean }>,
  session: HarnessSession,
  harness: AiLocalHarnessDefinition,
): PickerOption<ProviderAccountChoice>[] {
  // Every row the builder produces, including the trailing "+ Add account…".
  // Filtering to kind === 'account' here is what made that row unreachable:
  // it is the only way to connect a second login from inside /account, and
  // this is the only caller, so it was dead.
  return providerAccountPickerOptions(harness, accounts.filter(({ account }) => account.provider === harness.provider), session);
}