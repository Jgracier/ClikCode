/** Local ClikDeploy AI harness lifecycle, account aliases, and durable session settings. */

import type Conf from 'conf';
import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import chalk from 'chalk';
import { getApiKeyForUrl, getApiUrl } from '../gateway/credentials.js';
import { emitJson } from '../cli/structured-output.js';
import { ensureNativeHarness, inspectNativeHarness, loginNativeHarness } from '../harness/transport/native.js';
import type { AiHarnessAccount, AiHarnessPermissionMode, AiHarnessRoute, HarnessDefaultSettings, HarnessSession, HarnessState } from '../harness/types.js';
import { sessionProviderLabel } from '../harness/protocol/labels.js';
import { nativeProfileEnvironment } from '../harness/transport/profile-environment.js';
import { harnessSupportsPermissionMode, localHarnessForCommand, localHarnessForProvider } from '../runtime/lazy-bridge.js';
import { harnessCommand } from '../session/state/paths.js';
import { readState } from '../session/state/read.js';
import { resolveDefaultSettings } from '../session/state/settings.js';
import { accountView } from '../session/state/views.js';
import { writeState } from '../session/state/write.js';
import { nativeModelCatalog } from '../harness/account-data.js';
import { aiAccountAdd, aiAccountLogin, aiAccountLogout, aiAccountProviders, aiAccountRemove, aiAccountsList, aiAccountStatus, aiDoctor, announceBareInteractiveLogin, deriveAccountLabel, harnessNeedsLogin, syncAccountIdentityAfterLogin, setEmitHarnessOutput } from './account.js';
import { createHandoffBranch, synchronizeNativeTranscript } from '../turn/runtime.js';
import { TERMINAL } from '../tui/active-terminal.js';
import { emitHarnessOutput } from '../harness/output.js';
import { harnessCanRunTurns } from '../runtime/lazy-bridge.js';
import { markSessionLeftOpen } from '../session/claim.js';
import { applyDefaultSetting, optionForHarness, parseHarnessOption, requiresProviderHandoff, VALID_PERMISSION_MODES } from '../session/options.js';
import { consumeSessionTurn, sessionTranscriptMessages } from '../turn/checkpoint.js';

export {
  aiAccountAdd, aiAccountLogin, aiAccountLogout, aiAccountProviders, aiAccountRemove, aiAccountsList,
  aiAccountStatus, aiDoctor,
};


/** Gateway routing owns these fields as one policy unit. Keeping the mutation
 * centralized prevents route switches, slash settings, and headless setters
 * from leaving stale local harness/account controls attached to a remote
 * platform-managed session. */
export function applyGatewaySessionPolicy(session: HarnessSession): void {
  session.route = 'gateway';
  session.accountId = null;
  session.provider = 'clikdeploy-gateway';
  session.model = null;
  session.effort = 'platform-managed';
  session.accountFailover = 'never';
  session.gatewayConfirmed = true;
  delete session.permissionMode;
  delete session.nativeHarness;
  delete session.nativeSessionId;
  delete session.nativeStartedAt;
  delete session.harnessOptions;
}

export function applyFreshLocalSessionPolicy(state: HarnessState, session: HarnessSession): void {
  const defaults = resolveDefaultSettings(state, null);
  session.route = 'local';
  session.accountId = null;
  session.provider = null;
  session.model = null;
  session.effort = defaults.effort;
  session.permissionMode = defaults.permissionMode;
  session.accountFailover = defaults.accountFailover;
  delete session.gatewayConfirmed;
  delete session.nativeHarness;
  delete session.nativeSessionId;
  delete session.nativeStartedAt;
  delete session.harnessOptions;
}

setEmitHarnessOutput(emitHarnessOutput);


/** Select a provider while retaining ClikCode as the foreground UI. Installs
 * it first if needed, and — only inside the interactive terminal session,
 * where suspending the alt-screen for a vendor login prompt makes sense —
 * signs in if the vendor CLI reports (or a fresh install implies) that it
 * isn't authenticated yet. The goal: every harness either works immediately
 * or ClikCode gets you to "working" itself, instead of erroring and telling
 * you to go run something separately. */
