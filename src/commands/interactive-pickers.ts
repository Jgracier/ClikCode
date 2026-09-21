/**
 * Choosing things by arrow key instead of by typing them.
 *
 * Every picker here ends by calling the same command a typed slash line would
 * have, so a selection and a typed setting cannot drift apart -- the picker
 * decides what to choose, never what choosing means. Separate from the
 * interactive loop because the loop only needs to know which picker to open.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { stdout as output } from 'node:process';
import type Conf from 'conf';
import chalk from 'chalk';
import { getApiKeyForUrl, getApiUrl } from './gateway-credentials.js';
import { gatewayLogin } from './gateway-login.js';
import { vendorFacingOptions } from './harness-options.js';
import { inspectNativeHarness, inspectNativeHarnessForPicker, loginNativeHarness, runNativeHarnessCommand } from './native-harness.js';
import { spawnPortable as spawn } from './spawn-portable.js';
import { ADOPTED_TRANSCRIPT_READERS, discoverNativeSessions, FS_SESSION_DISCOVERY, type DiscoveredNativeSession } from './native-session-discovery.js';
import type { AiHarnessAccount, AiHarnessPermissionMode, AiLocalHarnessDefinition, HarnessPrompter, HarnessSession, HarnessState, PickerOption } from './types.js';
import { harnessSupportsEffort, harnessSupportsPermissionMode, localHarnessCapabilityManifest, localHarnessForCommand, localHarnessForProvider, compactPath, nativeProfileEnvironment } from './native-harness-protocol.js';
import { harnessStatePath, readState, resolveDefaultSettings, writeState } from './harness-state.js';
import { accountUsageLabel, cachedAccountUsageLabel, nativeModelCatalogForPicker, NATIVE_USAGE_PROBES } from './native-account-data.js';
import { aiAccountAdd, aiAccountLogin, aiAccountRemove, announceBareInteractiveLogin, syncAccountIdentityAfterLogin } from './account-management.js';
import { synchronizeNativeTranscript } from './turn-runtime.js';
import { TERMINAL } from './active-terminal.js';
import { emitHarnessOutput, line } from './harness-output.js';
import { TerminalHarnessPrompter, terminalUiSupported } from './terminal-ui.js';
import { allLocalHarnesses, harnessCanRunTurns, harnessTierRank } from './harness-runtime.js';
import { claimSession, sessionClaimIsLive } from './session-claim.js';
import { accountPickerOptions, conversationIdFor, hasConversationContent, integrationLabel, optionForHarness, providerPickerOptions, requiresProviderHandoff, sessionPickerOptions, setSessionHarnessOption, VALID_EFFORTS, VALID_PERMISSION_MODES, type ProviderAccountChoice } from './session-options.js';
import { type SlashHandlerKey } from './slash-registry.js';
import { sessionTranscriptMessages } from './turn-checkpoint.js';
import {
  aiHarnessSelect, aiSettingsSetGlobal, aiSettingsSetProvider, applyGatewaySessionPolicy, newProviderConversation,
} from './ai.js';
import {
  aiSessionCommand,
} from './slash-handlers.js';


/** Edit the active conversation's approval behavior from the top-level
 * `clikcode permissions` command. The same picker and provider capability
 * checks back the in-chat `/permissions` command, so the two surfaces cannot
 * drift. With no conversation yet, a selection becomes the global default. */
export async function aiPermissions(mode?: string): Promise<void> {
  const normalizedMode = mode?.trim().toLowerCase() as AiHarnessPermissionMode | undefined;
  if (normalizedMode && !VALID_PERMISSION_MODES.includes(normalizedMode)) {
    throw new Error('permissions must be ask, bypass, or auto');
  }
  const state = await readState();
  const session = [...state.sessions]
    .sort((left, right) => Number(right.status === 'active') - Number(left.status === 'active') || right.updatedAt.localeCompare(left.updatedAt))[0];
  if (normalizedMode) {
    if (session) await aiSessionCommand(session.id, `/permissions ${normalizedMode}`);
    else await aiSettingsSetGlobal('permissions', normalizedMode);
    return;
  }
  if (!terminalUiSupported()) throw new Error('an ANSI-capable interactive terminal is required; use `clikcode permissions ask|bypass|auto`');
  const rl = new TerminalHarnessPrompter();
  TERMINAL.active = rl;
  try {
    if (session) {
      const account = session.accountId ? state.accounts.find((item) => item.id === session.accountId)?.label : undefined;
      rl.render?.(session, account);
      await interactivePermissionPicker(rl, session.id);
    } else {
      const selected = await chooseOption(rl, 'Choose permissions', VALID_PERMISSION_MODES.map((value) => ({
        label: value[0].toUpperCase() + value.slice(1), value,
      })));
      if (selected) await aiSettingsSetGlobal('permissions', selected);
    }
  } finally {
    TERMINAL.active = undefined;
    rl.close();
  }
}

async function chooseOption<T>(
  rl: HarnessPrompter,
  title: string,
  options: readonly PickerOption<T>[],
  onAction?: (value: T, action: string) => Promise<void>,
  settings?: {
    onBack?: () => void;
    onEscape?: () => void;
    refreshedOptions?: () => readonly PickerOption<T>[];
    refresh?: Promise<unknown>;
  },
): Promise<T | undefined> {
  if (options.length === 0) return undefined;
  if (rl.select) return rl.select(title, options, onAction, settings);
  output.write(`\n${chalk.bold(title)}\n`);
  options.forEach((option, index) => {
    output.write(`  ${chalk.cyan(String(index + 1).padStart(2))}  ${option.label}${option.detail ? ` ${chalk.dim(option.detail)}` : ''}\n`);
  });
  output.write(`  ${chalk.dim('0   Cancel')}\n\n`);
  const answer = (await rl.question(chalk.bold('Choose › '))).trim();
  if (!answer || answer === '0') return undefined;
  const index = Number(answer) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= options.length) {
    emitHarnessOutput({ panel: 'error', message: `Choose a number from 1 to ${options.length}.` });
    return undefined;
  }
  return options[index].value;
}

