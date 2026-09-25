/** `clikcode harness`: choosing which harness a session runs on. */

import { randomUUID } from 'node:crypto';
import chalk from 'chalk';
import { ensureNativeHarness, inspectNativeHarness } from '../../harness/transport/native/inspect.js';
import { loginNativeHarness } from '../../harness/transport/native/login.js';
import type { AiHarnessAccount } from '../../harness/definition.js';
import { sessionProviderLabel } from '../../harness/protocol/labels.js';
import { nativeProfileEnvironment } from '../../harness/transport/profile-environment.js';
import { localHarnessForCommand, localHarnessForProvider } from '../../runtime/lazy-bridge.js';
import { readState } from '../../session/state/read.js';
import { accountView } from '../../session/state/views.js';
import { writeState } from '../../session/state/write.js';
import { resolveNativeModel } from '../../harness/accounts/model-catalog.js';
import { harnessNeedsLogin, syncAccountIdentityAfterLogin, withVendorTerminal } from '../account.js';
import { deriveAccountLabel } from '../../harness/accounts/labels.js';
import { TERMINAL } from '../../tui/active-terminal.js';
import { emitHarnessOutput } from '../../harness/output.js';
import { harnessCanRunTurns } from '../../runtime/lazy-bridge.js';
import { requiresProviderHandoff } from '../../session/options.js';
import { preferredAccountId } from './preferred-account.js';
import { hasAuthEvidence } from '../../harness/accounts/auth-files.js';

/** Select a provider while retaining ClikCode as the foreground UI. Installs
 * it first if needed, and — only inside the interactive terminal session,
 * where suspending the alt-screen for a vendor login prompt makes sense —
 * signs in if the vendor CLI reports (or a fresh install implies) that it
 * isn't authenticated yet. The goal: every harness either works immediately
 * or ClikCode gets you to "working" itself, instead of erroring and telling
 * you to go run something separately. */
export async function aiHarnessSelect(harnessCommandName: string, sessionId: string, options: { emit?: boolean } = {}): Promise<void> {
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
    const shouldCheckLogin = freshInstall
      || (accountJustCreated && !harness.statusArgv && !hasAuthEvidence(harness))
      || account?.status !== 'ready'
      || (accountJustCreated && await harnessNeedsLogin(harness, environment));
    if (shouldCheckLogin) {
      await withVendorTerminal(TERMINAL.active, harness, () => loginNativeHarness(harness, environment));
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
  // Always a real model, never a placeholder -- see resolveNativeModel.
  if (!session.model) {
    session.model = state.providerSettings[harness.provider]?.model
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

/** A chat ready for a turn from the command line: bound to a harness and an
 * account the way the app binds one on launch -- its provider's, else the
 * installed harness the user is signed in to. Used by `sessions send`,
 * `send` and `sessions create`, which each failed with "no account selected"
 * until a separate `accounts add` and `sessions set`. */
export async function ensureChatReady(id: string): Promise<void> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session || session.route === 'gateway' || session.accountId) return;
  const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness)
    : session.provider ? localHarnessForProvider(session.provider) : undefined;
  if (harness) return aiHarnessSelect(harness.command, id, { emit: false });
  const { autoSelectSessionHarness } = await import('../../tui/pickers/engine.js');
  if (!await autoSelectSessionHarness(id)) throw new Error('no harness is installed -- install one, e.g. npm i -g @anthropic-ai/claude-code');
}

/** A chat named on the command line: its id, the start of one, its name, or
 * `last`. */
export async function resolveChat(ref: string): Promise<string> {
  const state = await readState();
  if (state.sessions.some((item) => item.id === ref)) return ref;
  const { chatNamed } = await import('../../session/options.js');
  const id = chatNamed(state.sessions, ref, '');
  if (!id) throw new Error(`no chat matches "${ref}" -- use its name, the start of its id, or last`);
  return id;
}

/** `clikcode send`: the chat to send in, ready for a turn. */
export async function startOrResumeChat(options: { harness?: string; chat?: string; model?: string }): Promise<string> {
  let id: string;
  if (options.chat) id = await resolveChat(options.chat);
  else {
    const { launchSession } = await import('./sessions.js');
    const state = await readState();
    const session = launchSession(state, process.cwd());
    state.sessions.push(session);
    await writeState(state);
    id = session.id;
  }
  if (options.harness) {
    const harness = localHarnessForCommand(options.harness) ?? localHarnessForProvider(options.harness);
    if (!harness) throw new Error(`unknown harness "${options.harness}"`);
    const state = await readState();
    const session = state.sessions.find((item) => item.id === id);
    if (session?.nativeHarness !== harness.command) {
      // A chat with history moves to the harness as a branch; a new one
      // simply runs there.
      const { newProviderConversation } = await import('./conversations.js');
      id = options.chat ? await newProviderConversation(id, harness.command) : id;
      if (!options.chat) await aiHarnessSelect(harness.command, id, { emit: false });
    }
  }
  await ensureChatReady(id);
  if (options.model) {
    const state = await readState();
    const session = state.sessions.find((item) => item.id === id);
    const harness = session?.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
    if (session && harness) {
      const { modelIdFromDisplay } = await import('../../runtime/lazy-bridge.js');
      session.model = modelIdFromDisplay(harness, options.model);
      await writeState(state);
    }
  }
  return id;
}