export async function aiHarnessSelect(harnessCommandName: string, sessionId: string): Promise<void> {
  const harness = localHarnessForCommand(harnessCommandName);
  if (!harness) throw new Error(`unknown local harness: ${harnessCommandName}`);
  if (harness.surface !== 'terminal') throw new Error(`${harness.displayName} is editor-only and cannot run turns inside ClikCode.`);
  if (!harnessCanRunTurns(harness)) throw new Error(`${harness.displayName} does not publish a non-interactive turn contract (CLI or ACP) required by the centralized ClikCode UI.`);
  const freshInstall = !(await inspectNativeHarness(harness)).installed;
  if (freshInstall) {
    TERMINAL.active?.startWaiting(`installing ${harness.displayName}…`);
    try { await ensureNativeHarness(harness); } finally { TERMINAL.active?.stopWaiting(); }
  }
  const state = await readState();
  const session = state.sessions.find((item) => item.id === sessionId);
  if (!session) throw new Error(`AI session "${sessionId}" was not found`);
  const sameHarness = session.nativeHarness === harness.command;
  if (!sameHarness) {
    if (requiresProviderHandoff(session, harness.command)) {
      throw new Error(`Use /${harness.command} to hand off this ${sessionProviderLabel(session)} conversation. Native provider changes always create a new branch.`);
    }
    session.nativeSessionId = undefined;
    session.nativeStartedAt = undefined;
    session.model = null;
  }
  session.nativeHarness = harness.command;
  session.provider = harness.provider;
  session.route = 'local';
  session.workspace ??= process.cwd();
  const selected = session.accountId ? state.accounts.find((account) => account.id === session.accountId) : undefined;
  // Tracks whether the account below is being minted right now, not found
  // pre-existing -- needed because harnessNeedsLogin returns false
  // unconditionally for any harness with no statusArgv (Gemini, Antigravity,
  // Amp: nothing to scriptably ask "are you logged in?" at all), so a
  // brand-new placeholder account for one of those would otherwise be
  // marked 'ready' and never get a single chance at the login/suspend
  // handoff -- the real mechanism behind "Antigravity CLI does not publish
  // an isolated configuration-root contract" surfacing at /add-account
  // time instead: the placeholder had already silently claimed the one
  // available account slot for a harness with no profileEnv, with the user
  // never having had a real opportunity to authenticate it in the first
  // place.
  let accountJustCreated = false;
  if (!selected || selected.provider !== harness.provider || selected.status !== 'ready') {
    const accounts = state.accounts.filter((account) => account.provider === harness.provider && account.authKind === 'vendor-cli' && account.status === 'ready');
    if (accounts.length) {
      session.accountId = preferredAccountId(
        state, harness.provider, session.accountId, (account) => account.authKind === 'vendor-cli',
      );
    } else {
      accountJustCreated = true;
      // Same derivation addAccountForHarness uses after an explicit login,
      // applied here too so a session's very first auto-created account
      // shows a real identity from the start instead of the generic "X
      // default" placeholder this used unconditionally before -- which is
      // exactly what was confusing about accounts named "Claude Code
      // default"/"Codex default" etc. undefined profilePath is correct
      // here: this is always the harness's one default, unisolated profile,
      // never one under an isolated CLAUDE_CONFIG_DIR-style directory.
      // Falls back to the harness's own name if derivation finds nothing
      // (OpenCode, Hermes and Copilot keep no identity anywhere on disk --
      // checked), AND if the derived label would collide with
      // an account that already exists under a different provider (the
      // same real person's email showing up on two harnesses is entirely
      // possible and not a bug) -- labels must stay globally unique, and a
      // bare harness name always is, by construction. It used to be
      // "X default", which read as a placeholder row in /account rather than
      // as the one account that harness actually has.
      const derived = await deriveAccountLabel(harness, undefined);
      const label = derived && !state.accounts.some((item) => item.label.toLowerCase() === derived.toLowerCase())
        ? derived : harness.displayName;
      const account: AiHarnessAccount = {
        id: randomUUID(), provider: harness.provider, label, authKind: 'vendor-cli',
        models: [], status: 'ready', credentialRef: `native:${harness.binary}:default`,
      };
      state.accounts.push(account);
      session.accountId = account.id;
    }
  }
  let account = session.accountId ? state.accounts.find((item) => item.id === session.accountId) : undefined;
  if (TERMINAL.active && harness.loginArgv) {
    const environment = nativeProfileEnvironment(account?.nativeProfile);
    if (freshInstall || (accountJustCreated && !harness.statusArgv) || await harnessNeedsLogin(harness, environment)) {
      if (harness.loginCapturable) {
        TERMINAL.active.startWaiting(`signing in to ${harness.displayName}…`);
        try { await loginNativeHarness(harness, environment); } finally { TERMINAL.active.stopWaiting(); }
      } else {
        TERMINAL.active.activity(`${chalk.yellow('signing in to')} ${chalk.dim(harness.displayName)}`);
        await TERMINAL.active.suspend();
        try {
          announceBareInteractiveLogin(harness);
          await loginNativeHarness(harness, environment);
        } finally {
          TERMINAL.active.resume();
        }
      }
      // Same identity check /account's "add another account" flow uses --
      // a plain /provider login deserves the real dedup-by-identity logic,
      // not a weaker "only rename if it still looks like a placeholder"
      // check that misses re-authenticating as a genuinely different real
      // account entirely.
      if (account) {
        account = await syncAccountIdentityAfterLogin(harness, account, state);
        session.accountId = account.id;
      }
    }
  }
  if (!session.model) {
    const catalog = await nativeModelCatalog(harness, account);
    if (catalog.configured) session.model = catalog.configured;
  }
  session.updatedAt = new Date().toISOString();
  await writeState(state);
  const compatible = state.accounts.filter((account) => account.provider === harness.provider && account.status === 'ready');
  emitHarnessOutput({
    panel: 'provider-selected', harness: harness.command, displayName: harness.displayName, provider: harness.provider,
    account: state.accounts.find((account) => account.id === session.accountId)?.label ?? null,
    model: session.model ?? 'provider default', centralized: true,
    ...(session.accountId ? {} : { actionRequired: `Choose one with /accounts use <label>`, accounts: compatible.map(accountView) }),
  });
}

