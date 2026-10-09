/** `clikcode harness`: choosing which harness a session runs on. */

import { forceStoreSession } from '../../session/ephemeral.js';
import type { HarnessPrompter } from '../../harness/prompter.js';
import { isClikCodeAgent } from '../../session/route.js';
import { randomUUID } from 'node:crypto';
import { ensureNativeHarness } from '../../harness/transport/native/inspect.js';
import { loginNativeHarness } from '../../harness/transport/native/login.js';
import type { AiHarnessAccount, AiHarnessPermissionMode, AiLocalHarnessDefinition } from '../../harness/definition.js';
import type { HarnessSession } from '../../session/model.js';
import { hermesTurboFitInstalled, installHermesTurboFit, registerHermesTurboFitProvider, restoreHermesPluginScan } from '../../harness/accounts/hermes-discovery.js';
import { sessionProviderLabel } from '../../harness/protocol/labels.js';
import { nativeProfileEnvironment } from '../../harness/transport/profile-environment.js';
import { localHarnessForCommand, localHarnessForProvider } from '../../runtime/lazy-bridge.js';
import { readState } from '../../session/state/read.js';
import { accountView } from '../../session/state/views.js';
import { writeState } from '../../session/state/write.js';
import { modelIdFromLabel, resolveNativeModel } from '../../harness/accounts/model-catalog.js';
import { harnessNeedsLogin, syncAccountIdentityAfterLogin, withSignIn } from '../account.js';
import { deriveAccountLabel, nameAccount } from '../../harness/accounts/labels.js';
import { TERMINAL } from '../../tui/active-terminal.js';
import { emitHarnessOutput } from '../../harness/output.js';
import { harnessCanRunTurns } from '../../runtime/lazy-bridge.js';
import { signedInAccountId } from './preferred-account.js';
import { hasAuthEvidence } from '../../harness/accounts/auth-files.js';
import { accountCanTakeTurn } from '../../harness/accounts/usage-reading.js';
import { turnBackendForAccount } from '../../turn/account-routing.js';
import { leaveProvider } from '../../session/native-thread.js';
import { harnessCommand } from '../../session/state/paths.js';

/** Select a provider while retaining ClikCode as the foreground UI. Installs
 * it first if needed, and — only inside the interactive terminal session,
 * where suspending the alt-screen for a vendor login prompt makes sense —
 * signs in if the vendor CLI reports (or a fresh install implies) that it
 * isn't authenticated yet. The goal: every harness either works immediately
 * or ClikCode gets you to "working" itself, instead of erroring and telling
 * you to go run something separately. */