/** A brand-new conversation root. How you want to work (provider, account,
 * model, effort, permissions, workspace) carries over; what you were talking
 * about does not. Crucially it takes a fresh conversationId and no parent, so
 * it lists as its own row in /resume instead of merging into the conversation
 * it was started from, and it carries no inherited name. */
/** Which account a conversation on this provider should use.
 *
 * The rule, in one place because it was previously decided in two: keep the
 * one it already has if that still fits, otherwise the account most recently
 * used on this provider, otherwise the first ready one. Null only when the
 * provider has no ready account at all.
 *
 * Both callers used to give up and store null as soon as a provider had more
 * than one account -- on the reasoning that the user should choose -- but
 * nothing asked them to, so the next turn failed with "no account selected"
 * on exactly the setups where an account was most obviously available. */

async function ensureGatewayLogin(config: Conf, rl: HarnessPrompter): Promise<void> {
  const apiUrl = getApiUrl(config);
  if (getApiKeyForUrl(config, apiUrl)) return;
  const provider = await chooseOption(rl, 'Sign in to ClikDeploy Gateway', [
    { label: 'Continue with Google', value: 'google' as const },
    { label: 'Continue with GitHub', value: 'github' as const },
  ]);
  if (!provider) throw new Error('ClikDeploy Gateway sign-in was cancelled.');
  if (rl instanceof TerminalHarnessPrompter) await rl.suspend();
  try {
    await gatewayLogin(config, { google: provider === 'google', github: provider === 'github', embedded: true });
  } finally {
    if (rl instanceof TerminalHarnessPrompter) rl.resume();
  }
  if (!getApiKeyForUrl(config, apiUrl)) throw new Error('ClikDeploy OAuth completed without storing a Gateway credential.');
}

async function newGatewayConversation(config: Conf, rl: HarnessPrompter, currentId: string): Promise<string> {
  await ensureGatewayLogin(config, rl);
  const state = await readState();
  const current = state.sessions.find((item) => item.id === currentId);
  if (!current) throw new Error(`AI session "${currentId}" was not found`);
  if (current.route === 'gateway') return current.id;
  if (!hasConversationContent(current) && !current.nativeHarness) {
    applyGatewaySessionPolicy(current);
    current.updatedAt = new Date().toISOString();
    await writeState(state);
    return current.id;
  }
  if (await synchronizeNativeTranscript(state, current)) await writeState(state);
  const now = new Date().toISOString();
  const id = randomUUID();
  const session: HarnessSession = {
    id, conversationId: conversationIdFor(current), parentSessionId: current.id,
    handoff: { fromSessionId: current.id, fromHarness: current.nativeHarness ?? current.route, at: now },
    route: 'gateway', accountId: null, provider: 'clikdeploy-gateway', model: null,
    effort: 'platform-managed', accountFailover: 'never',
    workspace: current.workspace ?? process.cwd(), name: current.name?.replace(/\s+\(from [^)]+\)$/i, '').trim() || undefined,
    ...(sessionTranscriptMessages(current).length
      ? { messages: sessionTranscriptMessages(current).map((message) => ({ ...message })) }
      : {}),
    createdAt: now, updatedAt: now, status: 'active',
    gatewayConfirmed: true,
  };
  state.sessions.push(session);
  await writeState(state);
  return session.id;
}






async function selectProviderConversation(config: Conf, rl: HarnessPrompter, id: string, selected: string): Promise<string> {
  if (selected === '__gateway__') return newGatewayConversation(config, rl, id);
  const state = await readState();
  const current = state.sessions.find((item) => item.id === id);
  if (!current) throw new Error(`AI session "${id}" was not found`);
  if (!requiresProviderHandoff(current, selected) && !current.nativeHarness) {
    await aiHarnessSelect(selected, id);
    return id;
  }
  return newProviderConversation(id, selected);
}

export async function interactiveAccountPicker(
  rl: HarnessPrompter,
  id: string,
): Promise<string | undefined> {
  for (;;) {
    const state = await readState();
    const session = state.sessions.find((item) => item.id === id);
    if (!session) throw new Error(`AI session "${id}" was not found`);
    const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness)
      : session.provider ? localHarnessForProvider(session.provider) : undefined;
    if (!harness || session.route === 'gateway') {
      rl.panel?.('Accounts', 'Choose a local provider before switching accounts.');
      return undefined;
    }
    const providerAccounts = state.accounts.filter((account) => account.provider === harness.provider);
    if (!providerAccounts.length) {
      rl.panel?.(`${harness.displayName} accounts`, `No accounts are connected. Use /accounts login ${harness.command} <label> to add one.`);
      return undefined;
    }
    // Only spin where a figure can actually arrive. A harness that reports on
    // its own turn stream has no probe to wait on, so the row shows what its
    // last turn reported -- or nothing, if it has not run one here -- rather
    // than a spinner that resolves to nothing.
    let usagePending = NATIVE_USAGE_PROBES[harness.command] !== undefined;
    const accountOptions = (): PickerOption<ProviderAccountChoice>[] => accountPickerOptions(
      providerAccounts.map((account) => ({
        account,
        usage: cachedAccountUsageLabel(account, state),
        usagePending: usagePending && account.authKind === 'vendor-cli',
      })),
      session,
      harness,
    );
    // Refresh whatever has a probe behind it. Harnesses that report on their
    // own turn stream are not asked -- there is nobody to ask but the vendor,
    // and the figure they already gave is the only one anyone truly has.
    const usageRefresh = Promise.allSettled(providerAccounts.map((account) => accountUsageLabel(account, state, { network: true })))
      .then(() => { usagePending = false; });
    let actionPerformed = false;
    let backedOut = false;
    const selected = await chooseOption(
      rl, `${harness.displayName} accounts`, accountOptions(),
      async (choice, action) => {
        if (choice.kind !== 'account') return;
        actionPerformed = true;
        await manageAccountAction(rl, choice.accountId, action);
      },
      { onBack: () => { backedOut = true; }, refreshedOptions: accountOptions, refresh: usageRefresh },
    );
    if (backedOut) {
      if (rl instanceof TerminalHarnessPrompter) rl.restoreDraft('/');
      return undefined;
    }
    if (actionPerformed) continue;
    if (!selected || selected.kind !== 'account') return undefined;
    await aiSessionCommand(id, `/settings account ${selected.accountId}`);
    return id;
  }
}