export async function aiModelsList(): Promise<void> {
  const state = await readState();
  emitJson({
    models: state.accounts.flatMap((account) => account.models.map((model) => ({
      accountId: account.id,
      account: account.label,
      provider: account.provider,
      model,
      status: account.status,
    }))),
  });
}

export async function aiUsage(): Promise<void> {
  const state = await readState();
  const totals = state.invocations.reduce(
    (sum, invocation) => ({
      calls: sum.calls + 1,
      inputTokens: sum.inputTokens + (invocation.inputTokens ?? 0),
      outputTokens: sum.outputTokens + (invocation.outputTokens ?? 0),
      latencyMs: sum.latencyMs + invocation.latencyMs,
    }),
    { calls: 0, inputTokens: 0, outputTokens: 0, latencyMs: 0 },
  );
  emitJson({ ...totals, avgLatencyMs: totals.calls ? Math.round(totals.latencyMs / totals.calls) : 0, invocations: state.invocations });
}

/** Reports the separate ClikDeploy OAuth/API-key gateway identity, never a BYO provider login. */
export async function aiGatewayStatus(config: Conf): Promise<void> {
  const apiUrl = getApiUrl(config);
  emitJson({
    route: 'gateway',
    connected: Boolean(getApiKeyForUrl(config, apiUrl)),
    apiUrl,
    authentication: 'clikdeploy-oauth-or-api-key',
    credentialBoundary: 'gateway-auth-only',
    hint: `Run \`${harnessCommand()} gateway login\` to connect ClikDeploy Gateway, or use \`${harnessCommand()} accounts add\` for a provider login that stays local.`,
  });
}








/** Read-only view of the defaults every new chat is built from. */
/** Applies to every provider that doesn't have its own override. */
export async function aiSettingsSetGlobal(key: string, value: string, emit = true): Promise<void> {
  const state = await readState();
  applyDefaultSetting(state.globalSettings, key, value);
  await writeState(state);
  if (emit) emitJson({ globalSettings: state.globalSettings });
}

/** Overrides the global default for one provider only; existing sessions are untouched. */
export async function aiSettingsSetProvider(providerOrHarness: string, key: string, value: string, emit = true): Promise<void> {
  const state = await readState();
  const harness = localHarnessForCommand(providerOrHarness) ?? localHarnessForProvider(providerOrHarness);
  if (!harness) throw new Error(`unknown provider "${providerOrHarness}"`);
  const entry: Partial<HarnessDefaultSettings & { model: string }> = { ...state.providerSettings[harness.provider] };
  applyDefaultSetting(entry, key, value, harness);
  state.providerSettings[harness.provider] = entry;
  await writeState(state);
  if (emit) emitJson({ provider: harness.provider, settings: entry });
}

