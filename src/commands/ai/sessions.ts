/** `clikcode session`: creating, listing, showing, closing and leaving a
 * session, and the policy each kind of session starts with. */

import { isBlankConversation } from '../../session/options.js';
import { effortChoicesFor } from '../../harness/accounts/effort-choices.js';
import { randomUUID } from 'node:crypto';
import { emitJson } from '../../cli/structured-output.js';
import type { AiHarnessAccount, AiHarnessPermissionMode, AiHarnessRoute, AiLocalHarnessDefinition } from '../../harness/definition.js';
import type { HarnessSession, HarnessState } from '../../session/model.js';
import { nativeModelCatalog } from '../../harness/accounts/model-catalog.js';
import { harnessSupportsPermissionMode, localHarnessForCommand, localHarnessForProvider } from '../../runtime/lazy-bridge.js';
import { sessionIsLive } from '../../session/liveness.js';
import { pruneSessionClaims } from '../../session/claims.js';
import { readWorkerRecord } from '../../worker/registry.js';
import { readState } from '../../session/state/read.js';
import { resolveDefaultSettings } from '../../session/state/settings.js';
import { writeState } from '../../session/state/write.js';
import { setEmitHarnessOutput } from '../account.js';
import { emitHarnessOutput } from '../../harness/output.js';
import { harnessCanRunTurns } from '../../runtime/lazy-bridge.js';
import { normalizeModelWord, optionForHarness, parseHarnessOption, VALID_PERMISSION_MODES } from '../../session/options.js';
import { sessionTranscriptMessages } from '../../turn/checkpoint.js';
import { newConversationSession } from './conversations.js';

/** A model a user names on `sessions create`/`sessions set` must be one the
 * harness actually publishes -- the same catalog its own picker draws from
 * (nativeModelCatalog / harness.modelDiscoveryArgv) -- rather than any
 * free-text string being stored and only failing once a real turn spawns the
 * vendor CLI with it. Silent when the catalog itself is empty (discovery
 * failed or the harness has none): a real vendor outage or a harness with no
 * discovery command must not block setting a model that may well be valid. */
export async function assertRealModel(harness: AiLocalHarnessDefinition | undefined, account: AiHarnessAccount | undefined, model: string): Promise<void> {
  if (!harness) return;
  const catalog = await nativeModelCatalog(harness, account);
  if (catalog.models.length && !catalog.models.includes(model)) {
    throw new Error(`"${model}" is not a model ${harness.displayName} publishes. Choose one of: ${catalog.models.join(', ')}`);
  }
}

/** Gateway routing owns these fields as one policy unit. Keeping the mutation
 * centralized prevents route switches, slash settings, and headless setters
 * from leaving stale local harness/account controls attached to a remote
 * platform-managed session. */
export function applyGatewaySessionPolicy(session: HarnessSession): void {
  session.route = 'gateway';
  session.accountId = null;
  session.provider = 'gateway';
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
    throw new Error('ClikDeploy Gateway account, provider, model, effort, and failover are selected by platform routing and cannot be overridden per session.');
  }
  if (options.accountFailover !== undefined && options.accountFailover !== 'never' && options.accountFailover !== 'on-quota-exhausted') throw new Error('account failover must be never or on-quota-exhausted');
  // `--provider claude` means Claude Code, the same name /claude and
  // `accounts login claude` take; the provider id (`anthropic`) still works.
  const named = options.provider ? localHarnessForCommand(options.provider) : undefined;
  const state = await readState();
  const account = options.account ? findAccount(state, options.account, named?.provider ?? options.provider) : undefined;
  if (options.route === 'local' && options.account && !account) throw new Error(`local AI account "${options.account}" was not found`);
  // The same guard aiSessionSet already applied. Without it, a label that
  // exists under several providers silently bound the session to the wrong
  // one instead of saying so.
  if (account && options.provider && (named?.provider ?? options.provider) !== account.provider) {
    throw new Error(`account "${account.label}" belongs to ${account.provider}, not ${options.provider}`);
  }
  const provider = named?.provider ?? options.provider ?? account?.provider ?? null;
  const harness = provider ? localHarnessForProvider(provider) : undefined;
  if (provider && !harness && options.route === 'local') throw new Error(`unknown local provider "${provider}"`);
  const model = options.model === undefined ? undefined : normalizeModelWord(options.model);
  if (model && harness && !harness.modelArgvPrefix) throw new Error(`${harness.displayName} does not publish a model selector.`);
  if (model) await assertRealModel(harness, account, model);
  if (options.effort && harness) {
    const effortOption = optionForHarness(harness, 'effort');
    if (!effortOption) throw new Error(`${harness.displayName} does not publish a configurable reasoning-effort flag.`);
    const choices = (await effortChoicesFor(harness, account, model)).values;
    parseHarnessOption(choices.length ? { ...effortOption, values: choices } : effortOption, options.effort);
  }
  const defaults = resolveDefaultSettings(state, provider);
  const now = new Date().toISOString();
  const id = randomUUID();
  const session: HarnessSession = {
    id, conversationId: id, route: options.route, accountId: options.route === 'gateway' ? null : account?.id ?? null,
    provider: options.route === 'gateway' ? 'gateway' : provider,
    model: options.route === 'gateway' ? null : model ?? (provider ? state.providerSettings[provider]?.model : undefined) ?? null,
    effort: options.route === 'gateway' ? 'platform-managed' : options.effort ?? defaults.effort,
    ...(options.route === 'local' ? { permissionMode: defaults.permissionMode } : {}),
    accountFailover: options.route === 'gateway' ? 'never' : options.accountFailover ?? defaults.accountFailover,
    ...(options.route === 'gateway' ? { gatewayConfirmed: true as const } : {}),
    createdAt: now, updatedAt: now, status: 'active',
  };
  state.sessions.push(session);
  await writeState(state);
  // Bound to an account now, as the app binds one, so the next command can
  // send; without it every created chat failed "no account selected".
  if (options.route === 'local') await (await import('./harness.js')).ensureChatReady(id);
  emitJson({ session: (await readState()).sessions.find((item) => item.id === id) ?? session });
}