export async function interactiveEnginePicker(config: Conf, rl: HarnessPrompter, id: string): Promise<string | undefined> {
  for (;;) {
    const available = await Promise.all(allLocalHarnesses()
      .filter((harness) => harnessCanRunTurns(harness))
      .map(async (harness) => ({ harness, inspection: await inspectNativeHarnessForPicker(harness) })));
    const state = await readState();
    const session = state.sessions.find((item) => item.id === id);
    if (!session) throw new Error(`AI session "${id}" was not found`);
    const gatewayConnected = Boolean(getApiKeyForUrl(config, getApiUrl(config)));
    const configuredProviders = new Set(state.accounts.map((account) => account.provider));
    let provider = await chooseOption(rl, 'Choose a provider', providerPickerOptions(available, session, gatewayConnected, configuredProviders));
    if (!provider) return undefined;
    if (provider.kind === 'more') {
      const primaryHarnesses = new Set(providerPickerOptions(available, session, gatewayConnected, configuredProviders)
        .flatMap((option) => option.value.kind === 'provider' ? [option.value.harness] : []));
      const more = providerPickerOptions(available, session, gatewayConnected, configuredProviders, true)
        .filter((option) => option.value.kind === 'provider' && !primaryHarnesses.has(option.value.harness));
      provider = await chooseOption(rl, 'More providers', more);
      if (!provider) continue;
    }
    if (provider.kind === 'gateway') return selectProviderConversation(config, rl, id, '__gateway__');
    if (provider.kind !== 'provider') continue;
    return selectProviderConversation(config, rl, id, provider.harness);
  }
}

/**
 * Bind a session to its native agent without asking. A session that already
 * names a provider or account is matched to that agent; a session with no
 * signal picks the first installed terminal harness in catalog tier order. Returns false only when nothing useful is
 * installed, so the caller can surface one line of guidance instead of a picker.
 */
export async function autoSelectSessionHarness(id: string): Promise<boolean> {
  const installedCache = new Map<string, boolean>();
  const isInstalled = async (harness?: AiLocalHarnessDefinition): Promise<boolean> => {
    if (!harness) return false;
    const known = installedCache.get(harness.command);
    if (known !== undefined) return known;
    const inspection = await inspectNativeHarness(harness, 1_500);
    installedCache.set(harness.command, inspection.installed);
    return inspection.installed;
  };
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session) return false;
  if (session.nativeHarness) return true;
  const account = session.accountId ? state.accounts.find((item) => item.id === session.accountId) : undefined;
  const preferred = localHarnessForProvider(session.provider ?? account?.provider ?? '');
  if (preferred && await isInstalled(preferred)) {
    await aiHarnessSelect(preferred.command, id);
    return true;
  }
  const candidates = allLocalHarnesses()
    .filter((harness) => harnessCanRunTurns(harness))
    .sort((left, right) => harnessTierRank(left) - harnessTierRank(right));
  for (const harness of candidates) {
    if (await isInstalled(harness)) {
      await aiHarnessSelect(harness.command, id);
      return true;
    }
  }
  return false;
}

/** Well-known SDK/CLI environment variable names each vendor's own tooling
 * already looks for -- not invented here, just the standard name suggested
 * as a starting point for the env var prompt below. Falls back to a
 * generic <PROVIDER>_API_KEY guess for anything not in this short list. */
const PROVIDER_API_KEY_ENV: Readonly<Record<string, string>> = {
  anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', google: 'GOOGLE_API_KEY', qwen: 'DASHSCOPE_API_KEY',
  kiro: 'KIRO_API_KEY',
  // Confirmed real and current, not guessed: google-antigravity/antigravity-cli
  // issue #632 was closed 2 days before this was written (state_reason:
  // "completed"), with a maintainer's exact working recipe --
  // GEMINI_API_KEY plus modelProvider:"gemini" in the CLI's own
  // settings.json (handled below, in addApiKeyAccount itself, since this
  // map only carries the env var name). Cross-checked against the actual
  // installed binary: modelProvider is a real, present string in it. This
  // matters specifically because it's the only way to authenticate
  // Antigravity CLI that stays inside ClikCode at all -- it has no login
  // subcommand of its own (confirmed via --help), only a full interactive
  // TUI otherwise.
  antigravity: 'GEMINI_API_KEY',
};

async function addApiKeyAccount(rl: HarnessPrompter, harness: AiLocalHarnessDefinition): Promise<string | undefined> {
  const suggested = PROVIDER_API_KEY_ENV[harness.provider] ?? `${harness.provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`;
  let entered: string;
  try {
    entered = (await rl.question(`Environment variable holding the key ${chalk.dim(`[${suggested}]`)} › `, [], { cancellable: true })).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_PROMPT_CANCELLED') return undefined;
    throw error;
  }
  const envName = (entered || suggested).toUpperCase();
  if (!/^[A-Z][A-Z0-9_]*$/.test(envName)) throw new Error('environment variable name must be letters, numbers, and underscores only');
  if (!process.env[envName]) throw new Error(`${envName} is not set in this shell -- export it first, then try again. ClikCode never asks for or stores the raw key itself, only this reference.`);
  // Antigravity CLI needs one more thing beyond the env var itself: its
  // own settings.json must set modelProvider to "gemini", or it ignores
  // GEMINI_API_KEY entirely and falls back to OAuth (confirmed directly:
  // a maintainer's exact recipe on the now-closed antigravity-cli#632, plus
  // real user reports on #78 of the env var alone having no effect without
  // it). No isolated profile exists for this harness (confirmed: no
  // profileEnv), so this is always the one real, global settings file --
  // merged in, not overwritten, so any of the user's other settings
  // (colorScheme, permissions, trustedWorkspaces, etc.) survive untouched.
  if (harness.command === 'antigravity') {
    const settingsPath = join(homedir(), '.gemini', 'antigravity-cli', 'settings.json');
    let settings: Record<string, unknown> = {};
    try { settings = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>; } catch { /* no existing settings file yet */ }
    if (settings.modelProvider !== 'gemini') {
      settings.modelProvider = 'gemini';
      await mkdir(join(settingsPath, '..'), { recursive: true });
      await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    }
  }
  const state = await readState();
  const existingForProvider = state.accounts.filter((account) => account.provider === harness.provider).length;
  const label = `${harness.displayName} (${envName})`;
  const finalLabel = state.accounts.some((account) => account.label === label) ? `${label} ${existingForProvider + 1}` : label;
  await aiAccountAdd({ provider: harness.provider, label: finalLabel, auth: 'api-key', credentialRef: `env:${envName}` });
  return finalLabel;
}