/** Removes every override for one provider, falling back to the global defaults. */
export async function aiSettingsClearProvider(providerOrHarness: string, emit = true): Promise<void> {
  const state = await readState();
  const harness = localHarnessForCommand(providerOrHarness) ?? localHarnessForProvider(providerOrHarness);
  if (!harness) throw new Error(`unknown provider "${providerOrHarness}"`);
  delete state.providerSettings[harness.provider];
  await writeState(state);
  if (emit) emitJson({ provider: harness.provider, settings: {} });
}

/** Find an account by id, or by label within the provider being asked for.
 *
 * A label is only unique per provider: one person signs in to Claude, Codex
 * and Antigravity with the same email, and every one of those accounts is
 * called that email. Matching on label alone returned whichever happened to
 * be stored first, so `--provider antigravity --account me@example.com` could
 * bind an Antigravity session to the OpenAI account of the same name -- and
 * then report that provider's quota. Confirmed live: it surfaced as
 * "Usage Exhausted" on an Antigravity account that was working perfectly.
 *
 * An id always wins, and with no provider named the old behaviour stands. */
function findAccount(
  state: HarnessState, labelOrId: string, provider?: string | null,
): AiHarnessAccount | undefined {
  const byId = state.accounts.find((item) => item.id === labelOrId);
  if (byId) return byId;
  const sameLabel = state.accounts.filter((item) => item.label === labelOrId);
  return (provider ? sameLabel.find((item) => item.provider === provider) : undefined) ?? sameLabel[0];
}

export async function aiSessionCreate(options: { route: AiHarnessRoute; account?: string; provider?: string; model?: string; effort?: string; accountFailover?: 'never' | 'on-quota-exhausted' }): Promise<void> {
  if (options.route !== 'local' && options.route !== 'gateway') throw new Error('route must be local or gateway');
  if (options.route === 'gateway' && (options.account || options.provider || options.model || options.effort || options.accountFailover)) {
    throw new Error('Gateway account, provider, model, effort, and failover are selected by ClikDeploy platform routing and cannot be overridden per session.');
  }
  if (options.accountFailover !== undefined && options.accountFailover !== 'never' && options.accountFailover !== 'on-quota-exhausted') throw new Error('account failover must be never or on-quota-exhausted');
  const state = await readState();
  const account = options.account ? findAccount(state, options.account, options.provider) : undefined;
  if (options.route === 'local' && options.account && !account) throw new Error(`local AI account "${options.account}" was not found`);
  // The same guard aiSessionSet already applied. Without it, a label that
  // exists under several providers silently bound the session to the wrong
  // one instead of saying so.
  if (account && options.provider && options.provider !== account.provider) {
    throw new Error(`account "${account.label}" belongs to ${account.provider}, not ${options.provider}`);
  }
  const provider = options.provider ?? account?.provider ?? null;
  const harness = provider ? localHarnessForProvider(provider) : undefined;
  if (provider && !harness && options.route === 'local') throw new Error(`unknown local provider "${provider}"`);
  if (options.model && harness && !harness.modelArgvPrefix) throw new Error(`${harness.displayName} does not publish a model selector.`);
  if (options.effort && harness) {
    const effortOption = optionForHarness(harness, 'effort');
    if (!effortOption) throw new Error(`${harness.displayName} does not publish a configurable reasoning-effort flag.`);
    parseHarnessOption(effortOption, options.effort);
  }
  const defaults = resolveDefaultSettings(state, provider);
  const now = new Date().toISOString();
  const id = randomUUID();
  const session: HarnessSession = {
    id, conversationId: id, route: options.route, accountId: options.route === 'gateway' ? null : account?.id ?? null,
    provider: options.route === 'gateway' ? 'clikdeploy-gateway' : provider,
    model: options.route === 'gateway' ? null : options.model ?? (provider ? state.providerSettings[provider]?.model : undefined) ?? null,
    effort: options.route === 'gateway' ? 'platform-managed' : options.effort ?? defaults.effort,
    ...(options.route === 'local' ? { permissionMode: defaults.permissionMode } : {}),
    accountFailover: options.route === 'gateway' ? 'never' : options.accountFailover ?? defaults.accountFailover,
    ...(options.route === 'gateway' ? { gatewayConfirmed: true as const } : {}),
    createdAt: now, updatedAt: now, status: 'active',
  };
  state.sessions.push(session);
  await writeState(state);
  emitJson({ session });
}