export async function aiHarnessSelect(harnessCommandName: string, sessionId: string, options: { emit?: boolean; signIn?: boolean; prompter?: HarnessPrompter } = {}): Promise<void> {
  const harness = localHarnessForCommand(harnessCommandName);
  if (!harness) throw new Error(`unknown local harness: ${harnessCommandName}`);
  if (harness.surface !== 'terminal') throw new Error(`${harness.displayName} is editor-only and cannot run turns inside ClikCode.`);
  if (!harnessCanRunTurns(harness)) throw new Error(`${harness.displayName} does not publish a non-interactive turn contract (CLI or ACP) required by the centralized ClikCode UI.`);
  // Installed now, while the user watches it happen (install.ts shows it on
  // whatever surface this is), rather than as a surprise on the first turn.
  const freshInstall = await ensureNativeHarness(harness);
  const state = await readState({ transcripts: [sessionId] });
  const session = state.sessions.find((item) => item.id === sessionId);
  if (!session) throw new Error(`AI session "${sessionId}" was not found`);
  const sameHarness = session.nativeHarness === harness.command;
  if (!sameHarness) {
    leaveProvider(session);
    session.model = null;
  }
  session.nativeHarness = harness.command;
  session.provider = harness.provider;
  session.route = 'local';
  session.workspace ??= process.cwd();
  const selected = session.accountId ? state.accounts.find((account) => account.id === session.accountId) : undefined;
  const selectedUsable = selected?.provider === harness.provider
    && turnBackendForAccount(selected) === 'vendor' && accountCanTakeTurn(selected);
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
  if (!selectedUsable) {
    const accounts = state.accounts.filter((account) => account.provider === harness.provider && turnBackendForAccount(account) === 'vendor');
    // Signed in is what decides a login, not usable right now. An account out
    // of quota or waiting on the vendor's verification is still an account the
    // user has: it is chosen (the best one first), and its turn says why it
    // cannot run. Treating "none usable" as "none at all" prompted a sign-in
    // on every provider whose accounts were all spent -- Antigravity, Augment,
    // xAI here -- when the user had them and wanted to pick one.
    if (accounts.some((account) => account.status === 'ready')) {
      session.accountId = signedInAccountId(state, harness.provider, session.accountId, (account) => turnBackendForAccount(account) === 'vendor');
    } else if (accounts.length) {
      session.accountId = null;
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
      // checked). It used to be "X default", which read as a placeholder row
      // in /account rather than as the one account that harness actually has.
      const label = nameAccount(state.accounts, harness, await deriveAccountLabel(harness, undefined) ?? harness.displayName);
      const account: AiHarnessAccount = {
        id: randomUUID(), provider: harness.provider, label, authKind: 'vendor-cli',
        models: [], status: 'ready', credentialRef: `native:${harness.binary}:default`,
      };
      state.accounts.push(account);
      session.accountId = account.id;
    }
  }
  let account = session.accountId ? state.accounts.find((item) => item.id === session.accountId) : undefined;
  // `signIn: false` -- chosen without the user asking (opening ClikCode, a
  // command-line send): an account that needs a sign-in is marked so, and
  // its first turn signs in (vendor-turn.ts). Only a provider the user
  // picked signs in here.
  const signIn = options.signIn !== false;
  // Where a sign-in shows: the surface the user chose from (the VS Code
  // panel passes its own), else the terminal.
  const signer = options.prompter ?? TERMINAL.active;
  if (harness.loginArgv && (signer || !signIn)) {
    const environment = nativeProfileEnvironment(account?.nativeProfile);
    // Only when the provider has no signed-in account: none existed (the one
    // just made is a placeholder until the vendor says otherwise), or every
    // one it has is signed out. A fresh install of the CLI is a reason only
    // for the first of those -- reinstalling does not sign anyone out of the
    // accounts ClikCode keeps. Signing in on purpose is /login or /accounts.
    // A vendor that answers signed out (signInOptional) is never signed in
    // ahead of a turn: the vendor-turn signs in if one is refused.
    const shouldCheckLogin = !account
      || account.status !== 'ready'
      || (accountJustCreated && !harness.signInOptional && (freshInstall
        || (!harness.statusArgv && !hasAuthEvidence(harness))
        || await harnessNeedsLogin(harness, environment)));
    if (shouldCheckLogin && !signIn) {
      account ??= state.accounts.find((item) => item.provider === harness.provider && turnBackendForAccount(item) === 'vendor');
      if (account) {
        if (account.status === 'ready') account.status = 'needs_login';
        session.accountId = account.id;
      }
    } else if (shouldCheckLogin && signer) {
      await withSignIn(signer, harness.displayName, () => loginNativeHarness(harness, environment));
      // Same identity check /account's "add another account" flow uses --
      // a plain /provider login deserves the real dedup-by-identity logic,
      // not a weaker "only rename if it still looks like a placeholder"
      // check that misses re-authenticating as a genuinely different real
      // account entirely. A provider whose every account was signed out has
      // no accountId yet; the login still belongs to one of those accounts.
      if (!account) account = state.accounts.find((item) => item.provider === harness.provider);
      if (account) {
        account = await syncAccountIdentityAfterLogin(harness, account, state);
        session.accountId = account.id;
      }
    }
  }
  if (!session.accountId && state.accounts.some((item) => item.provider === harness.provider)) {
    throw new Error(`${harness.displayName} is not signed in. Run \`${harnessCommand()} accounts login ${harness.command}\`.`);
  }
  if (harness.turboFit) await ensureHermesTurboFit(harness, nativeProfileEnvironment(account?.nativeProfile));
  // Always a real model, never a placeholder -- see resolveNativeModel.
  if (!session.model) {
    const lastUsedModel = [...state.sessions]
      .filter((item) => item.id !== session.id && item.nativeHarness === harness.command && item.model)
      .sort((left, right) => Date.parse(right.updatedAt ?? '') - Date.parse(left.updatedAt ?? ''))[0]?.model;
    session.model = lastUsedModel ?? state.providerSettings[harness.provider]?.model
      ?? await resolveNativeModel(harness, account)
      ?? null;
  }
  session.updatedAt = new Date().toISOString();
  await writeState(state);
  // A caller that reports the session itself (sessions create, send) says
  // so; one JSON document per command.
  if (options.emit === false) return;
  const compatible = state.accounts.filter((account) => account.provider === harness.provider && account.status === 'ready');
  emitHarnessOutput({
    panel: 'provider-selected', harness: harness.command, displayName: harness.displayName, provider: harness.provider,
    account: state.accounts.find((account) => account.id === session.accountId)?.label ?? null,
    model: session.model ?? 'provider default', centralized: true,
    ...(session.accountId ? {} : { actionRequired: `Choose one with /accounts use <label>`, accounts: compatible.map(accountView) }),
  });
}