export async function addAccountForHarness(rl: HarnessPrompter, harness: AiLocalHarnessDefinition): Promise<string | undefined> {
  // Vendor login is the only path this offered before -- but Claude Code
  // (and others) also declare api-key as a supported local auth kind, with
  // no way to actually set one up short of the fully manual, headless-only
  // `accounts add --auth api-key --credential-ref env:VAR` invocation. Only
  // asks when there's a real choice to make; a harness with just one
  // supported local auth kind skips straight to it, same as before.
  //
  // 'vendor-cli' only counts as a real choice when loginArgv actually
  // exists -- caught during a full audit: localAuth is a broader claim
  // ("this provider conceptually supports vendor-cli auth"), separate from
  // whether this catalog has a scriptable command to perform it. Several
  // harnesses (Aider, Goose, Crush, Factory Droid, Kiro CLI) declare
  // vendor-cli in localAuth with no loginArgv at all -- offering "Vendor
  // login" for those would fall through to aiAccountLogin's own
  // `harness.loginArgv ?? []` default and run the bare binary with no
  // arguments, which isn't a login flow for any of them.
  const choices = harness.localAuth.filter((kind) => (kind === 'vendor-cli' && harness.loginArgv) || kind === 'api-key');
  // Factory Droid and Kiro CLI currently land here: oauth-only in localAuth
  // (no api-key) and no loginArgv either, so there's genuinely no way for
  // this catalog to add an account for them yet -- rather than fabricate a
  // login command that isn't verified, say so plainly instead of silently
  // doing nothing (choices[0] being undefined used to fall through to the
  // same "if (!authKind) return" as a real cancel, indistinguishable from
  // one).
  if (choices.length === 0) throw new Error(`${harness.displayName} doesn't publish a login command or a supported API-key auth mode yet -- nothing here can add an account for it.`);
  const authKind = choices.length > 1
    ? await chooseOption(rl, `Sign in to ${harness.displayName} with`, [
        { label: 'Vendor login', detail: 'opens the CLI’s own sign-in flow', value: 'vendor-cli' as const },
        { label: 'API key', detail: 'reference an environment variable, never typed here', value: 'api-key' as const },
      ])
    : choices[0];
  if (!authKind) return undefined;
  if (authKind === 'api-key') {
    return addApiKeyAccount(rl, harness);
  }
  // No name prompt: aiAccountLogin picks a numbered placeholder up front and
  // replaces it with something derived from the harness's own credentials
  // once login actually completes, wherever that's possible -- one less
  // step than asking the user to type or confirm a name themselves.
  //
  // suspend/resume around this call, previously missing here entirely: the
  // one place aiHarnessSelect's own login flow has always had this, but
  // this second entry point into the exact same loginNativeHarness spawn
  // didn't. Claude Code's own login (print a URL, wait for a pasted code)
  // happens to tolerate running without it, which is why this went
  // unnoticed -- but a harness whose login is a full interactive TUI
  // needing exclusive terminal control (Antigravity CLI's bubbletea, which
  // opens /dev/tty directly) has no business running while ClikCode's own
  // raw-mode/alt-screen state is still active competing for the same
  // terminal.
  let label: string;
  if (harness.loginCapturable && rl instanceof TerminalHarnessPrompter) {
    rl.startWaiting(`signing in to ${harness.displayName}…`);
    try { label = await aiAccountLogin(harness.command); } finally { rl.stopWaiting(); }
  } else if (rl instanceof TerminalHarnessPrompter) {
    await rl.suspend();
    try {
      announceBareInteractiveLogin(harness);
      label = await aiAccountLogin(harness.command);
    } finally { rl.resume(); }
  } else {
    label = await aiAccountLogin(harness.command);
  }
  return label;
}

/** Maintenance actions are deliberately narrow label/value pairs rather than
 * nested PickerOptions. Non-destructive actions open with Tab; destructive
 * deleteAction values open only from Delete and are confirmed by select(). */
export async function manageAccountAction(rl: HarnessPrompter, accountId: string, action: string): Promise<void> {
  const state = await readState();
  const account = state.accounts.find((item) => item.id === accountId);
  const harness = account ? localHarnessForProvider(account.provider) : undefined;
  if (!account || !harness) return;
  if (action === 'remove') {
    await aiAccountRemove(account.id);
    return;
  }
  if (account.authKind !== 'vendor-cli') return;
  const environment = nativeProfileEnvironment(account.nativeProfile);
  if (action === 'disconnect' && harness.logoutArgv) {
    await runNativeHarnessCommand(harness, harness.logoutArgv, environment);
    account.status = 'needs_login';
    await writeState(state);
  } else if (action === 'reauthenticate' && harness.loginArgv) {
    if (harness.loginCapturable && rl instanceof TerminalHarnessPrompter) {
      rl.startWaiting(`signing in to ${harness.displayName}…`);
      try { await loginNativeHarness(harness, environment); } finally { rl.stopWaiting(); }
    } else if (rl instanceof TerminalHarnessPrompter) {
      await rl.suspend();
      try {
        announceBareInteractiveLogin(harness);
        await loginNativeHarness(harness, environment);
      } finally { await rl.resume(); }
    } else {
      await loginNativeHarness(harness, environment);
    }
    await syncAccountIdentityAfterLogin(harness, account, state);
  }
}


type AdoptableNativeSession = {
  harness: AiLocalHarnessDefinition;
  item: DiscoveredNativeSession;
  accountId?: string;
};

