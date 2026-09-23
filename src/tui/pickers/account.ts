/** Adding, choosing and managing the accounts a harness signs in with. */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import chalk from 'chalk';
import { runNativeHarnessCommand } from '../../harness/transport/native/command.js';
import { loginNativeHarness } from '../../harness/transport/native/login.js';
import type { AiLocalHarnessDefinition } from '../../harness/definition.js';
import type { HarnessPrompter, PickerOption } from '../../harness/prompter.js';
import { nativeProfileEnvironment } from '../../harness/transport/profile-environment.js';
import { localHarnessForCommand, localHarnessForProvider } from '../../runtime/lazy-bridge.js';
import { readState } from '../../session/state/read.js';
import { writeState } from '../../session/state/write.js';
import { accountUsageLabel, cachedAccountUsageLabel } from '../../harness/accounts/account-usage.js';
import { NATIVE_USAGE_PROBES } from '../../harness/accounts/usage-probes.js';
import { aiAccountAdd, aiAccountLogin, aiAccountRemove, announceBareInteractiveLogin, syncAccountIdentityAfterLogin } from '../../commands/account.js';
import { refreshPlaceholderAccountLabels } from '../../harness/accounts/labels.js';
import { TerminalHarnessPrompter } from '../prompter.js';
import { accountPickerOptions, type ProviderAccountChoice } from '../../session/options.js';
import { aiSessionCommand } from '../slash/handlers.js';
import { chooseOption } from './choose.js';

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
    // Accounts named before their harness had identity derivation still carry
    // the invented label. Opening /account is the one moment the user is
    // looking at those names, so it is where they get corrected.
    if (await refreshPlaceholderAccountLabels(state)) await writeState(state);
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
    if (selected?.kind === 'add-account') {
      // Connect one, then come back to the list with it in place rather than
      // dropping the user out of the picker they were working in.
      await addAccountForHarness(rl, harness);
      continue;
    }
    if (!selected || selected.kind !== 'account') return undefined;
    await aiSessionCommand(id, `/settings account ${selected.accountId}`);
    return id;
  }
}

/** Well-known SDK/CLI environment variable names each vendor's own tooling
 * already looks for -- not invented here, just the standard name suggested
 * as a starting point for the env var prompt below. Falls back to a
 * generic <PROVIDER>_API_KEY guess for anything not in this short list. */
const PROVIDER_API_KEY_ENV: Readonly<Record<string, string>> = {
  anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', google: 'GOOGLE_API_KEY', qwen: 'DASHSCOPE_API_KEY',
  // Each read out of the installed binary rather than guessed, because the
  // generic <PROVIDER>_API_KEY fallback gets every one of these wrong:
  // "factory" is not FACTORY's provider word in its own env, and command-code
  // would become COMMAND_CODE_API_KEY only by luck.
  amp: 'AMP_API_KEY',            // `amp --help`
  cursor: 'CURSOR_API_KEY',      // `cursor-agent --help`
  factory: 'FACTORY_API_KEY',    // present in the droid bundle
  'command-code': 'COMMAND_CODE_API_KEY', // satisfies cmdc's own auth gate, used to drive a real turn
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