/** TurboFit is Hermes' local-model provider: its modes and hardware-fit
 * recommendations are what /model lists under Hermes. Choosing Hermes is the
 * whole decision -- it is installed with Hermes, no second question. Tried
 * once per run, so an install that fails (offline, say) is reported once
 * rather than on every /hermes. */
let turboFitTried = false;
async function ensureHermesTurboFit(harness: AiLocalHarnessDefinition, environment: Readonly<Record<string, string>>): Promise<void> {
  if (turboFitTried) return;
  turboFitTried = true;
  // A run killed mid-install left Hermes' scan setting changed; put it back
  // whether or not TurboFit needs installing now.
  await restoreHermesPluginScan(harness, environment).catch(() => undefined);
  const installed = await hermesTurboFitInstalled(environment);
  TERMINAL.active?.startWaiting(installed ? 'connecting TurboFit to Hermes…' : 'installing TurboFit local models for Hermes…');
  try {
    if (!installed) await installHermesTurboFit(harness, environment);
    await registerHermesTurboFitProvider(harness, environment);
  }
  catch (error) { emitHarnessOutput({ panel: 'error', message: error instanceof Error ? error.message : String(error) }); }
  finally { TERMINAL.active?.stopWaiting(); }
}

/** About to send on a chat whose provider has no signed-in account (marked
 * by a pick nobody asked for -- opening ClikCode): sign in now, the way an
 * explicit pick does; true when it did. A no-op for anything else. */
export async function signInBeforeUse(id: string): Promise<boolean> {
  const state = await readState({ transcripts: [] });
  const session = state.sessions.find((item) => item.id === id);
  if (!session?.nativeHarness || session.route !== 'local') return false;
  const account = session.accountId ? state.accounts.find((item) => item.id === session.accountId) : undefined;
  if (account?.status !== 'needs_login') return false;
  await aiHarnessSelect(session.nativeHarness, id, { emit: false });
  return true;
}

/** A chat ready for a turn from the command line: bound to a harness and an
 * account the way the app binds one on launch -- its provider's, else the
 * installed harness the user is signed in to. Used by `sessions send`,
 * `send` and `sessions create`, which each failed with "no account selected"
 * until a separate `accounts add` and `sessions set`. */
export async function ensureChatReady(id: string): Promise<void> {
  const state = await readState({ transcripts: [] });
  const session = state.sessions.find((item) => item.id === id);
  // ClikCode's own agent has no vendor harness or account to bind.
  if (!session || isClikCodeAgent(session) || session.accountId) return;
  const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness)
    : session.provider ? localHarnessForProvider(session.provider) : undefined;
  if (harness) return aiHarnessSelect(harness.command, id, { emit: false, signIn: false });
  const { autoSelectSessionHarness } = await import('../../tui/pickers/engine.js');
  if (!await autoSelectSessionHarness(id)) throw new Error('no harness is installed -- install one, e.g. npm i -g @anthropic-ai/claude-code');
}

/** A chat named on the command line: its id, the start of one, its name, or
 * `last`. */
export async function resolveChat(ref: string): Promise<string> {
  const state = await readState({ transcripts: [] });
  if (state.sessions.some((item) => item.id === ref)) return ref;
  const { chatNamed } = await import('../../session/options.js');
  const id = chatNamed(state.sessions, ref, '');
  if (!id) throw new Error(`no chat matches "${ref}" -- use its name, the start of its id, or last`);
  return id;
}