export async function aiSessionsList(): Promise<void> {
  const state = await readState();
  emitJson({ sessions: state.sessions });
}


export function preferredAccountId(
  state: HarnessState, provider: string, current?: string | null,
  where: (account: AiHarnessAccount) => boolean = () => true,
): string | null {
  const ready = state.accounts.filter((account) => account.provider === provider && account.status === 'ready' && where(account));
  if (!ready.length) return null;
  if (current && ready.some((account) => account.id === current)) return current;
  const lastUsed = [...state.sessions]
    .filter((session) => session.accountId && ready.some((account) => account.id === session.accountId))
    .sort((left, right) => Date.parse(right.updatedAt ?? '') - Date.parse(left.updatedAt ?? ''))[0]?.accountId;
  return lastUsed ?? ready[0]!.id;
}

export function newConversationSession(
  state: HarnessState, source: HarnessSession, now = new Date().toISOString(),
): HarnessSession {
  const id = randomUUID();
  const defaults = resolveDefaultSettings(state, source.provider);
  return {
    id, conversationId: id, route: source.route,
    accountId: source.route === 'gateway' ? null : source.accountId ?? null,
    provider: source.provider, model: source.model ?? null,
    effort: source.effort ?? defaults.effort,
    ...(source.route === 'gateway' ? {} : { permissionMode: source.permissionMode ?? defaults.permissionMode }),
    accountFailover: source.accountFailover ?? defaults.accountFailover,
    workspace: source.workspace ?? process.cwd(),
    ...(source.nativeHarness ? { nativeHarness: source.nativeHarness } : {}),
    createdAt: now, updatedAt: now, status: 'active',
  };
}

/** Drop a queued turn that could not start, so a permanent failure cannot
 * replay forever at the head of the queue. */
export async function releaseQueuedTurn(id: string, queuedTurnId: string): Promise<void> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (session && consumeSessionTurn(session, queuedTurnId)) await writeState(state);
}

/** Starting a clean conversation leaves the previous one intact and resumable;
 * the caller switches to the returned id. */
export async function newConversation(currentId: string): Promise<string> {
  const state = await readState();
  const current = state.sessions.find((item) => item.id === currentId);
  if (!current) throw new Error(`AI session "${currentId}" was not found`);
  const created = newConversationSession(state, current);
  state.sessions.push(created);
  await writeState(state);
  return created.id;
}

export async function newProviderConversation(currentId: string, harnessCommandName: string): Promise<string> {
  const state = await readState();
  const current = state.sessions.find((item) => item.id === currentId);
  if (!current) throw new Error(`AI session "${currentId}" was not found`);
  const harness = localHarnessForCommand(harnessCommandName);
  if (!harness) throw new Error(`unknown local harness: ${harnessCommandName}`);
  if (current.route === 'local' && current.nativeHarness === harness.command) return current.id;
  // Refresh the source before freezing its portable ClikCode history into a
  // child branch. The source native session remains untouched after this.
  if (await synchronizeNativeTranscript(state, current)) await writeState(state);
  const defaults = resolveDefaultSettings(state, harness.provider);
  const now = new Date().toISOString();
  const sourceDisplayName = current.nativeHarness
    ? localHarnessForCommand(current.nativeHarness)?.displayName
    : sessionProviderLabel(current);
  const session = createHandoffBranch({
    source: current, target: harness, accountId: preferredAccountId(state, harness.provider),
    model: state.providerSettings[harness.provider]?.model ?? null, defaults, now, sourceDisplayName,
  });
  state.sessions.push(session);
  await writeState(state);
  await aiHarnessSelect(harnessCommandName, session.id);
  return session.id;
}