/** Conversations that exist only inside a vendor's own history — never opened
 * through ClikCode — are otherwise invisible in /resume entirely, which only
 * ever looked at ClikCode's own tracked sessions. Two independent mechanisms
 * feed this, because vendors expose their own history in genuinely different
 * ways: a machine-readable CLI listing via discoverArgv (confirmed live:
 * opencode, Hermes; confirmed only against docs/source, not installed here:
 * Qwen Code, Crush; declared but with an unconfirmed JSON shape: Goose,
 * Kilo Code; a real command with no JSON mode at all, needing its own
 * numbered-list parser: Gemini CLI) — or, for harnesses that publish no
 * listing command whatsoever, reading their own on-disk session files
 * directly (confirmed live: Claude Code, Codex, Cursor Agent; docs-only,
 * unverified against a real install: Pi). GitHub Copilot CLI, Aider, Amp,
 * Factory Droid, Kiro CLI, Cline CLI, and Command Code are deliberately not
 * wired in at all: each either has no local listing mechanism (Aider, Amp's
 * canonical store is server-side), an undocumented on-disk format (Copilot
 * CLI, Factory Droid, Kiro CLI, Cline CLI), or an unresolved identity
 * mismatch between this catalog's entry and the only public docs found for
 * its name (Command Code) — none of these are guessed at.
 *
 * Every one of those spawns a real vendor CLI (up to a 4s timeout each, once
 * per account profile) or walks a vendor's on-disk store, so this is slower
 * than the rest of /resume by orders of magnitude and must never be awaited
 * before the picker is on screen. */
async function discoverAdoptableSessions(state: HarnessState, workspace: string): Promise<AdoptableNativeSession[]> {
  const discoveryProfiles = (harness: AiLocalHarnessDefinition): Array<AiHarnessAccount | undefined> => {
    const accounts = state.accounts.filter((item) => item.provider === harness.provider && item.status === 'ready');
    if (!accounts.length) return [undefined];
    const unique = new Map<string, AiHarnessAccount>();
    for (const account of accounts) unique.set(account.nativeProfile?.path ?? 'default', account);
    return [...unique.values()];
  };
  const discoverable = allLocalHarnesses().filter((harness) => harness.session?.discoverArgv);
  const shellDiscovered = (await Promise.all(discoverable.map(async (harness) => {
    return (await Promise.all(discoveryProfiles(harness).map(async (account) => {
      const environment = nativeProfileEnvironment(account?.nativeProfile);
      const found = await discoverNativeSessions(harness, environment, workspace);
      return found.map((item) => ({ harness, item, accountId: account?.id }));
    }))).flat();
  }))).flat();
  const fsDiscovered = (await Promise.all(Object.entries(FS_SESSION_DISCOVERY).map(async ([command, discover]) => {
    const harness = localHarnessForCommand(command);
    if (!harness) return [];
    const inspection = await inspectNativeHarness(harness, 500);
    if (!inspection.installed) return [];
    return (await Promise.all(discoveryProfiles(harness).map(async (account) => {
      const found = await discover(workspace, nativeProfileEnvironment(account?.nativeProfile)).catch(() => []);
      return found.map((item) => ({ harness, item, accountId: account?.id }));
    }))).flat();
  }))).flat();
  return [...shellDiscovered, ...fsDiscovered]
    .filter(({ harness, item, accountId }) => !state.sessions.some((session) => session.nativeHarness === harness.command
      && session.nativeSessionId === item.nativeId && (!accountId || session.accountId === accountId)));
}

/** Indirection so tests can hold discovery open and observe the picker while
 * it is still pending. */
export const NATIVE_SESSION_DISCOVERY = { run: discoverAdoptableSessions };

const NATIVE_DISCOVERY_TTL_MS = 60_000;
let nativeDiscoveryCache: { key: string; at: number; result: Promise<AdoptableNativeSession[]> } | undefined;

export function resetNativeDiscoveryCache(): void {
  nativeDiscoveryCache = undefined;
}

/** Reopening /resume inside one terminal re-spawned every installed vendor CLI
 * from scratch. The listing does not change meaningfully minute to minute, so
 * hold it briefly — keyed on the inputs that would change the answer. */
function cachedAdoptableSessions(state: HarnessState, workspace: string): Promise<AdoptableNativeSession[]> {
  const key = [workspace, ...state.accounts.map((item) => `${item.id}:${item.nativeProfile?.path ?? ''}`).sort()].join('\u0000');
  const cached = nativeDiscoveryCache;
  if (cached && cached.key === key && Date.now() - cached.at < NATIVE_DISCOVERY_TTL_MS) return cached.result;
  const result = NATIVE_SESSION_DISCOVERY.run(state, workspace).catch(() => {
    // fail-open-ok: discovery is passive enrichment of a list that is already
    // complete for ClikCode's own conversations. A vendor CLI that fails must
    // not take /resume down with it, and must not be cached as an answer.
    nativeDiscoveryCache = undefined;
    return [] as AdoptableNativeSession[];
  });
  nativeDiscoveryCache = { key, at: Date.now(), result };
  return result;
}

/** Selected while discovery is still running: wait for it, then reopen. */
const PENDING_DISCOVERY_VALUE = '__discovering__';

