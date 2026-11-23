/** The accounts service on this machine: each route's work done by the
 * code `clikcode accounts ...` and a chat turn already run -- the account
 * registry and its profiles, the vendor's own login on a sign-in screen of
 * the service's (service/logins.ts), and runSessionTurn pinned to one
 * account (service/turns.ts). Nothing here signs in or runs a turn itself. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type Conf from 'conf';
import { quiet, lifecycle } from '../runtime/lifecycle-log.js';
import { readState } from '../session/state/read.js';
import { writeState } from '../session/state/write.js';
import { deleteConversations } from '../session/state/deletions.js';
import { forceStoreSession, unforceStoreSession } from '../session/ephemeral.js';
import type { AiHarnessAccount } from '../harness/definition.js';
import type { HarnessSession, HarnessState } from '../session/model.js';
import { builtInHarnesses, harnessCanRunTurns, localHarnessForCommand, localHarnessForProvider } from '../runtime/lazy-bridge.js';
import { inspectNativeHarnessForPicker, ensureNativeHarness } from '../harness/transport/native/inspect.js';
import { withSignInScreen } from '../harness/transport/native/login.js';
import { accountUsageCanBeAsked, accountUsageReading } from '../harness/accounts/account-usage.js';
import { USAGE_RECHECK_MS, accountBackAt, accountCanTakeTurn, usageAskedAt } from '../harness/accounts/usage-reading.js';
import { accountSignedOutOnDisk, aiAccountRemove, aiAccountSignIn, checkAccountStatus } from '../commands/account.js';
import { withTurnMcpServers } from '../harness/transport/acp-mcp-servers.js';
import { classifyTurnFailure, refusalEndingReply } from '../turn/account-evidence.js';
import { sessionTranscriptMessages } from '../turn/checkpoint.js';
import { textTranscript } from '../turn/turn-activities.js';
import { CLIKCODE_COMMIT, CLIKCODE_VERSION } from '../version.js';
import { serviceAccountView, serviceProviders, type ServiceAccount } from './accounts.js';
import { LoginRegistry, type LoginDriver } from './logins.js';
import type { ServiceBackend } from './server.js';
import { DEFAULT_TURN_TIMEOUT_MS, EventObserver, errorReason, retryAfterSeconds, safeMessage, turnPrompt, type TurnEvent, type TurnRequest } from './turns.js';

/** The harness behind a provider id or a harness command, when ClikCode can sign in to it here. */
function signInHarness(provider: string) {
  const harness = localHarnessForCommand(provider) ?? localHarnessForProvider(provider);
  if (!harness || !harnessCanRunTurns(harness) || (harness.loginArgv === undefined && !harness.loginKeyCommand)) return undefined;
  return harness;
}

export const loginDriver: LoginDriver = {
  resolve: (provider) => signInHarness(provider),
  needsInstall: async (command) => {
    const harness = localHarnessForCommand(command);
    return Boolean(harness) && !(await inspectNativeHarnessForPicker(harness!)).installed;
  },
  install: async (command) => { await ensureNativeHarness(localHarnessForCommand(command)!); },
  signIn: async (command, options, screen) => {
    // Reconnect: the same sign-in, named for the account it is for. The
    // vendor's identity still decides (aiAccountSignIn): the same person
    // lands on that account, in a fresh profile its credential moves into.
    let label = options.label;
    if (options.accountId) {
      const existing = (await readState({ transcripts: [] })).accounts.find((account) => account.id === options.accountId);
      if (!existing) throw new Error('The account to reconnect was removed.');
      label = existing.label;
    }
    return withSignInScreen(screen, () => aiAccountSignIn(command, label));
  },
};

function vendorAccounts(state: HarnessState): AiHarnessAccount[] {
  return state.accounts.filter((account) => account.authKind === 'vendor-cli');
}