/** The very first launch on a machine, with nothing to carry forward. */
function firstEverSession(state: HarnessState, workspace: string, now: string): HarnessSession {
  const defaults = resolveDefaultSettings(state, null);
  const id = randomUUID();
  return {
    id, conversationId: id, route: 'local', accountId: null, provider: null, model: null,
    effort: defaults.effort, permissionMode: defaults.permissionMode,
    accountFailover: defaults.accountFailover, workspace,
    createdAt: now, updatedAt: now, status: 'active',
  };
}

/**
 * The conversation a bare `clikcode` opens. Always a new one: resuming a
 * specific chat is an explicit act -- `/resume`, or `sessions open <id>` --
 * never a side effect of opening a terminal. Picking up the most recent chat
 * meant two terminals opened in a row landed in the same conversation, and it
 * made "start working" and "reopen yesterday's thread" the same gesture.
 *
 * How you work carries over: provider, account, model, effort, permissions.
 * That is a preference, not a conversation. The workspace deliberately does
 * not -- a new conversation belongs to the directory it was launched from, not
 * to wherever the last one happened to run.
 */
export function launchSession(
  state: HarnessState, workspace: string, now = new Date().toISOString(),
): HarnessSession {
  const previous = [...state.sessions]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  return previous
    ? { ...newConversationSession(state, previous, now), workspace }
    : firstEverSession(state, workspace, now);
}

export async function aiSessionShow(id: string): Promise<void> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  emitJson({ session });
}

/** Close is centralized even when the selected native agent has already exited. */
export async function aiSessionClose(id: string): Promise<void> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  // A session that never received a single turn AND was never linked to a
  // real vendor conversation has nothing to resume — keeping it as "closed"
  // clutter buries real conversations under identical "Untitled chat" entries
  // every time the app is opened and exited without typing anything. Drop it
  // outright instead of accumulating it. A set nativeSessionId is kept even
  // with zero ClikCode-tracked messages: it may be adopted from, or linked
  // directly to, a vendor's own conversation that has real content ClikCode
  // just never routed a turn through. A session with nativeHarness set is
  // kept too, even message-less: explicitly choosing a native provider and
  // configuring its account is real, deliberate setup work, not an
  // accidental blank launch. nativeHarness is the reliable signal here
  // specifically because it is ONLY ever set by an explicit selection
  // (aiHarnessSelect, newProviderConversation) -- unlike `provider`,
  // `accountId`, and `route`, which aiSessionOpenDefault's own "create a
  // fresh default session" path silently carries forward from whatever
  // session came before, even when the user has configured nothing yet.
  // gatewayConfirmed is the same signal for the one route (Gateway) that
  // doesn't otherwise have a reliable "was this deliberate" field to check.
  if (!sessionTranscriptMessages(session).length && !session.nativeSessionId && !session.nativeHarness && !session.gatewayConfirmed) {
    state.sessions = state.sessions.filter((item) => item.id !== id);
    await writeState(state);
    return emitHarnessOutput({ panel: 'session-closed', sessionId: session.id, closed: true });
  }
  if (session.status !== 'closed') {
    session.status = 'closed';
    session.closedAt = new Date().toISOString();
    session.updatedAt = session.closedAt;
    await writeState(state);
  }
  emitHarnessOutput({ panel: 'session-closed', sessionId: session.id, closed: true });
}

/** Save-and-leave lifecycle used by /exit. This deliberately does not call
 * aiSessionClose: closing a terminal must not make startup fall back to an
 * older provider branch of the same conversation. */
export async function aiSessionLeave(id: string): Promise<void> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  markSessionLeftOpen(session, new Date().toISOString());
  await writeState(state);
}