export async function aiSessionsList(): Promise<void> {
  const state = await readState();
  // `live` is computed here rather than read off the record, because nothing
  // stores it: a session is live when a claim or a worker says so, and both
  // expire on their own. This replaced a `status` the worker wrote and a sweep
  // that corrected it -- see session/liveness.ts for why caching it was the
  // bug rather than the sweep being in the wrong place.
  const workerIsLive = await liveWorkerSessions(state.sessions);
  // Blank chats are not listed: a launch that was closed without typing is
  // not a conversation anyone can go back to (session/blank.ts).
  const sessions = state.sessions.filter((session) => !isBlankConversation(session))
    .map((session) => ({ ...session, live: sessionIsLive(session, workerIsLive) }));
  // Claim FILES are the one thing that does need collecting: a killed process
  // cannot delete its own, and no amount of correct logic makes that untrue.
  // This is disk housekeeping, NOT state reconciliation -- a leftover claim
  // file has never made a session look live, because claimIsHeld judges the
  // heartbeat and the pid instead of trusting the file's existence.
  await pruneSessionClaims(new Set(state.sessions.map((session) => session.id))).catch(() => 0);
  emitJson({ sessions });
}

/** Which sessions still have a worker process behind them: one directory pass
 *  for the whole list, so every session is judged against one snapshot. */
async function liveWorkerSessions(
  sessions: readonly HarnessSession[],
): Promise<(sessionId: string) => boolean> {
  const live = new Set<string>();
  await Promise.all(sessions.map(async (session) => {
    const record = await readWorkerRecord(session.id).catch(() => undefined);
    if (!record) return;
    try {
      process.kill(record.pid, 0);
      live.add(session.id);
    } catch (error) {
      // EPERM means it exists and belongs to someone else, which still counts.
      if ((error as NodeJS.ErrnoException).code === 'EPERM') live.add(session.id);
    }
  }));
  return (sessionId: string) => live.has(sessionId);
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
  const recent = [...state.sessions].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const previous = recent.find((session) => session.route === 'local' && session.nativeHarness) ?? recent[0];
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


/** Ending a session, both ways it can end.
 *
 * Close and leave share the whole decision and differ only in the tail, so
 * they are one function: an EMPTY session is dropped either way (it has no
 * branch worth preserving, and /exit is how nearly every session ends -- that
 * is why blank "opened and did nothing" chats accumulated forever), while a
 * non-empty one is either marked closed or left open.
 *
 * Leaving deliberately does NOT close: closing a terminal must not make the
 * next startup fall back to an older provider branch of the same
 * conversation. Leaving touches the current branch so it stays the default
 * next launch, without changing its provider-owned session identity.
 */
async function endSession(id: string, intent: 'close' | 'leave'): Promise<void> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  const announce = (): void => {
    if (intent === 'close') emitHarnessOutput({ panel: 'session-closed', sessionId: session.id, closed: true });
  };
  // Never started: not kept, by the same rule /resume hides it by.
  if (isBlankConversation(session)) {
    state.sessions = state.sessions.filter((item) => item.id !== id);
    await writeState(state);
    return announce();
  }
  const now = new Date().toISOString();
  if (intent === 'close') {
    if (session.status !== 'closed') {
      session.status = 'closed';
      session.closedAt = now;
      session.updatedAt = now;
      await writeState(state);
    }
  } else {
    session.status = 'active';
    delete session.closedAt;
    session.updatedAt = now;
    await writeState(state);
  }
  announce();
}

/** Close is centralized even when the selected native agent has already exited. */
export const aiSessionClose = (id: string): Promise<void> => endSession(id, 'close');

/** Save-and-leave lifecycle used by /exit. */
export const aiSessionLeave = (id: string): Promise<void> => endSession(id, 'leave');

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
    throw new Error('ClikDeploy Gateway account, provider, model, effort, failover, and native sessions are selected by platform routing and cannot be overridden per session.');
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
  const model = options.model === undefined ? undefined : normalizeModelWord(options.model);
  if (model && selectedHarness && !selectedHarness.modelArgvPrefix) {
    throw new Error(`${selectedHarness.displayName} does not publish a model selector.`);
  }
  if (model) await assertRealModel(selectedHarness, account ?? state.accounts.find((item) => item.id === current.accountId), model);
  if (options.effort && selectedHarness) {
    const effortOption = optionForHarness(selectedHarness, 'effort');
    if (!effortOption) throw new Error(`${selectedHarness.displayName} does not publish a configurable reasoning-effort flag.`);
    const effortAccount = account ?? state.accounts.find((item) => item.id === current.accountId);
    const choices = (await effortChoicesFor(selectedHarness, effortAccount, model ?? current.model)).values;
    parseHarnessOption(choices.length ? { ...effortOption, values: choices } : effortOption, options.effort);
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
    ...(options.model !== undefined ? { model } : {}),
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