async function accountView(account: AiHarnessAccount, state: HarnessState): Promise<ServiceAccount> {
  const harness = localHarnessForProvider(account.provider);
  const reading = await accountUsageReading(account, state, { cachedOnly: true }).catch(quiet('service/backend'));
  return serviceAccountView(account, {
    ...(harness ? { harness: harness.command } : {}),
    signedOutOnDisk: await accountSignedOutOnDisk(account).catch(() => false),
    canTakeTurn: accountCanTakeTurn(account),
    ...(accountBackAt(account) ? { backAt: accountBackAt(account)! } : {}),
    ...(reading?.windows ? { windows: reading.windows } : {}),
    ...(reading?.label ? { usageLabel: reading.label } : {}),
  });
}

/** Asks each signed-in account's usage again when it is due, without waiting: the next list shows it. */
function refreshUsage(state: HarnessState, now = Date.now()): void {
  for (const account of vendorAccounts(state)) {
    if (account.status !== 'ready' || !accountUsageCanBeAsked(account) || now - usageAskedAt(account) < USAGE_RECHECK_MS) continue;
    void accountUsageReading(account, state).catch(quiet('service/backend'));
  }
}

export function machineBackend(config: Conf): ServiceBackend {
  return {
    version: CLIKCODE_VERSION,
    ...(CLIKCODE_COMMIT ? { commit: CLIKCODE_COMMIT } : {}),
    logins: new LoginRegistry(loginDriver),
    providers: async () => {
      const harnesses = builtInHarnesses();
      const installed = new Map(await Promise.all(harnesses.map(async (harness) => [harness.command, (await inspectNativeHarnessForPicker(harness).catch(() => ({ installed: false }))).installed] as const)));
      return serviceProviders(harnesses, harnessCanRunTurns, (harness) => installed.get(harness.command) === true);
    },
    accounts: async () => {
      const state = await readState({ transcripts: [] });
      refreshUsage(state);
      return Promise.all(vendorAccounts(state).map((account) => accountView(account, state)));
    },
    account: async (id) => {
      const state = await readState({ transcripts: [] });
      const account = vendorAccounts(state).find((item) => item.id === id);
      return account ? accountView(account, state) : undefined;
    },
    checkAccount: async (id) => {
      const before = vendorAccounts(await readState({ transcripts: [] })).find((item) => item.id === id);
      if (!before) return undefined;
      // A vendor with no status command and nothing on disk to read has no
      // check to run: the account is said as it stands.
      await checkAccountStatus(id).catch(quiet('service/backend'));
      const state = await readState({ transcripts: [] });
      const account = vendorAccounts(state).find((item) => item.id === id);
      return account ? accountView(account, state) : undefined;
    },
    removeAccount: async (id) => {
      const state = await readState({ transcripts: [] });
      if (!vendorAccounts(state).some((item) => item.id === id)) return false;
      await aiAccountRemove(id);
      return true;
    },
    runTurn: (request, emit, signal) => runServiceTurn(config, request, emit, signal),
  };
}

/** A conversation made for one service turn, on `account`, in a folder of its own. */
function turnSession(account: AiHarnessAccount, harness: { command: string; provider: string }, model: string | undefined, workspace: string): HarnessSession {
  const now = new Date().toISOString();
  const id = randomUUID();
  return {
    id, conversationId: id, route: 'local', accountId: account.id, provider: harness.provider, nativeHarness: harness.command,
    model: model ?? null, effort: '', permissionMode: 'bypass', workspace, name: 'ClikCode service turn', nameSource: 'user',
    createdAt: now, updatedAt: now, status: 'active',
  };
}