export async function aiSessionSet(id: string, options: { route?: AiHarnessRoute; account?: string; provider?: string; model?: string; effort?: string; permissions?: AiHarnessPermissionMode; accountFailover?: 'never' | 'on-quota-exhausted'; nativeSession?: string }): Promise<void> {
  if (options.route !== undefined && options.route !== 'local' && options.route !== 'gateway') throw new Error('route must be local or gateway');
  if (options.accountFailover !== undefined && options.accountFailover !== 'never' && options.accountFailover !== 'on-quota-exhausted') throw new Error('account failover must be never or on-quota-exhausted');
  if (options.permissions !== undefined && !VALID_PERMISSION_MODES.includes(options.permissions)) throw new Error('permissions must be ask, bypass, or auto');
  const state = await readState();
  const index = state.sessions.findIndex((item) => item.id === id);
  if (index < 0) throw new Error(`AI session "${id}" was not found`);
  const current = state.sessions[index];
  const effectiveRoute = options.route ?? current.route;
  if (effectiveRoute === 'gateway' && (options.account || options.provider || options.model || options.effort || options.accountFailover || options.nativeSession)) {
    throw new Error('Gateway account, provider, model, effort, failover, and native sessions are selected by ClikDeploy platform routing and cannot be overridden per session.');
  }
  const account = options.account === undefined
    ? undefined
    : findAccount(state, options.account, options.provider ?? current.provider);
  if (options.account !== undefined && !account) throw new Error(`local AI account "${options.account}" was not found`);
  if (account && options.provider && options.provider !== account.provider) {
    throw new Error(`account "${account.label}" belongs to ${account.provider}, not ${options.provider}`);
  }
  if (!account && options.provider && current.accountId) {
    const currentAccount = state.accounts.find((item) => item.id === current.accountId);
    if (currentAccount && currentAccount.provider !== options.provider) {
      throw new Error(`account "${currentAccount.label}" belongs to ${currentAccount.provider}; select a matching account when changing provider`);
    }
  }
  if (options.nativeSession !== undefined) {
    if (!current.nativeHarness) throw new Error('launch a native harness for this ClikCode session before attaching its native session id');
    const harness = localHarnessForCommand(current.nativeHarness);
    if (!harness?.session?.resumeIdPrefix) throw new Error(`${harness?.displayName ?? current.nativeHarness} does not declare exact native-session resume support`);
    if (!options.nativeSession.trim()) throw new Error('native session id cannot be empty');
  }
  const selectedHarness = account
    ? localHarnessForProvider(account.provider)
    : options.provider
      ? localHarnessForProvider(options.provider)
      : current.nativeHarness ? localHarnessForCommand(current.nativeHarness) : undefined;
  if (effectiveRoute === 'local' && (options.account || options.provider) && !selectedHarness) {
    throw new Error(`unknown local provider "${options.provider ?? account?.provider}"`);
  }
  if (options.model && selectedHarness && !selectedHarness.modelArgvPrefix) {
    throw new Error(`${selectedHarness.displayName} does not publish a model selector.`);
  }
  if (options.effort && selectedHarness) {
    const effortOption = optionForHarness(selectedHarness, 'effort');
    if (!effortOption) throw new Error(`${selectedHarness.displayName} does not publish a configurable reasoning-effort flag.`);
    parseHarnessOption(effortOption, options.effort);
  }
  if (options.permissions && (!selectedHarness || !harnessSupportsPermissionMode(selectedHarness, options.permissions))) {
    if (!selectedHarness) throw new Error('Choose a provider before setting permissions.');
    throw new Error(`${selectedHarness.displayName} does not support ${options.permissions} permissions.`);
  }
  const base: HarnessSession = { ...current };
  if (options.route === 'local' && current.route === 'gateway') applyFreshLocalSessionPolicy(state, base);
  const next: HarnessSession = {
    ...base,
    ...(options.route ? { route: options.route } : {}),
    ...(account ? { accountId: account.id, provider: options.provider ?? account.provider } : {}),
    ...(options.provider ? { provider: options.provider } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.effort ? { effort: options.effort } : {}),
    ...(options.permissions ? { permissionMode: options.permissions } : {}),
    ...(options.accountFailover ? { accountFailover: options.accountFailover } : {}),
    ...(options.nativeSession !== undefined ? { nativeSessionId: options.nativeSession.trim() } : {}),
    updatedAt: new Date().toISOString(),
  };
  if (effectiveRoute === 'gateway') applyGatewaySessionPolicy(next);
  else if (account) {
    if (account.authKind === 'vendor-cli' && selectedHarness && harnessCanRunTurns(selectedHarness)) {
      if (next.nativeHarness !== selectedHarness.command || current.accountId !== account.id) {
        next.nativeSessionId = undefined;
        next.nativeStartedAt = undefined;
      }
      next.nativeHarness = selectedHarness.command;
    } else {
      delete next.nativeHarness;
      delete next.nativeSessionId;
      delete next.nativeStartedAt;
    }
  }
  state.sessions[index] = next;
  await writeState(state);
  emitJson({ session: next });
}