export async function interactiveSessionPicker(rl: HarnessPrompter, currentId: string): Promise<{ id: string } | undefined> {
  const state = await readState();
  const current = state.sessions.find((item) => item.id === currentId);
  // A session with no turns yet has nothing to resume into — showing it here is
  // indistinguishable from a real conversation until you're already inside it,
  // and older empty sessions (from before aiSessionClose started dropping them)
  // otherwise bury every real, titled conversation under identical
  // "Untitled chat" entries. Always keep the current session visible even if
  // it's still empty, so picking "current" back out of the list still works.
  // A set nativeSessionId counts as real content too, even with zero
  // ClikCode-tracked messages: a session adopted from a vendor's own history,
  // or linked to one directly, has a real vendor-side conversation behind it
  // that ClikCode simply never routed a turn through yet.
  // A conversation another terminal is driving right now used to be dropped
  // from this list outright, on the theory that both terminals would then
  // render and steer the same chat. In practice a claim's heartbeat only
  // proves its process is still running, not that anyone is still watching
  // it -- ai.ts ignores SIGHUP for the whole session lifetime so a flaky SSH
  // connection survives it, which means a dropped connection (closing the
  // laptop, a network blip, never sending /exit) leaves an orphaned process
  // heartbeating forever. That silently hid the conversation from every
  // future /resume, indistinguishable from data loss. It is listed and
  // annotated instead below; selecting it takes it over the same way opening
  // any session already does (claimSession is unconditional).
  const sessions = state.sessions
    .filter((session) => session.id === currentId || sessionTranscriptMessages(session).length > 0 || Boolean(session.nativeSessionId))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const workspace = current?.workspace ?? process.cwd();

  // ClikCode's own conversations are already in hand and are what /resume is
  // almost always for, so the picker opens on them immediately. Vendor
  // discovery folds in when it lands, through the same refresh mechanism the
  // account picker uses for usage. Awaiting it first left the composer cleared
  // and the screen blank for as long as the slowest vendor CLI took to answer.
  let discovered: AdoptableNativeSession[] = [];
  let discovering = true;
  const discovery = cachedAdoptableSessions(state, workspace)
    .then((found) => { discovered = found; })
    .finally(() => { discovering = false; });

  const buildOptions = (): PickerOption<string>[] => {
    // Every option gets a single real recency key so the newest conversation is
    // always near the top regardless of which source found it — grouping by
    // source first (every ClikCode session, then every opencode result, then
    // every Hermes result, ...) buried a two-minutes-old live Claude Code
    // session below Hermes entries from June, since each *group* was sorted
    // internally but the groups themselves were never interleaved. A source
    // with no real timestamp (an unparsed vendor display string) sorts last
    // rather than claiming a false position.
    const groupedOptions = sessionPickerOptions(sessions, currentId);
    const sessionsById = new Map(sessions.map((session) => [session.id, session]));
    const trackedBlocks = new Map<string, { sortKey: number; options: PickerOption<string>[] }>();
    for (const option of groupedOptions) {
      const session = sessionsById.get(option.value)!;
      if (session.id !== currentId && sessionClaimIsLive(session)) {
        option.detail = `${option.detail ?? ''} · active in another terminal`;
      }
      const root = conversationIdFor(session);
      const updatedAt = Date.parse(session.updatedAt);
      const block = trackedBlocks.get(root) ?? { sortKey: -Infinity, options: [] };
      block.sortKey = Math.max(block.sortKey, Number.isNaN(updatedAt) ? -Infinity : updatedAt);
      block.options.push(option);
      trackedBlocks.set(root, block);
    }
    const optionBlocks = [
      ...trackedBlocks.values(),
      ...discovered.map(({ harness, item, accountId }, index) => ({
        sortKey: item.updatedAtMs ?? -Infinity,
        options: [{
          label: `${harness.displayName} • ${item.title ?? 'Untitled chat'}`,
          detail: `· not yet in ClikCode${accountId ? ` · ${state.accounts.find((account) => account.id === accountId)?.label ?? 'linked account'}` : ''}${item.updatedAt ? ` · ${item.updatedAt}` : ''}`,
          value: `native:${index}`,
        }],
      })),
    ].sort((left, right) => right.sortKey - left.sortKey);
    // Conversation roots and unadopted native sessions share one recency order.
    // Provider hops stay behind each root row's Tab history.
    const options = optionBlocks.flatMap((block) => block.options);
    if (discovering) {
      options.push({
        label: 'Looking for chats from other CLIs…',
        detail: '· your ClikCode conversations are listed above',
        value: PENDING_DISCOVERY_VALUE,
      });
    }
    return options;
  };

  const selected = await chooseOption(rl, 'Resume a session', buildOptions(), undefined,
    { refreshedOptions: buildOptions, refresh: discovery });
  if (!selected) return undefined;
  if (selected === PENDING_DISCOVERY_VALUE) {
    await discovery;
    return interactiveSessionPicker(rl, currentId);
  }
  if (!selected.startsWith('native:')) return { id: selected };
  const match = discovered[Number.parseInt(selected.slice('native:'.length), 10)];
  if (!match) return undefined;
  const nativeId = match.item.nativeId;
  const account = match.accountId
    ? state.accounts.find((item) => item.id === match.accountId)
    : state.accounts.find((item) => item.provider === match.harness.provider && item.status === 'ready');
  const defaults = resolveDefaultSettings(state, match.harness.provider);
  const now = new Date().toISOString();
  // The vendor's own thread already has full context regardless — adopting
  // its identity alone is enough for continuation to work correctly the
  // moment a turn is sent. Populating ClikCode's own transcript view too is a
  // separate, best-effort read: only wired for the harnesses with a confirmed
  // way to read a whole conversation back out (see ADOPTED_TRANSCRIPT_READERS
  // above), and never something continuation itself depends on.
  const transcriptReader = ADOPTED_TRANSCRIPT_READERS[match.harness.command];
  const messages = transcriptReader
    ? await transcriptReader(match.harness, nativeId, workspace, nativeProfileEnvironment(account?.nativeProfile)).catch(() => [])
    : [];
  const id = randomUUID();
  const adopted: HarnessSession = {
    id, conversationId: id, route: 'local', accountId: account?.id ?? null, provider: match.harness.provider,
    model: null, effort: defaults.effort, permissionMode: defaults.permissionMode, accountFailover: defaults.accountFailover,
    createdAt: now, updatedAt: now, status: 'active',
    nativeHarness: match.harness.command, nativeSessionId: nativeId, nativeStartedAt: now,
    // Named only from a title the harness itself wrote. The resume list also
    // shows the opening of the first message when there is no real title, and
    // writing THAT into `name` is what used to leave every adopted chat called
    // "we need to have scrolling but we need to not have terminal / co…" --
    // a preview that looks like a name forever, because nameSession returns
    // early on any name at all and can never replace it.
    workspace, ...(match.item.titleIsGenerated && match.item.title ? { name: match.item.title, nameSource: 'provider' as const } : {}),
    ...(messages.length ? { messages } : {}),
  };
  state.sessions.push(adopted);
  await writeState(state);
  // Picking a specific vendor's own chat by name is an explicit choice to open
  // it as that vendor — forcing it onto whatever provider was already active
  // (the same-conversation /resume behavior below) would immediately discard
  // the native session id just adopted, undoing the entire point of listing it.
  return { id: adopted.id };
}