export async function runServiceTurn(config: Conf, request: TurnRequest, emit: (event: TurnEvent) => void, signal: AbortSignal): Promise<void> {
  const state = await readState({ transcripts: [] });
  const account = vendorAccounts(state).find((item) => item.id === request.accountId);
  if (!account) { emit({ type: 'error', reason: 'needs-login', message: 'No such account.' }); return; }
  const harness = localHarnessForProvider(account.provider);
  if (!harness || !harnessCanRunTurns(harness)) { emit({ type: 'error', reason: 'crashed', message: `${account.provider} cannot run turns here.` }); return; }
  if (account.status === 'needs_login' || await accountSignedOutOnDisk(account).catch(() => false)) {
    emit({ type: 'error', reason: 'needs-login', message: `${account.label} needs a sign-in.` });
    return;
  }
  if (account.verification) { emit({ type: 'error', reason: 'revoked', message: `${harness.displayName} will not serve ${account.label} until it is verified.` }); return; }

  const controller = new AbortController();
  const stop = (): void => controller.abort();
  signal.addEventListener('abort', stop, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, request.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS);
  const workspace = await mkdtemp(join(tmpdir(), 'clikcode-service-turn-'));
  const session = turnSession(account, harness, request.model, workspace);
  state.sessions.push(session);
  forceStoreSession(session.id);
  await writeState(state);
  const observer = new EventObserver(emit);
  lifecycle('service.turn.start', { harness: harness.command, account: account.id.slice(0, 8), session: session.id.slice(0, 8), ...(request.model ? { model: request.model } : {}) });
  try {
    const { runSessionTurn } = await import('../turn/session-turn.js');
    const servers = request.mcp ? [{ name: 'platform', transport: 'http' as const, url: request.mcp.url, headers: request.mcp.headers ?? {} }] : [];
    await withTurnMcpServers(servers, () => runSessionTurn(config, session.id, turnPrompt(request), controller.signal, { prompter: observer, pinnedAccount: true }));
    // A turn some transports answer without streaming it: the saved answer is the text.
    if (!observer.text) {
      const saved = (await readState({ transcripts: [session.id] })).sessions.find((item) => item.id === session.id);
      const answer = saved ? textTranscript(sessionTranscriptMessages(saved)).at(-1) : undefined;
      if (answer?.role === 'assistant' && answer.content) observer.response(answer.content, 'append');
    }
    // Claude can end an "answered" turn with the refusal of an account that just ran out.
    const refusal = refusalEndingReply(observer.text);
    if (refusal) {
      emit({ type: 'error', reason: 'limited', message: safeMessage(refusal), ...await retryAfter(account.id) });
      return;
    }
    observer.finish();
    lifecycle('service.turn.end', { session: session.id.slice(0, 8), outcome: 'done' });
  } catch (error) {
    if (signal.aborted && !timedOut) { lifecycle('service.turn.end', { session: session.id.slice(0, 8), outcome: 'caller left' }); return; }
    const reason = errorReason(error, classifyTurnFailure(error), { timedOut });
    lifecycle('service.turn.end', { session: session.id.slice(0, 8), outcome: reason });
    emit({
      type: 'error', reason,
      message: timedOut ? 'The turn ran past its time limit and was stopped.' : safeMessage(error),
      ...(reason === 'limited' ? await retryAfter(account.id) : {}),
    });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', stop);
    await forgetTurnSession(session.id);
    await rm(workspace, { recursive: true, force: true }).catch(quiet('service/backend'));
  }
}

/** When the account is back, as the refusal just recorded on it says. */
async function retryAfter(accountId: string): Promise<{ retryAfterSec?: number }> {
  const account = (await readState({ transcripts: [] }).catch(quiet('service/backend')))?.accounts.find((item) => item.id === accountId);
  const seconds = account ? retryAfterSeconds(accountBackAt(account)) : undefined;
  return seconds ? { retryAfterSec: seconds } : {};
}

/** The turn's conversation is not kept: the caller holds its own. */
async function forgetTurnSession(id: string): Promise<void> {
  try {
    const state = await readState({ transcripts: [] });
    deleteConversations(state, [id]);
    await writeState(state);
  } catch (error) {
    quiet('service/backend')(error);
  } finally {
    unforceStoreSession(id);
  }
}