/** `clikcode send`: the chat to send in, ready for a turn. */
export async function startOrResumeChat(options: { harness?: string; chat?: string; model?: string; permissions?: string }): Promise<string> {
  // `--harness clikcode-local` (or `gateway`) names a route that runs
  // ClikCode's own agent rather than a vendor harness; a script reaching for
  // "the local model" should not have to learn sessions create/set/send.
  if (options.harness === 'clikcode-local' || options.harness === 'gateway') return startOrResumeAgentChat({ ...options, route: options.harness });
  let id: string;
  if (options.chat) id = await resolveChat(options.chat);
  else {
    const { launchSession } = await import('./sessions.js');
    const state = await readState({ transcripts: [] });
    const session = launchSession(state, process.cwd());
    state.sessions.push(session);
    // On disk before the worker is asked for it: a draft held only in this
    // process's memory is a chat the worker cannot find -- it exited "not
    // found" and the turn quietly ran here instead, owning nothing after exit.
    forceStoreSession(session.id);
    await writeState(state);
    id = session.id;
  }
  if (options.harness) {
    const harness = localHarnessForCommand(options.harness) ?? localHarnessForProvider(options.harness);
    if (!harness) throw new Error(`unknown harness "${options.harness}"`);
    const state = await readState({ transcripts: [] });
    const session = state.sessions.find((item) => item.id === id);
    if (session?.nativeHarness !== harness.command) {
      // A chat with history moves there with what it carries; a new one
      // simply runs there.
      const { moveToProvider } = await import('./conversations.js');
      if (options.chat) await moveToProvider(id, harness.command);
      else await aiHarnessSelect(harness.command, id, { emit: false });
    }
  }
  await ensureChatReady(id);
  if (options.permissions) await setChatPermissions(id, options.permissions);
  if (options.model) {
    const state = await readState({ transcripts: [id] });
    const session = state.sessions.find((item) => item.id === id);
    const harness = session?.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
    if (session && harness) {
      // Typed as the lists show it; no catalog is consulted here.
      session.model = modelIdFromLabel(harness, [], options.model);
      await writeState(state);
    }
  }
  return id;
}

/** `send --permissions`: the approval mode for this chat, checked against
 * what its agent can actually honour -- a mode the provider cannot carry to
 * a real flag is refused rather than stored and silently ignored. */
async function setChatPermissions(id: string, mode: string): Promise<void> {
  const { sessionPermissionModes, setSessionHarnessOption } = await import('../../session/options.js');
  const state = await readState({ transcripts: [id] });
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  const harness = !isClikCodeAgent(session) && session.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
  const supported = sessionPermissionModes(session, harness);
  if (!supported.includes(mode as AiHarnessPermissionMode)) {
    throw new Error(`${sessionProviderLabel(session)} supports ${supported.join(', ') || 'no'} permission modes, not ${mode}`);
  }
  // The same write /permissions makes: a vendor harness carries the mode
  // as its own option, ClikCode's agent reads it off the session.
  if (harness) setSessionHarnessOption(session, harness, 'permissions', mode);
  else session.permissionMode = mode as AiHarnessPermissionMode;
  session.updatedAt = new Date().toISOString();
  await writeState(state);
}

/** A new chat on ClikCode Local or the Gateway, or an existing one already
 * there, with the model and approval mode asked for. */
async function startOrResumeAgentChat(options: { route: 'clikcode-local' | 'gateway'; chat?: string; model?: string; permissions?: string }): Promise<string> {
  const { applyClikCodeAgentSessionPolicy, launchSession } = await import('./sessions.js');
  // Settings only: no history is read or changed here.
  const state = await readState({ transcripts: [] });
  let session: HarnessSession | undefined;
  if (options.chat) {
    const id = await resolveChat(options.chat);
    session = state.sessions.find((item) => item.id === id);
    if (session && session.route !== options.route) {
      throw new Error(`that chat runs on ${sessionProviderLabel(session)}; move it with /provider, or leave out --chat to start a new one`);
    }
  } else {
    session = launchSession(state, process.cwd());
    applyClikCodeAgentSessionPolicy(session, options.route);
    state.sessions.push(session);
    // On disk before the worker is asked for it, as a vendor chat's is: a
    // draft held only in this process's memory is a chat the worker cannot
    // find. It exited "not found" and the turn ran in this process instead.
    forceStoreSession(session.id);
  }
  if (!session) throw new Error(`AI session "${options.chat}" was not found`);
  if (options.model) {
    if (options.route === 'gateway') {
      // The same choice /model makes: a model from this account's Gateway list
      // (served from its cheapest listing), or `auto` to hand it back.
      const { chooseGatewayModel } = await import('./sessions.js');
      session.model = await chooseGatewayModel(options.model);
      if (session.reported?.model) delete session.reported.model;
    } else {
      const { resolveLocalModelId } = await import('../../local-models/catalog.js');
      session.model = resolveLocalModelId(options.model);
    }
  }
  await writeState(state);
  if (options.permissions) await setChatPermissions(session.id, options.permissions);
  return session.id;
}