export async function interactiveModelPicker(rl: HarnessPrompter, id: string): Promise<void> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  const account = session.accountId ? state.accounts.find((item) => item.id === session.accountId) : undefined;
  const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness)
    : session.provider ? localHarnessForProvider(session.provider) : undefined;
  const catalog = harness ? nativeModelCatalogForPicker(harness, account) : { models: account?.models ?? [] };
  const effective = session.model ?? catalog.configured;
  const discoveredModels = [...catalog.models].sort((left, right) => left === effective ? -1 : right === effective ? 1 : left.localeCompare(right));
  const options: PickerOption<string>[] = [
    ...discoveredModels.map((model) => {
      const parts = [
        catalog.labels?.[model],
        model === effective ? 'current' : undefined,
        model === effective && !session.model && model === catalog.configured ? 'provider configured' : undefined,
      ].filter((part): part is string => Boolean(part));
      return { label: model, detail: parts.length ? `· ${parts.join(' · ')}` : undefined, value: model };
    }),
    { label: 'Automatic provider default', detail: effective ? undefined : '· current', value: 'default' },
    { label: 'Enter a model ID…', value: '__custom__' },
  ];
  const selected = await chooseOption(rl, 'Choose a model', options);
  if (!selected) return;
  const value = selected === '__custom__' ? (await rl.question('Model ID › ')).trim() : selected;
  // Applies to this chat only, no further "apply to" step: a model choice is
  // read as a per-conversation decision, unlike effort/permissions/failover,
  // which are more often "how I always want this provider to behave" and
  // genuinely benefit from a scope choice.
  if (value) await aiSessionCommand(id, `/model ${value}`);
}

export async function interactiveSessionManager(rl: HarnessPrompter, id: string): Promise<'resume' | 'new' | 'exit' | undefined> {
  const action = await chooseOption(rl, 'Conversations', [
    { label: 'Resume another…', value: 'resume' },
    { label: 'Start clean', detail: 'reset provider context', value: 'new' },
    { label: 'Rename', value: 'rename' },
    { label: 'Fork', detail: 'copy transcript into a new conversation', value: 'fork' },
    { label: 'Archive', value: 'archive' },
    { label: 'Delete', detail: 'remove local ClikCode history', value: 'delete' },
  ] as const);
  if (!action) return undefined;
  if (action === 'resume') return 'resume';
  if (action === 'new') return 'new';
  if (action === 'rename') {
    const name = (await rl.question('Conversation name › ')).trim();
    if (name) await aiSessionCommand(id, `/rename ${name}`);
    return undefined;
  }
  if (action === 'fork') { await aiSessionCommand(id, '/fork'); return undefined; }
  if (action === 'archive') {
    const answer = (await rl.question('Archive this conversation? [y/N] › ')).trim().toLowerCase();
    if (answer === 'y' || answer === 'yes') { await aiSessionCommand(id, '/archive'); return 'exit'; }
    return undefined;
  }
  const answer = (await rl.question('Delete this conversation from ClikCode? Type delete › ')).trim().toLowerCase();
  if (answer === 'delete') { await aiSessionCommand(id, '/delete confirm'); return 'exit'; }
  return undefined;
}

/** After picking a new value, ask what it applies to instead of making that a
 * separate "Defaults for new chats" menu that asks the same question about the
 * same settings a second time. One flow per setting: choose the value, then
 * choose the scope. */
async function applySettingScope(
  rl: HarnessPrompter, id: string, key: 'effort' | 'permissions' | 'failover' | 'model', value: string,
): Promise<void> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  const harness = session?.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
  const scope = await chooseOption(rl, 'Apply to', [
    { label: 'This chat only', value: 'session' as const },
    { label: 'Global default', detail: 'every provider, unless overridden', value: 'global' as const },
    ...(harness ? [{ label: `${harness.displayName} default`, detail: 'this provider only', value: 'provider' as const }] : []),
  ]);
  if (!scope) return;
  if (scope === 'session') {
    if (key === 'failover') await aiSessionCommand(id, `/accounts failover ${value}`);
    else await aiSessionCommand(id, `/${key} ${value}`);
  } else if (scope === 'global') {
    await aiSettingsSetGlobal(key, value);
  } else if (harness) {
    await aiSettingsSetProvider(harness.command, key, value);
  }
}

export async function interactiveEffortPicker(rl: HarnessPrompter, id: string): Promise<void> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  if (session.route === 'gateway') throw new Error('ClikDeploy Gateway reasoning effort is selected by platform routing policy.');
  const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
  if (harness && !harnessSupportsEffort(harness)) throw new Error(`${harness.displayName} does not publish a configurable reasoning-effort flag.`);
  const effortOption = harness ? optionForHarness(harness, 'effort') : undefined;
  const efforts = effortOption?.values?.length ? effortOption.values : VALID_EFFORTS;
  const selected = await chooseOption(rl, 'Choose reasoning effort', efforts.map((value) => ({
    label: value, detail: value === session.effort ? '· current' : undefined, value,
  })));
  if (selected) await applySettingScope(rl, id, 'effort', selected);
}

export async function interactiveHarnessOptionPicker(rl: HarnessPrompter, id: string): Promise<void> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
  if (!harness) throw new Error('Choose a provider first.');
  const manifest = localHarnessCapabilityManifest(harness);
  // Only what no ClikCode command already owns. /model, /permissions, /effort,
  // /cwd and /add-dir were each listed here as a raw vendor row as well, so the
  // same setting had two interfaces that could disagree.
  const option = await chooseOption(rl, `${harness.displayName} options`, vendorFacingOptions(manifest.options).map((item) => ({
    label: item.label,
    detail: `· ${item.description}${item.dangerous ? ` · ${chalk.yellow('dangerous')}` : ''}`,
    value: item,
  })));
  if (!option) return;
  let raw: string | undefined;
  if (option.kind === 'boolean') {
    raw = await chooseOption(rl, option.label, [
      { label: 'On', value: 'on' }, { label: 'Off', value: 'off' },
    ]);
  } else if (option.values?.length) {
    raw = await chooseOption(rl, option.label, option.values.map((entry) => ({ label: entry, value: entry })));
  } else {
    raw = (await rl.question(`${option.label} › `)).trim();
  }
  if (raw === undefined || raw === '') return;
  const fresh = await readState();
  const target = fresh.sessions.find((item) => item.id === id);
  if (!target) return;
  setSessionHarnessOption(target, harness, option.id, raw);
  target.updatedAt = new Date().toISOString();
  await writeState(fresh);
}

