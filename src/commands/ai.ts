/** Local ClikDeploy AI harness lifecycle, account aliases, and durable session settings. */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, open, readFile, stat, unlink, writeFile, type FileHandle } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { extname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { fileURLToPath } from 'node:url';
import type Conf from 'conf';
import chalk from 'chalk';
import { getApiKeyForUrl, getApiUrl } from './gateway-credentials.js';
import { gatewayLogin } from './gateway-login.js';
import { isAllowedLoopbackHost } from './control-api-host.js';
import { CLIKCODE_USER_AGENT, CLIKCODE_VERSION } from '../version.js';
import {
  gatewayHarnessFallbackNotice, gatewayHarnessUnavailable, runGatewayHarnessSessionTurn,
} from './ai-gateway-harness.js';
import { commonControlFor, optionIdsForControl, vendorFacingOptions } from './harness-options.js';
import { emitJson } from '../utils/structured-output.js';
import { isJsonDefaultMode } from '../utils/output-mode.js';
import { captureNativeHarness, captureNativeHarnessOutput, captureNativeHarnessTurn, createTurnIdleController, ensureNativeHarness, noteTurnActivityEvent, inspectNativeHarness, inspectNativeHarnessForPicker, loginNativeHarness, runNativeHarnessCommand } from './native-harness.js';
import { spawnPortable as spawn } from './spawn-portable.js';
import { classifyAccountFailure, failoverPrompt, INTERRUPTED_TURN_REQUEST, interruptedTurnFailoverPrompt, usageLabelIsExhausted, usageLabelRemainingPercent } from './ai-failover.js';
import { carryNativeSession } from './native-session-carry.js';
import { extractSessionTitle, normalizeSessionTitle, sessionTitleSource, StreamingTitle, withTitleRequest } from './session-title.js';
import {
  ADOPTED_TRANSCRIPT_READERS, discoverNativeSessions, FS_SESSION_DISCOVERY, mergeNativeTranscript, nativeGeneratedTitle, type DiscoveredNativeSession,
} from './native-session-discovery.js';
import type {
  AiHarnessAccount, AiHarnessOptionDefinition,
  AiHarnessPermissionMode, AiHarnessRoute, AiLocalHarnessDefinition,
  HarnessActivityEvent, HarnessDefaultSettings, HarnessPrompter, HarnessSession,
  HarnessState, PickerOption,
} from './types.js';
import type { HarnessAvailableCommand, HarnessPlanEntry } from './harness-turn-observer.js';
import {
  harnessIntegrationLevel, harnessSupportsEffort, harnessSupportsImages, harnessSupportsPermissionMode,
  localHarnessCapabilityManifest, localHarnessForCommand, localHarnessForProvider,
  nativeTurnResult, nativeTurnUsage, type NativeTurnResult,
  compactPath, nativeProfileEnvironment, renderActivityLine, sessionProviderLabel, streamLocalAiTurn,
} from './native-harness-protocol.js';
import {
  accountView, deviceManifest, harnessCommand, harnessStatePath, readState, resolveDefaultSettings, writeState,
} from './harness-state.js';
import {
  accountUsageLabel, cachedAccountUsageLabel, nativeModelCatalog, nativeModelCatalogForPicker, nativeModelLabel,
  nativeUsageReading, usageResetLabel, codexRateLimitsReading, recordDerivedUsage, recordNativeStreamUsage,
} from './native-account-data.js';
import {
  aiAccountAdd, aiAccountLogin, aiAccountLogout, aiAccountProviders, aiAccountRemove, aiAccountsList,
  aiAccountStatus, aiDoctor, announceBareInteractiveLogin, deriveAccountLabel, harnessNeedsLogin, syncAccountIdentityAfterLogin,
  setEmitHarnessOutput,
} from './account-management.js';
import {
  closePersistentTransport, createHandoffBranch, discardInterruptedTurn, DurableTurnCheckpoint,
  fallbackTurnHarnesses, interruptedTurnMessages, nameSession, nativeAvailableCommands,
  nextUsableFailoverAccount, persistentTransportFor, persistentTransports, preserveInterruptedTurn,
  sessionNativeCommands, synchronizeNativeTranscript, TRANSPORT_SESSIONS, turnEnvironment,
  type PersistentTransport, type TurnRunOptions,
} from './turn-runtime.js';
import { aiGatewaySessionSend, aiSessionSend } from './ai-turn.js';
import { TERMINAL, optionalTerminal } from './active-terminal.js';
import { emitHarnessOutput, line, renderSessionCard } from './harness-output.js';
import { TerminalHarnessPrompter, terminalUiSupported } from './terminal-ui.js';
import { createCodexSession, runCodexAppServerTurn, type CodexAppServerTurnInput, type CodexSession } from './codex-app-server.js';
import { createAcpSession, runAcpTurn, type AcpSession, type AcpTurnInput } from './acp-client.js';
import { harnessTurnTransport, type HarnessTurnTransport } from './harness-transport.js';
import {
  allLocalHarnesses, harnessAcpLaunch, harnessCanRunTurns, harnessTierRank, homeRedirectEnvironment, maxPromptArgvBytes,
  nativeHarnessTurnArgv, promptExceedsArgvLimit,
} from './harness-runtime.js';
import { reportStructuredLine } from './harness-structured-events.js';
import {
  copyToClipboard, decodeAttachmentPath, expandHomePath, osc52Sequence,
  prepareAttachments, queueAttachment, resolveStandaloneAttachment,
} from './session-attachments.js';
import {
  claimSession, markSessionLeftOpen, releaseSession, sessionClaimIsLive, SESSION_CLAIM_TTL_MS,
} from './session-claim.js';
import { localApiKey } from './ai-daemon.js';
import {
  accountPickerOptions, applyDefaultSetting, conversationIdFor, harnessCanAddAccount,
  hasConversationContent, integrationLabel, normalizeFailoverWord, optionForControl,
  optionForHarness, parseHarnessOption, providerAccountPickerOptions, providerPickerOptions,
  requiresProviderHandoff, sessionPickerOptions, setSessionHarnessOption,
  VALID_EFFORTS, VALID_PERMISSION_MODES,
  type ProviderAccountChoice, type ProviderChoice,
} from './session-options.js';
import { appServerThreadOverrides, declaredOptionArgv, normalizeTurnUsage, type NormalizedTurnUsage } from './transport-options.js';
import { existsSync } from 'node:fs';
import {
  routeSlashInput, slashControls, slashHelpText, slashPalette, unknownSlashMessage,
  type SlashExtras, type SlashHandlerKey, type SlashRouteContext,
} from './slash-registry.js';
import { customCommandPrompt, discoverCustomCommands, type CustomCommand } from './custom-commands.js';
import { LiveTurnInputBroker, type LiveTurnSubmission } from './live-turn-input.js';
import {
  beginPendingTurn, consumeSessionTurn, discardPendingTurn, enqueueSessionTurn, finishPendingTurn, recordPendingActivity, recordPendingSteer,
  sessionTranscriptMessages, updatePendingResponse,
} from './turn-checkpoint.js';
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

function applyFreshLocalSessionPolicy(state: HarnessState, session: HarnessSession): void {
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
      // Falls back to the placeholder if derivation finds nothing (most
      // harnesses currently), AND if the derived label would collide with
      // an account that already exists under a different provider (the
      // same real person's email showing up on two harnesses is entirely
      // possible and not a bug) -- labels must stay globally unique, and
      // the safe "X default" naming always is, by construction.
      const derived = await deriveAccountLabel(harness, undefined);
      const label = derived && !state.accounts.some((item) => item.label.toLowerCase() === derived.toLowerCase())
        ? derived : `${harness.displayName} default`;
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

export async function aiSessionCreate(options: { route: AiHarnessRoute; account?: string; provider?: string; model?: string; effort?: string; accountFailover?: 'never' | 'on-quota-exhausted' }): Promise<void> {
  if (options.route !== 'local' && options.route !== 'gateway') throw new Error('route must be local or gateway');
  if (options.route === 'gateway' && (options.account || options.provider || options.model || options.effort || options.accountFailover)) {
    throw new Error('Gateway account, provider, model, effort, and failover are selected by ClikDeploy platform routing and cannot be overridden per session.');
  }
  if (options.accountFailover !== undefined && options.accountFailover !== 'never' && options.accountFailover !== 'on-quota-exhausted') throw new Error('account failover must be never or on-quota-exhausted');
  const state = await readState();
  const account = options.account
    ? state.accounts.find((item) => item.id === options.account || item.label === options.account)
    : undefined;
  if (options.route === 'local' && options.account && !account) throw new Error(`local AI account "${options.account}" was not found`);
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

/** Shared slash-command grammar for a future TTY client and the headless CLI. */
export function sessionHarness(session: HarnessSession | undefined): AiLocalHarnessDefinition | undefined {
  return session?.route !== 'gateway' && session?.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
}

export function customCommandsFor(session: HarnessSession, harness: AiLocalHarnessDefinition | undefined): CustomCommand[] {
  if (session.route === 'gateway') return [];
  return discoverCustomCommands(harness, { workspace: session.workspace ?? process.cwd(), ...CUSTOM_COMMAND_ROOTS });
}
/** Test seam: redirect `~` and ClikCode's own command directories. */
export const CUSTOM_COMMAND_ROOTS: { home?: string; clikcodeDirs?: readonly string[] } = {};

export function slashExtrasFor(session: HarnessSession, harness: AiLocalHarnessDefinition | undefined): SlashExtras {
  const managers = harness ? localHarnessCapabilityManifest(harness).managers ?? {} : {};
  return {
    managers: Object.entries(managers).map(([name, manager]) => ({ name, label: manager?.label ?? name })),
    native: session.route === 'gateway' ? [] : sessionNativeCommands(session.id),
    custom: customCommandsFor(session, harness),
    harnesses: allLocalHarnesses().filter((item) => harnessCanRunTurns(item))
      .map((item, index) => ({ item, index })).sort((a, b) => harnessTierRank(a.item) - harnessTierRank(b.item) || a.index - b.index)
      .map(({ item }) => ({ command: item.command, displayName: item.displayName })),
  };
}

export function slashRouteContextFor(
  session: HarnessSession, harness: AiLocalHarnessDefinition | undefined, pathExists?: (path: string) => boolean,
): SlashRouteContext {
  const extras = slashExtrasFor(session, harness);
  return {
    ...(harness ? { harness } : {}),
    harnessCommands: (extras.harnesses ?? []).map((item) => item.command),
    managerNames: (extras.managers ?? []).map((item) => item.name),
    nativeCommands: (extras.native ?? []).map((item) => item.name.replace(/^\//, '').toLowerCase()),
    customCommands: (extras.custom ?? []).map((item) => item.name),
    ...(pathExists ? { pathExists } : {}),
  };
}

function captureProcess(command: string, args: readonly string[], cwd?: string, stdinText?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { cwd, stdio: [stdinText === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => { if (stdout.length < 1024 * 1024) stdout += chunk; });
    child.stderr!.on('data', (chunk: string) => { if (stderr.length < 16 * 1024) stderr += chunk; });
    if (stdinText !== undefined) child.stdin!.end(stdinText);
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `${command} exited ${code ?? 1}`)));
  });
}

/** Everything that differs from the last commit: staged and unstaged changes
 * against HEAD, plus files git does not track yet (which `git diff` never shows). */
async function workspaceDiff(workspace: string): Promise<string> {
  const git = (args: readonly string[]): Promise<string> => captureProcess('git', args, workspace);
  const hasHead = await git(['rev-parse', '--verify', '--quiet', 'HEAD']).then(() => true, () => false);
  // A repository with no commit yet has no HEAD: everything staged is the change.
  const base = hasHead ? ['diff', '--no-ext-diff', 'HEAD'] : ['diff', '--no-ext-diff', '--cached'];
  const [stat, details, untracked] = await Promise.all([
    git([...base, '--stat', '--', '.']), git([...base, '--', '.']),
    git(['ls-files', '--others', '--exclude-standard', '--', '.']).catch(() => ''),
  ]);
  const untrackedFiles = untracked.split(/\r?\n/).filter(Boolean);
  const sections = [
    stat.trim(), details.trim(),
    untrackedFiles.length ? `Untracked files (${untrackedFiles.length}):\n${untrackedFiles.slice(0, 200).map((file) => `  ${file}`).join('\n')}${untrackedFiles.length > 200 ? `\n  … ${untrackedFiles.length - 200} more` : ''}` : '',
  ].filter(Boolean);
  return sections.join('\n\n').slice(0, 512 * 1024);
}

export function capabilitiesText(session: HarnessSession): string {
  if (session.route === 'gateway') {
    return [
      'ClikDeploy Gateway capabilities',
      'Inference routing: platform managed',
      'Streaming: live SSE token deltas with bounded fallback chunking',
      'Tools: ClikDeploy capability registry and MCP bridge',
      'Permissions: authenticated server policy and confirmation gates',
      'Sessions: durable ClikCode transcript replay',
      'Models and effort: selected by Gateway routing policy',
    ].join('\n');
  }
  const harness = sessionHarness(session);
  if (!harness) throw new Error('Choose a provider first.');
  const manifest = localHarnessCapabilityManifest(harness);
  return [
    `${harness.displayName} capabilities`,
    ...manifest.options.map((option) => {
      const control = commonControlFor(option.id);
      return `${option.label}: ${option.description}${control ? ` (${control})` : ''}`;
    }),
    ...Object.entries(manifest.managers ?? {}).map(([name, manager]) => `${manager?.label ?? name}: available`),
    ...(manifest.features ?? []).map((feature) => `${feature}: native`),
  ].join('\n');
}

function memoryFileName(session: HarnessSession): string {
  return sessionHarness(session)?.memoryFile ?? 'AGENTS.md';
}

export function initPrompt(session: HarnessSession): string {
  const file = memoryFileName(session);
  return `Inspect this repository and create or improve ${file} with concise, accurate build, test, architecture, and contribution instructions for coding agents. Verify every command you include.`;
}

export function reviewPrompt(extra: string): string {
  return `Review the uncommitted changes in this workspace. Identify concrete bugs, regressions, security issues, and missing tests. Prioritize findings and cite file paths.${extra ? ` Additional focus: ${extra}` : ''}`;
}

export async function readMemoryFile(session: HarnessSession): Promise<{ path: string; content?: string }> {
  const path = join(session.workspace ?? process.cwd(), memoryFileName(session));
  try {
    return { path, content: (await readFile(path, 'utf8')).slice(0, 256 * 1024) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path };
    throw error;
  }
}

function undoUnavailableMessage(session: HarnessSession): string {
  const harness = sessionHarness(session);
  const who = session.route === 'gateway' ? 'ClikDeploy Gateway' : harness?.displayName ?? 'This provider';
  return `${who} does not expose an undo/rewind operation to ClikCode, so /undo is not available here. ClikCode will not fake it: use /diff to see what changed and git to revert it${harness?.nativeSlashPassthrough ? `, or send the vendor's own command with //rewind` : ''}.`;
}

function formatTokens(value: number | undefined): string {
  return value === undefined ? '—' : value.toLocaleString('en-US');
}

function contextUsageText(session: HarnessSession): string {
  const usage = session.lastUsage;
  const who = session.route === 'gateway' ? 'ClikDeploy Gateway' : sessionHarness(session)?.displayName ?? 'The provider';
  if (!usage) return `${who} has not reported token usage for this conversation yet. It appears here after a turn on a harness that publishes usage events.`;
  const used = usage.totalTokens ?? ((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) || undefined);
  const window = usage.contextWindow;
  return [
    `Context usage (as of ${usage.at})`,
    window && used !== undefined ? `  window     ${formatTokens(used)} / ${formatTokens(window)} tokens (${Math.min(100, Math.round((used / window) * 100))}%)` : `  window     not reported by ${who}`,
    `  input      ${formatTokens(usage.inputTokens)}`,
    `  cached     ${formatTokens(usage.cacheReadTokens)}`,
    `  output     ${formatTokens(usage.outputTokens)}`,
    `  total      ${formatTokens(used)}`,
    `  messages   ${sessionTranscriptMessages(session).length}`,
  ].join('\n');
}

function costReport(state: HarnessState, session: HarnessSession): { text: string; totals: { turns: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; costUsd: number; costKnown: boolean } } {
  const invocations = state.invocations.filter((item) => item.sessionId === session.id);
  const totals = invocations.reduce((sum, item) => ({
    turns: sum.turns + 1, inputTokens: sum.inputTokens + (item.inputTokens ?? 0), outputTokens: sum.outputTokens + (item.outputTokens ?? 0),
    cacheReadTokens: sum.cacheReadTokens + (item.cacheReadTokens ?? 0), costUsd: sum.costUsd + (item.costUsd ?? 0),
    costKnown: sum.costKnown || item.costUsd !== undefined,
  }), { turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0, costKnown: false });
  const text = invocations.length
    ? [
      'This conversation',
      `  turns      ${totals.turns}`,
      `  input      ${formatTokens(totals.inputTokens)} tokens`,
      `  cached     ${formatTokens(totals.cacheReadTokens)} tokens`,
      `  output     ${formatTokens(totals.outputTokens)} tokens`,
      `  cost       ${totals.costKnown ? `$${totals.costUsd.toFixed(4)}` : 'not reported (subscription plans and most vendor CLIs do not publish a price)'}`,
    ].join('\n')
    : 'No metered turns recorded for this conversation yet.';
  return { text, totals };
}

function transcriptMarkdown(session: HarnessSession): string {
  const title = session.name ?? `ClikCode conversation ${session.id.slice(0, 8)}`;
  const header = [
    `# ${title}`, '',
    `- Provider: ${sessionProviderLabel(session)}`,
    `- Model: ${session.model ?? 'provider default'}`,
    `- Workspace: ${session.workspace ?? process.cwd()}`,
    `- Exported: ${new Date().toISOString()}`, '',
  ];
  const body = sessionTranscriptMessages(session).flatMap((message) => [`## ${message.role === 'assistant' ? 'Assistant' : 'You'}`, '', message.content.trim(), '']);
  return `${[...header, ...body].join('\n').trimEnd()}\n`;
}

/** Never overwrites silently: `confirmOverwrite` decides (a prompt in the TUI,
 * `--force` headless). */
export async function exportTranscript(session: HarnessSession, target: string, confirmOverwrite: (path: string) => Promise<boolean>): Promise<string> {
  const workspace = session.workspace ?? process.cwd();
  const requested = expandHomePath(decodeAttachmentPath(target.trim() || `clikcode-${session.id.slice(0, 8)}.md`));
  const path = isAbsolute(requested) ? resolve(requested) : resolve(workspace, requested);
  const existing = await stat(path).catch(() => undefined);
  if (existing?.isDirectory()) throw new Error(`${compactPath(path)} is a directory; give a file name.`);
  if (existing && !await confirmOverwrite(path)) throw new Error(`${compactPath(path)} already exists; not overwritten. Choose another path${isJsonDefaultMode() ? ' or pass --force' : ''}.`);
  await writeFile(path, transcriptMarkdown(session), { encoding: 'utf8', mode: 0o600 });
  return path;
}

async function resolveExistingDirectory(session: HarnessSession, raw: string): Promise<string> {
  const expanded = expandHomePath(decodeAttachmentPath(raw));
  const path = isAbsolute(expanded) ? resolve(expanded) : resolve(session.workspace ?? process.cwd(), expanded);
  const info = await stat(path).catch(() => undefined);
  if (!info) throw new Error(`${compactPath(path)} does not exist.`);
  if (!info.isDirectory()) throw new Error(`${compactPath(path)} is not a directory.`);
  return path;
}

/** A native session belongs to the directory it was started in, so moving the
 * conversation drops it (the transcript is replayed into the next one) and
 * closes any live transport child, whose cwd is fixed at spawn. */
async function changeSessionWorkspace(state: HarnessState, session: HarnessSession, raw: string): Promise<string> {
  const path = await resolveExistingDirectory(session, raw);
  if (path === (session.workspace ?? process.cwd())) return `Already working in ${compactPath(path)}.`;
  const droppedNative = Boolean(session.nativeSessionId);
  session.workspace = path;
  session.nativeSessionId = undefined;
  session.nativeStartedAt = undefined;
  delete session.nativeSessionPreallocated;
  session.updatedAt = new Date().toISOString();
  await writeState(state);
  await closePersistentTransport(session.id);
  return `Working directory is now ${compactPath(path)}.${droppedNative ? ' The native session belonged to the previous directory, so the next turn starts a fresh one with this conversation replayed.' : ''}`;
}

/** Stored as the harness's own declared `add-dir` option, so every transport
 * renders it the way the catalog says. No declaration, no pretending. */
async function addSessionDirectory(state: HarnessState, session: HarnessSession, raw: string): Promise<string> {
  if (!raw.trim()) throw new Error('usage: /add-dir <dir>');
  const harness = sessionHarness(session);
  if (!harness) throw new Error('Choose a provider before adding directories.');
  const option = optionForControl(harness, '/add-dir');
  if (!option) throw new Error(`${harness.displayName} does not declare an additional-directory option; start ClikCode from a common parent directory or use /cwd instead.`);
  const path = await resolveExistingDirectory(session, raw);
  const current = session.harnessOptions?.[option.id];
  const existing = Array.isArray(current) ? current.map(String) : typeof current === 'string' && current ? [current] : [];
  if (existing.includes(path)) return `${compactPath(path)} is already available to ${harness.displayName}.`;
  session.harnessOptions = { ...session.harnessOptions, [option.id]: option.kind === 'path-list' || option.kind === 'string-list' ? [...existing, path] : path };
  session.updatedAt = new Date().toISOString();
  await writeState(state);
  // A live ACP child took its option argv at spawn.
  await closePersistentTransport(session.id);
  return `${harness.displayName} can now also work in ${compactPath(path)}.`;
}

const COMPACT_PROMPT = 'Summarize this conversation so far for a fresh session that will continue the work. Include: the goal, decisions made and why, files created or changed (with paths), commands that matter, the current state, and the concrete next steps. Be complete but concise. Output only the summary.';

/** `/compact`. A harness that runs slash commands itself compacts natively.
 * Otherwise ClikCode does it: one turn produces the summary, then a fresh
 * branch of the same conversation is seeded with only that summary -- with no
 * native session id, so its first turn replays the summary into a brand-new
 * vendor session. The full transcript stays on the original, resumable. */
export async function compactConversation(
  id: string, session: HarnessSession, focus: string, send: (id: string, prompt: string) => Promise<void>,
): Promise<string | void> {
  if (session.route === 'gateway') throw new Error('ClikDeploy Gateway manages its own context; /compact applies only to local harnesses.');
  if (!hasConversationContent(session)) throw new Error('There is nothing to compact yet.');
  const harness = sessionHarness(session);
  if (harness?.nativeSlashPassthrough && session.nativeSessionId) {
    await send(id, `/compact${focus ? ` ${focus}` : ''}`);
    return;
  }
  await send(id, `${COMPACT_PROMPT}${focus ? `\nPay particular attention to: ${focus}` : ''}`);
  const state = await readState();
  const source = state.sessions.find((item) => item.id === id);
  if (!source) throw new Error(`AI session "${id}" was not found`);
  const summary = [...sessionTranscriptMessages(source)].reverse().find((message) => message.role === 'assistant')?.content.trim();
  if (!summary) throw new Error('The provider returned no summary; the conversation was left as it was.');
  const compacted: HarnessSession = {
    ...newConversationSession(state, source),
    conversationId: conversationIdFor(source), parentSessionId: source.id,
    ...(source.name ? { name: source.name } : {}),
    ...(source.harnessOptions ? { harnessOptions: { ...source.harnessOptions } } : {}),
    messages: [
      { role: 'user', content: 'Summary of the conversation so far (compacted by ClikCode):' },
      { role: 'assistant', content: summary },
    ],
  };
  state.sessions.push(compacted);
  await writeState(state);
  await closePersistentTransport(id);
  return compacted.id;
}

export async function nativeManagerListing(state: HarnessState, session: HarnessSession, name: string): Promise<{ label: string; text: string }> {
  const harness = sessionHarness(session);
  if (!harness) throw new Error('Choose a provider first.');
  const manager = (localHarnessCapabilityManifest(harness).managers as Record<string, { label: string; listArgv?: readonly string[] } | undefined> | undefined)?.[name];
  if (!manager) throw new Error(`${harness.displayName} does not publish a ${name} manager.`);
  if (!manager.listArgv) throw new Error(`${harness.displayName} manages ${manager.label} only in its own interactive UI; open it from the interactive ClikCode session.`);
  const account = session.accountId ? state.accounts.find((item) => item.id === session.accountId) : undefined;
  const text = await captureNativeHarnessOutput(harness, manager.listArgv, turnEnvironment(harness, account), 15_000, session.workspace);
  return { label: manager.label, text: text.trim() || 'No entries.' };
}

/** What one slash command did, for a caller that must follow it. */
interface HeadlessSlashContext {
  id: string; state: HarnessState; session: HarnessSession;
  /** Canonical registry name (aliases already resolved). */
  head: string; args: string; words: string[];
}
/** Resolves with the resulting session id when the command moved the
 * conversation to another session (`/new`, a handoff), otherwise nothing. */
type HeadlessSlashHandler = (context: HeadlessSlashContext) => Promise<string | void>;

const INTERACTIVE_ONLY = (name: string): HeadlessSlashHandler => async () => {
  throw new Error(`/${name} opens a picker and is only available in the interactive ClikCode session.`);
};

/** Indirection so the interactive loop and tests can observe/replace the turn. */
export const SLASH_TURN = { send: (id: string, prompt: string): Promise<void> => aiSessionSend(id, prompt) };
const sendSessionTurn = (id: string, prompt: string): Promise<void> => SLASH_TURN.send(id, prompt);

/** Headless half of the slash registry. Typed by SlashHandlerKey, so a
 * registry entry without a handler here (or a handler without an entry) does
 * not compile; slash-registry.vitest.test.ts asserts the same at runtime. */
export const HEADLESS_SLASH_HANDLERS: Record<SlashHandlerKey, HeadlessSlashHandler> = {
  help: async ({ session }) => {
    const harness = sessionHarness(session);
    const extras = slashExtrasFor(session, harness);
    return emitHarnessOutput({ panel: 'help', helpText: slashHelpText(session, harness, extras), controls: slashControls() });
  },
  status: async ({ state, session }) => {
    const account = session.accountId ? state.accounts.find((item) => item.id === session.accountId)?.label : undefined;
    return emitHarnessOutput({ panel: 'settings', session, account });
  },
  new: async ({ state, session, args }) => {
    // `/reset` and `/clear` are aliases, not an in-place wipe. Clearing the
    // transcript on the existing record destroyed history with no confirmation.
    // A fresh conversation gives the same clean slate and keeps the previous
    // one resumable. Text after the command is the new conversation's first
    // turn, sent ON the new session -- it used to be dropped, leaving an orphan.
    const created = newConversationSession(state, session);
    state.sessions.push(created);
    await writeState(state);
    if (!args) emitHarnessOutput({ panel: 'conversation-reset', session: created });
    else await sendSessionTurn(created.id, args);
    return created.id;
  },
  permissions: async ({ state, session, words }) => {
    if (session.route === 'gateway') throw new Error('ClikDeploy Gateway permissions are enforced by authenticated platform policy; Ask, Bypass, and Auto apply only to local harnesses.');
    const value = words.shift()?.toLowerCase();
    const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
    if (!harness) throw new Error('Choose a provider before setting permissions.');
    if (!value) {
      const controls = VALID_PERMISSION_MODES.filter((mode) => harnessSupportsPermissionMode(harness, mode));
      if (!controls.length) throw new Error(`${harness.displayName} does not map ClikCode's permission modes to a real flag.`);
      return emitHarnessOutput({ panel: 'permissions', session, controls });
    }
    setSessionHarnessOption(session, harness, 'permissions', value);
    session.updatedAt = new Date().toISOString();
    await writeState(state);
    return emitHarnessOutput({ panel: 'settings', session, account: state.accounts.find((item) => item.id === session.accountId)?.label });
  },
  history: async ({ session }) => {
    return emitHarnessOutput({ panel: 'history', messages: sessionTranscriptMessages(session) });
  },
  copy: async ({ session }) => {
    const last = sessionTranscriptMessages(session).reverse().find((message) => message.role === 'assistant');
    if (!last) throw new Error('There is no assistant response to copy yet.');
    const via = await copyToClipboard(last.content);
    return emitHarnessOutput({ panel: 'copied', text: via === 'osc52' ? 'Last response sent to your terminal clipboard (OSC 52).' : 'Last response copied to the clipboard.' });
  },
  mention: async ({ state, session, words }) => {
    const action = words.join(' ').trim();
    if (!action) return emitHarnessOutput({ panel: 'attachments', attachments: session.attachments ?? [] });
    if (action === 'clear') {
      session.attachments = [];
    } else {
      const unquoted = decodeAttachmentPath(action);
      const workspace = session.workspace ?? process.cwd();
      const expanded = expandHomePath(unquoted);
      const path = isAbsolute(expanded) ? resolve(expanded) : resolve(workspace, expanded);
      await queueAttachment(session, path);
    }
    session.updatedAt = new Date().toISOString();
    await writeState(state);
    return emitHarnessOutput({ panel: 'attachments', attachments: session.attachments ?? [] });
  },
  diff: async ({ session }) => {
    return emitHarnessOutput({ panel: 'diff', diff: await workspaceDiff(session.workspace ?? process.cwd()) });
  },
  review: async ({ id, session, head, words }) => {
    // Gateway refusal lives in the registry's availability(), shared by both dispatchers.
    return sendSessionTurn(id, head === 'review' ? reviewPrompt(words.join(' ').trim()) : initPrompt(session));
  },
  rename: async ({ state, session, words }) => {
    const name = words.join(' ').trim();
    if (!name) throw new Error('Enter a name after /rename.');
    session.name = name.slice(0, 120);
    session.nameSource = 'user';
    session.updatedAt = new Date().toISOString();
    await writeState(state);
    return emitHarnessOutput({ panel: 'session-renamed', text: `Conversation renamed to “${session.name}”.` });
  },
  archive: async ({ state, session }) => {
    session.status = 'archived';
    session.closedAt = new Date().toISOString();
    session.updatedAt = session.closedAt;
    await writeState(state);
    return emitHarnessOutput({ panel: 'session-archived', text: 'Conversation archived.' });
  },
  delete: async ({ id, state, session, words }) => {
    if (words[0]?.toLowerCase() !== 'confirm') throw new Error('Use /delete confirm to permanently delete this ClikCode conversation. Provider-owned history is not deleted.');
    state.sessions = state.sessions.filter((item) => item.id !== id);
    await writeState(state);
    return emitHarnessOutput({ panel: 'session-deleted', text: 'Conversation deleted from ClikCode.' });
  },
  fork: async ({ id, state, session, words }) => {
    const now = new Date().toISOString();
    const fork: HarnessSession = {
      ...session, id: randomUUID(), name: words.join(' ').trim() || (session.name ? `${session.name} (fork)` : undefined),
      conversationId: conversationIdFor(session), parentSessionId: session.id,
      messages: sessionTranscriptMessages(session), pendingTurn: undefined,
      nativeSessionId: undefined, nativeStartedAt: undefined, createdAt: now, updatedAt: now, status: 'active', closedAt: undefined,
    };
    // A fork is a sibling concept, not another copy of the handoff event that
    // created its parent. Its parentSessionId is sufficient ancestry.
    delete fork.handoff;
    state.sessions.push(fork);
    await writeState(state);
    return emitHarnessOutput({ panel: 'session-forked', text: `Conversation forked as ${fork.id.slice(0, 8)}. Use /resume to open it.`, session: fork });
  },
  model: async ({ state, session, words }) => {
    const value = words.join(' ').trim();
    if (!value) throw new Error('Choose a model from /model or use /model <name>.');
    const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
    if (!harness?.modelArgvPrefix) throw new Error(`${harness?.displayName ?? 'This provider'} does not publish a model selector.`);
    session.model = value === 'default' || value === 'auto' ? null : value;
    session.updatedAt = new Date().toISOString();
    await writeState(state);
    return emitHarnessOutput({ panel: 'settings', session, account: state.accounts.find((item) => item.id === session.accountId)?.label });
  },
  effort: async ({ state, session, words }) => {
    const value = words.join(' ').trim().toLowerCase();
    const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
    if (!harness) throw new Error('Choose a provider before setting effort.');
    setSessionHarnessOption(session, harness, 'effort', value);
    session.updatedAt = new Date().toISOString();
    await writeState(state);
    return emitHarnessOutput({ panel: 'settings', session, account: state.accounts.find((item) => item.id === session.accountId)?.label });
  },
  account: async ({ id, words }) => {
    return aiSessionCommand(id, words.length ? `/accounts use ${words.join(' ')}` : '/accounts');
  },
  sessions: async ({ id, state, session, words }) => {
    const action = words.shift()?.toLowerCase();
    const targetId = words.shift();
    if (action === 'close') {
      if (!targetId) throw new Error('usage: /sessions close <id>');
      return aiSessionClose(targetId);
    }
    if (action === 'show' || action === 'open' || action === 'resume') {
      if (!targetId) throw new Error(`usage: /sessions ${action} <id>`);
      const target = state.sessions.find((item) => item.id === targetId);
      if (!target) throw new Error(`AI session "${targetId}" was not found`);
      return emitHarnessOutput({ panel: 'session', session: target, next: `${harnessCommand()} sessions open ${target.id}` });
    }
    if (action && action !== 'list' && action !== 'ls') throw new Error('usage: /sessions [list|show <id>|open <id>|close <id>]');
    return emitHarnessOutput({
      panel: 'sessions',
      sessions: state.sessions.map((item) => ({
        id: item.id, status: item.status, harness: item.nativeHarness, nativeSessionId: item.nativeSessionId,
        provider: item.provider, model: item.model, workspace: item.workspace, updatedAt: item.updatedAt,
      })),
      controls: ['sessions list', 'sessions open <id>', 'sessions close <id>'],
    });
  },
  models: async ({ state, session }) => {
    return emitHarnessOutput({
      panel: 'models',
      models: state.accounts.flatMap((account) => account.models.map((model) => ({ account: account.label, provider: account.provider, model }))),
      selected: session.model,
    });
  },
  usage: async ({ state, session }) => {
    const invocations = state.invocations.filter((invocation) => invocation.accountId === session.accountId || (session.route === 'gateway' && invocation.accountId === 'gateway'));
    return emitHarnessOutput({
      panel: 'usage', invocations,
      totals: invocations.reduce((total, invocation) => ({ calls: total.calls + 1, inputTokens: total.inputTokens + (invocation.inputTokens ?? 0), outputTokens: total.outputTokens + (invocation.outputTokens ?? 0) }), { calls: 0, inputTokens: 0, outputTokens: 0 }),
    });
  },
  settings: async ({ id, state, session, words }) => {
    const setting = words.shift()?.toLowerCase();
    const value = words.join(' ').trim();
    if (!setting) return emitHarnessOutput({ panel: 'settings', session, account: state.accounts.find((item) => item.id === session.accountId)?.label });
    if (setting === 'global') {
      const [key, ...rest] = words;
      if (!key || !rest.length) throw new Error('usage: /settings global <effort|permissions|failover> <value>');
      await aiSettingsSetGlobal(key, rest.join(' '), false);
      return emitHarnessOutput({ panel: 'settings-updated', text: `Global default updated: ${key} = ${rest.join(' ')}` });
    }
    if (setting === 'provider') {
      const [providerId, key, ...rest] = words;
      if (!providerId || !key) throw new Error('usage: /settings provider <id> <model|effort|permissions|failover> <value>, or /settings provider <id> clear');
      if (key.toLowerCase() === 'clear') {
        await aiSettingsClearProvider(providerId, false);
        return emitHarnessOutput({ panel: 'settings-updated', text: `Provider defaults cleared for ${providerId}` });
      }
      if (!rest.length) throw new Error('usage: /settings provider <id> <key> <value>');
      await aiSettingsSetProvider(providerId, key, rest.join(' '), false);
      return emitHarnessOutput({ panel: 'settings-updated', text: `${providerId} default updated: ${key} = ${rest.join(' ')}` });
    }
    if (!value) throw new Error(`usage: /settings ${setting} <value>`);
    if (setting === 'route') {
      if (value !== 'local' && value !== 'gateway') throw new Error('route must be local or gateway');
      if (value === 'gateway') applyGatewaySessionPolicy(session);
      else if (session.route === 'gateway') applyFreshLocalSessionPolicy(state, session);
      else session.route = 'local';
    } else if (setting === 'account') {
      const account = state.accounts.find((item) => item.id === value || item.label.toLowerCase() === value.toLowerCase());
      if (!account) throw new Error(`local AI account "${value}" was not found`);
      const leavingGateway = session.route === 'gateway';
      if (leavingGateway) applyFreshLocalSessionPolicy(state, session);
      const accountHarness = localHarnessForProvider(account.provider);
      if (accountHarness && harnessCanRunTurns(accountHarness) && session.nativeHarness !== accountHarness.command) {
        session.nativeHarness = accountHarness.command;
        session.nativeSessionId = undefined;
        session.nativeStartedAt = undefined;
      } else if (session.accountId !== account.id) {
        // A native thread id is only valid within the specific account's
        // own isolated profile it was created under -- switching to a
        // DIFFERENT account of the SAME provider left it untouched here,
        // even though it's now meaningless (points at a rollout file that
        // exists only under the old account's profile, not this one).
        // Confirmed live: this produced exactly "no rollout found for
        // thread id ..." on the next resume. Clearing it here means the
        // existing failoverPrompt rehydration path (which already handles
        // "no native thread yet, but real prior messages exist") takes
        // over on the next turn instead of failing outright.
        session.nativeSessionId = undefined;
        session.nativeStartedAt = undefined;
      }
      session.accountId = account.id;
      session.provider = account.provider;
      session.route = 'local';
      if (leavingGateway) {
        const defaults = resolveDefaultSettings(state, account.provider);
        session.model = state.providerSettings[account.provider]?.model ?? null;
        session.effort = defaults.effort;
        session.permissionMode = defaults.permissionMode;
        session.accountFailover = defaults.accountFailover;
      }
      account.quotaState = 'available';
      account.quotaRetryAt = undefined;
    } else if (setting === 'model') {
      const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
      if (!harness?.modelArgvPrefix) throw new Error(`${harness?.displayName ?? 'This provider'} does not publish a model selector.`);
      session.model = value === 'default' || value === 'auto' ? null : value;
    } else if (setting === 'effort') {
      const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
      if (!harness) throw new Error('Choose a provider before setting effort.');
      setSessionHarnessOption(session, harness, 'effort', value);
    } else if (setting === 'permissions' || setting === 'permission') {
      const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
      if (!harness) throw new Error('Choose a provider before setting permissions.');
      setSessionHarnessOption(session, harness, 'permissions', value);
    } else if (setting === 'option') {
      const [optionId, ...optionValue] = value.split(/\s+/);
      const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
      if (!harness || !optionId || !optionValue.length) throw new Error('usage: /settings option <id> <value>');
      setSessionHarnessOption(session, harness, optionId, optionValue.join(' '));
    } else if (setting === 'accountfailover' || setting === 'account-failover') {
      if (value !== 'never' && value !== 'on-quota-exhausted') throw new Error('account failover must be never or on-quota-exhausted');
      session.accountFailover = value;
    } else if (setting === 'native-session') {
      if (!session.nativeHarness) throw new Error('select a native harness before attaching its session id');
      const selectedHarness = localHarnessForCommand(session.nativeHarness);
      if (!selectedHarness?.session?.resumeIdPrefix) throw new Error(`${selectedHarness?.displayName ?? session.nativeHarness} does not support exact session resume`);
      session.nativeSessionId = value;
    } else {
      throw new Error(`unknown setting: ${setting}`);
    }
    session.updatedAt = new Date().toISOString();
    await writeState(state);
    return emitHarnessOutput({ panel: 'settings', session, account: state.accounts.find((item) => item.id === session.accountId)?.label });
  },
  accounts: async ({ id, state, session, words }) => {
    const action = words.shift()?.toLowerCase();
    if (action === 'use' || action === 'select') {
      const labelOrId = words.join(' ').trim();
      if (!labelOrId) throw new Error('usage: /accounts use <label-or-id>');
      const account = state.accounts.find((item) => item.id === labelOrId || item.label.toLowerCase() === labelOrId.toLowerCase());
      if (!account) throw new Error(`local AI account "${labelOrId}" was not found`);
      const leavingGateway = session.route === 'gateway';
      if (leavingGateway) applyFreshLocalSessionPolicy(state, session);
      if (session.nativeHarness) {
        const selectedHarness = localHarnessForCommand(session.nativeHarness);
        if (selectedHarness && selectedHarness.provider !== account.provider) throw new Error(`account "${account.label}" belongs to ${account.provider}; select /${localHarnessForProvider(account.provider)?.command ?? account.provider} first`);
      }
      const accountHarness = localHarnessForProvider(account.provider);
      if (accountHarness && harnessCanRunTurns(accountHarness) && session.nativeHarness !== accountHarness.command) {
        session.nativeHarness = accountHarness.command;
        session.nativeSessionId = undefined;
        session.nativeStartedAt = undefined;
      } else if (session.accountId !== account.id) {
        // A native thread id is only valid within the specific account's
        // own isolated profile it was created under -- switching to a
        // DIFFERENT account of the SAME provider left it untouched here,
        // even though it's now meaningless (points at a rollout file that
        // exists only under the old account's profile, not this one).
        // Confirmed live: this produced exactly "no rollout found for
        // thread id ..." on the next resume. Clearing it here means the
        // existing failoverPrompt rehydration path (which already handles
        // "no native thread yet, but real prior messages exist") takes
        // over on the next turn instead of failing outright.
        session.nativeSessionId = undefined;
        session.nativeStartedAt = undefined;
      }
      session.accountId = account.id;
      // Explicit selection is the user's retry signal for an account previously
      // marked exhausted. Automatic routing never guesses a reset time.
      account.quotaState = 'available';
      account.quotaRetryAt = undefined;
      session.provider = account.provider;
      session.route = 'local';
      if (leavingGateway) {
        const defaults = resolveDefaultSettings(state, account.provider);
        session.model = state.providerSettings[account.provider]?.model ?? null;
        session.effort = defaults.effort;
        session.permissionMode = defaults.permissionMode;
        session.accountFailover = defaults.accountFailover;
      }
      session.updatedAt = new Date().toISOString();
      await writeState(state);
      return emitHarnessOutput({ panel: 'accounts', selected: accountView(account), session });
    }
    if (action === 'login') {
      const harnessName = words.shift()?.toLowerCase();
      if (!harnessName) throw new Error('usage: /accounts login <harness> [label]');
      await aiAccountLogin(harnessName, words.join(' ') || undefined);
      return;
    }
    if (action === 'remove' || action === 'rm') {
      const labelOrId = words.join(' ').trim();
      if (!labelOrId) throw new Error('usage: /accounts remove <label-or-id>');
      return aiAccountRemove(labelOrId);
    }
    if (action === 'add') {
      const shortcut = words.shift()?.toLowerCase();
      const provider = shortcut ? (localHarnessForCommand(shortcut)?.provider ?? shortcut) : undefined;
      if (!provider) throw new Error('usage: /accounts add <harness>');
      const knownHarness = shortcut ? localHarnessForCommand(shortcut) : undefined;
      if (knownHarness?.surface === 'terminal') { await aiAccountLogin(knownHarness.command, words.join(' ') || undefined); return; }
      return emitHarnessOutput({ panel: 'add-account', provider, next: `${harnessCommand()} accounts add --provider ${provider} --label <label> --auth oauth|api-key|vendor-cli --credential-ref <local-reference>`, credentialBoundary: 'local-only' });
    }
    if (action === 'failover') {
      const setting = words.shift();
      if (setting !== 'auto' && setting !== 'never') throw new Error('usage: /accounts failover auto|never');
      session.accountFailover = setting === 'auto' ? 'on-quota-exhausted' : 'never';
      session.updatedAt = new Date().toISOString();
      await writeState(state);
      return emitHarnessOutput({ panel: 'accounts', session, accountFailover: session.accountFailover });
    }
    return emitHarnessOutput({ panel: 'accounts', session, accounts: state.accounts.map(accountView), controls: ['use <label-or-id>', 'login <harness> [label]', 'add <harness> [label]', 'remove <label-or-id>', 'failover auto|never'] });
  },
  gateway: async ({ state, session }) => {
    if (sessionTranscriptMessages(session).length || session.nativeSessionId) {
      throw new Error('Use the interactive /provider menu to hand off an existing conversation to ClikDeploy Gateway.');
    }
    applyGatewaySessionPolicy(session);
    session.updatedAt = new Date().toISOString();
    await writeState(state);
    return emitHarnessOutput({ panel: 'provider-selected', harness: 'gateway', displayName: 'ClikDeploy Gateway', provider: 'clikdeploy-gateway', account: null, model: 'platform', centralized: true });
  },
  attachments: (context) => HEADLESS_SLASH_HANDLERS.mention(context),
  init: (context) => HEADLESS_SLASH_HANDLERS.review(context),
  redraw: async () => emitHarnessOutput({ panel: 'redraw', text: 'Nothing to repaint outside the interactive session.' }),
  exit: async ({ id }) => aiSessionLeave(id),
  provider: INTERACTIVE_ONLY('provider'),
  resume: INTERACTIVE_ONLY('resume'),
  options: INTERACTIVE_ONLY('options'),
  capabilities: async ({ session }) => emitHarnessOutput({ panel: 'capabilities', text: capabilitiesText(session) }),
  native: async ({ id, session, args }) => {
    if (!args) throw new Error('usage: /native <text>  (or //text)');
    if (session.route === 'gateway') throw new Error('Native harness commands apply only to local harnesses.');
    await sendSessionTurn(id, args);
  },
  compact: async ({ id, session, args }) => compactConversation(id, session, args, sendSessionTurn),
  context: async ({ session }) => emitHarnessOutput({ panel: 'context', text: contextUsageText(session), usage: session.lastUsage ?? null }),
  cost: async ({ state, session }) => {
    const report = costReport(state, session);
    return emitHarnessOutput({ panel: 'cost', text: report.text, totals: report.totals });
  },
  export: async ({ session, words }) => {
    const force = words.includes('--force');
    const path = await exportTranscript(session, words.filter((word) => word !== '--force').join(' '), async () => force);
    return emitHarnessOutput({ panel: 'exported', text: `Transcript written to ${compactPath(path)}.`, path });
  },
  cwd: async ({ state, session, args }) => {
    if (!args) return emitHarnessOutput({ panel: 'cwd', text: compactPath(session.workspace ?? process.cwd()), workspace: session.workspace ?? process.cwd() });
    const notice = await changeSessionWorkspace(state, session, args);
    return emitHarnessOutput({ panel: 'cwd', text: notice, workspace: session.workspace });
  },
  'add-dir': async ({ state, session, args }) => emitHarnessOutput({ panel: 'add-dir', text: await addSessionDirectory(state, session, args) }),
  memory: async ({ session, words }) => {
    if (words[0]?.toLowerCase() === 'edit') throw new Error('/memory edit opens $EDITOR and is only available in the interactive ClikCode session.');
    const memory = await readMemoryFile(session);
    return emitHarnessOutput({ panel: 'memory', text: `${compactPath(memory.path)}\n\n${memory.content ?? '(not created yet — /init writes it)'}`, path: memory.path, exists: memory.content !== undefined });
  },
  doctor: async () => aiDoctor(),
  login: async ({ session }) => {
    const harness = sessionHarness(session);
    if (!harness) throw new Error('Choose a provider before signing in.');
    await aiAccountLogin(harness.command);
  },
  logout: async ({ state, session }) => {
    const account = session.accountId ? state.accounts.find((item) => item.id === session.accountId) : undefined;
    if (!account) throw new Error('This conversation has no account to sign out.');
    await aiAccountLogout(account.id);
  },
  undo: async ({ session }) => { throw new Error(undoUnavailableMessage(session)); },
};

export async function aiSessionCommand(id: string, input: string): Promise<string> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  const text = input.trim();
  if (!text.replace(/^\/+/, '')) throw new Error('slash command is required');
  const harness = sessionHarness(session);
  const route = routeSlashInput(text.startsWith('/') ? text : `/${text}`, slashRouteContextFor(session, harness));
  if (route.kind === 'command') {
    const availability = route.entry.availability(session, harness);
    if (!availability.available) throw new Error(availability.reason ?? `/${route.entry.name} is not available here.`);
    const moved = await HEADLESS_SLASH_HANDLERS[route.entry.handlerKey]({ id, state, session, head: route.entry.name, args: route.args, words: [...route.words] });
    return typeof moved === 'string' ? moved : id;
  }
  if (route.kind === 'harness') {
    // `/<harness> [request]`: a conversation with content hands off to a new
    // branch. The caller must follow the returned id -- the interactive loop
    // adopts it; the turn, if any, runs on THAT session.
    const targetId = requiresProviderHandoff(session, route.command)
      ? await newProviderConversation(id, route.command)
      : id;
    if (targetId === id) await aiHarnessSelect(route.command, targetId);
    if (route.args) await sendSessionTurn(targetId, route.args);
    return targetId;
  }
  if (route.kind === 'manager') {
    const listing = await nativeManagerListing(state, session, route.name);
    emitHarnessOutput({ panel: route.name, text: `${listing.label}\n\n${listing.text}` });
    return id;
  }
  if (route.kind === 'custom') {
    const command = customCommandsFor(session, harness).find((item) => item.name === route.name);
    if (!command) throw new Error(`custom command /${route.name} is no longer available`);
    await sendSessionTurn(id, customCommandPrompt(command, route.args, harness));
    return id;
  }
  if (route.kind === 'native') {
    if (session.route === 'gateway') throw new Error('Native harness commands apply only to local harnesses.');
    await sendSessionTurn(id, route.prompt);
    return id;
  }
  if (route.kind === 'unknown') throw new Error(unknownSlashMessage(route));
  throw new Error('slash command is required');
}

/** Maintenance actions are deliberately narrow label/value pairs rather than
 * nested PickerOptions. Non-destructive actions open with Tab; destructive
 * deleteAction values open only from Delete and are confirmed by select(). */




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
    : state.accounts.find((item) => item.id === options.account || item.label === options.account);
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