export async function interactivePermissionPicker(rl: HarnessPrompter, id: string): Promise<void> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  if (session.route === 'gateway') throw new Error('ClikDeploy Gateway permissions are enforced by authenticated platform policy.');
  const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
  const current = session.permissionMode ?? 'ask';
  const descriptions: Record<AiHarnessPermissionMode, string> = {
    ask: 'require approval; unanswered headless prompts are denied',
    bypass: 'run without approval prompts',
    auto: 'provider reviews approval requests automatically',
  };
  const supported = harness ? VALID_PERMISSION_MODES.filter((mode) => harnessSupportsPermissionMode(harness, mode)) : VALID_PERMISSION_MODES;
  if (!supported.length) throw new Error(`${harness?.displayName ?? 'This provider'} does not map ClikCode's permission modes to a real flag.`);
  const selected = await chooseOption(rl, 'Choose permissions', supported.map((value) => ({
    label: value[0].toUpperCase() + value.slice(1), detail: `· ${descriptions[value]}${value === current ? ' · current' : ''}`, value,
  })));
  if (selected) await applySettingScope(rl, id, 'permissions', selected);
}

async function interactiveFailoverPicker(rl: HarnessPrompter, id: string): Promise<void> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  const current = session.accountFailover ?? 'on-quota-exhausted';
  const selected = await chooseOption(rl, 'Quota failover', [
    { label: 'Auto-switch accounts', detail: `· switch to another ready account of the same provider when quota runs out${current === 'on-quota-exhausted' ? ' · current' : ''}`, value: 'auto' },
    { label: 'Never', detail: `· stop and ask instead of switching${current === 'never' ? ' · current' : ''}`, value: 'never' },
  ]);
  if (selected) await applySettingScope(rl, id, 'failover', selected);
}

export async function interactiveSettingsPicker(config: Conf, rl: HarnessPrompter, id: string): Promise<string | undefined> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  const harness = session?.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
  const selected = await chooseOption(rl, 'Settings', [
    { label: 'Provider & account', detail: 'choose a harness, login, or add an account', value: 'provider' },
    ...(harness?.modelArgvPrefix ? [{ label: 'Model', detail: 'provider default or model ID', value: 'model' }] : []),
    ...(harness && harnessSupportsEffort(harness) ? [{ label: 'Reasoning effort', detail: 'provider-supported levels', value: 'effort' }] : []),
    ...(harness?.permissionModes?.length ? [{ label: 'Permissions', detail: 'provider-supported approval behavior', value: 'permissions' }] : []),
    ...(harness && vendorFacingOptions(localHarnessCapabilityManifest(harness).options).length
      ? [{ label: `${harness.displayName} options`, detail: 'modes, tools, safety, and context', value: 'options' }] : []),
    { label: 'Quota failover', detail: 'switch accounts automatically, or not', value: 'failover' },
    { label: 'Show current setup', value: 'status' },
  ] as const);
  if (selected === 'provider') return interactiveEnginePicker(config, rl, id);
  else if (selected === 'model') await interactiveModelPicker(rl, id);
  else if (selected === 'effort') await interactiveEffortPicker(rl, id);
  else if (selected === 'permissions') await interactivePermissionPicker(rl, id);
  else if (selected === 'options') await interactiveHarnessOptionPicker(rl, id);
  else if (selected === 'failover') await interactiveFailoverPicker(rl, id);
  else if (selected === 'status') await aiSessionCommand(id, '/status');
  return undefined;
}

/** Persistent terminal session using the same command and routing surface as automation. */
/** Commands the interactive loop handles itself (pickers, prompts, turns with
 * the waiting UI). Every other registry command falls through to
 * HEADLESS_SLASH_HANDLERS with its output shown in a panel. */
export const INTERACTIVE_SLASH_HANDLER_KEYS = [
  'exit', 'new', 'redraw', 'provider', 'account', 'accounts', 'model', 'effort', 'permissions', 'options', 'capabilities',
  'settings', 'sessions', 'resume', 'rename', 'archive', 'delete', 'mention', 'review', 'init', 'native', 'compact',
  'export', 'memory', 'doctor', 'login', 'logout',
] as const satisfies readonly SlashHandlerKey[];
export type InteractiveSlashHandlerKey = typeof INTERACTIVE_SLASH_HANDLER_KEYS[number];
export interface InteractiveSlashOutcome {
  /** Adopt this session (a new conversation, a handoff branch, a resumed chat). */
  id?: string;
  exit?: boolean;
  notice?: string;
  /** Run this as a turn on the (possibly just adopted) session. */
  prompt?: string;
  echo?: boolean;
}

/** Human-readable health summary for the TUI (the headless /doctor is JSON). */
export async function doctorSummary(state: HarnessState): Promise<string> {
  const harnesses = allLocalHarnesses().filter((harness) => harnessCanRunTurns(harness));
  const inspections = await Promise.all(harnesses.map(async (harness) => ({ harness, inspection: await inspectNativeHarnessForPicker(harness) })));
  const installed = inspections.filter((item) => item.inspection.installed);
  return [
    `Installed harnesses (${installed.length}/${inspections.length})`,
    ...installed.map(({ harness, inspection }) => `  ${harness.displayName}${inspection.version ? ` ${inspection.version}` : ''} · ${integrationLabel(harness)}`),
    '',
    `Accounts (${state.accounts.length})`,
    ...(state.accounts.length ? state.accounts.map((account) => `  ${account.label} · ${account.provider} · ${account.status}${account.quotaState === 'exhausted' ? ' · quota exhausted' : ''}`) : ['  none yet — /provider adds one']),
    '',
    `State: ${compactPath(harnessStatePath())}`,
  ].join('\n');
}
