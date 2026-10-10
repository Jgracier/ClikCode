/** Adding, choosing and managing the accounts a harness signs in with. */

import { outOfUsageText } from '../../harness/accounts/usage-reading.js';
import { isClikCodeAgent } from '../../session/route.js';
import { loginNativeHarness } from '../../harness/transport/native/login.js';
import type { AiLocalHarnessDefinition } from '../../harness/definition.js';
import type { HarnessPrompter, PickerOption } from '../../harness/prompter.js';
import { nativeProfileEnvironment } from '../../harness/transport/profile-environment.js';
import { localHarnessForProvider } from '../../runtime/lazy-bridge.js';
import { sessionOrProviderHarness } from '../slash/context.js';
import { readState } from '../../session/state/read.js';
import { writeState } from '../../session/state/write.js';
import { accountUsageLabel, cachedAccountUsageLabel } from '../../harness/accounts/account-usage.js';
import { NATIVE_USAGE_PROBES } from '../../harness/accounts/usage-probes.js';
import { aiAccountLogin, aiAccountRemove, signOutAccount, syncAccountIdentityAfterLogin, withSignIn } from '../../commands/account.js';
import type { AiHarnessAccount } from '../../harness/definition.js';
import type { HarnessSession } from '../../session/model.js';
import { accountRow, harnessCanAddAccount } from '../../session/picker-rows.js';
import chalk from 'chalk';
import { aiSessionCommand } from '../slash/handlers.js';
import { hasLocalDisplay, openLoginUrl } from '../../gateway/login/url.js';
import { verificationNotice } from '../../turn/failover.js';
import { chooseOption } from './choose.js';

export type ProviderAccountChoice =
  | { kind: 'account'; harness: string; accountId: string }
  | { kind: 'add-account'; harness: string };

const ACCOUNT_ACTION_LABELS = { reauthenticate: 'Reauthenticate', verified: 'I’ve verified it', disconnect: 'Disconnect', remove: 'Remove' } as const;
const ACCOUNT_PROBLEM_WORDS = { verify: 'verify', 'sign-in': 'not signed in', reauth: 'reauth' } as const;

/** One provider's accounts (picker-rows.ts accountRow) as the terminal shows
 * them, then "+ Add account…" where one can be added. Usage is loaded only
 * after its provider is opened, avoiding a wall of rows and quota probes for
 * providers the user never views. */
export function accountPickerOptions(
  accounts: ReadonlyArray<{ account: AiHarnessAccount; usage?: string; usagePending?: boolean }>,
  session: HarnessSession,
  harness: AiLocalHarnessDefinition,
): PickerOption<ProviderAccountChoice>[] {
  const mine = accounts.filter(({ account }) => account.provider === harness.provider)
    .sort((left, right) => left.account.label.localeCompare(right.account.label));
  return [
    ...mine.map(({ account, usage, usagePending }) => {
      const row = accountRow(account, harness, session);
      const last = row.actions.at(-1);
      const deleteWith = last === 'disconnect' || last === 'remove' ? last : undefined;
      // Never signed in: its one action is to sign in, said so.
      const actionLabel = (value: typeof row.actions[number]): string => (value === 'reauthenticate' && row.problem === 'sign-in' ? 'Sign in' : ACCOUNT_ACTION_LABELS[value]);
      return {
        label: row.label,
        // One state per row: a problem outranks usage, so the eye lands on
        // the single thing that matters. Provider/auth kind is not shown.
        detail: [
          row.problem === 'out-of-usage' ? chalk.yellow(outOfUsageText(row.backAt))
            : row.problem ? chalk.yellow(ACCOUNT_PROBLEM_WORDS[row.problem]) : usage ?? (usagePending ? '…' : ''),
          row.current ? '· current' : '',
        ].filter(Boolean).join(' '),
        value: { kind: 'account' as const, harness: harness.command, accountId: account.id },
        actions: row.actions.filter((value) => value !== deleteWith).map((value) => ({ label: actionLabel(value), value })),
        // Signing out is undone by signing in (/login, or Tab on the row):
        // it runs at once, as /logout does. Removing an account is not, and asks.
        ...(deleteWith ? { deleteAction: { label: ACCOUNT_ACTION_LABELS[deleteWith], value: deleteWith, ...(deleteWith === 'disconnect' ? { undoable: true } : {}) } } : {}),
      };
    }),
    // The only way to connect a second login from inside /account.
    ...(harnessCanAddAccount(harness)
      ? [{ label: '+ Add account…', detail: `· ${harness.displayName}`, value: { kind: 'add-account' as const, harness: harness.command } }]
      : []),
  ];
}

/** Makes the account just added (by label) the conversation's own. */
export async function useAddedAccount(id: string, harness: AiLocalHarnessDefinition, label: string): Promise<string> {
  const state = await readState({ transcripts: [] });
  const added = state.accounts.find((account) => account.provider === harness.provider && account.label === label);
  if (added) await aiSessionCommand(id, `/settings account ${added.id}`);
  return id;
}

export async function interactiveAccountPicker(
  rl: HarnessPrompter,
  id: string,
): Promise<string | undefined> {
  for (;;) {
    const state = await readState({ transcripts: [id] });
    const session = state.sessions.find((item) => item.id === id);
    if (!session) throw new Error(`AI session "${id}" was not found`);
    const harness = sessionOrProviderHarness(session);
    if (!harness || isClikCodeAgent(session)) {
      rl.panel?.('Accounts', 'Choose a local provider before switching accounts.');
      return undefined;
    }
    const providerAccounts = state.accounts.filter((account) => account.provider === harness.provider);
    if (!providerAccounts.length) {
      // Nothing to list: connecting one is the only thing to do here, so do
      // it, rather than naming a command to type.
      const added = await addAccountForHarness(rl, harness);
      return added ? useAddedAccount(id, harness, added) : undefined;
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
    const selected = await chooseOption(
      rl, `${harness.displayName} accounts`, accountOptions(),
      async (choice, action) => {
        if (choice.kind !== 'account') return;
        actionPerformed = true;
        await manageAccountAction(rl, choice.accountId, action);
      },
      // ← is back to whatever opened the list (Settings' row), or closes it,
      // as in every other list.
      { refreshedOptions: accountOptions, refresh: usageRefresh, totalItems: providerAccounts.length },
    );
    if (actionPerformed) continue;
    if (selected?.kind === 'add-account') {
      // The account just connected is the one the user meant to use.
      const added = await addAccountForHarness(rl, harness);
      if (added) return useAddedAccount(id, harness, added);
      continue;
    }
    if (!selected || selected.kind !== 'account') return undefined;
    // Choosing an account the vendor is holding for verification cannot work
    // yet: send the user to the fix instead, and keep them in the list so
    // "I've verified it" (Tab) is one step away.
    // An account the vendor is holding for verification is still selected:
    // the page opens (and is named) so it can be finished, and the next turn
    // that succeeds clears the flag by itself -- no "I've verified it" step.
    // Never signed in: choosing it is signing in to it, now.
    const picked = providerAccounts.find((account) => account.id === selected.accountId);
    if (picked && accountRow(picked, harness, session).problem === 'sign-in') await manageAccountAction(rl, picked.id, 'reauthenticate');
    const pending = picked?.verification;
    if (pending) {
      if (pending.url && hasLocalDisplay()) openLoginUrl(pending.url);
      rl.panel?.('Verify this account', verificationNotice(pending));
    }
    await aiSessionCommand(id, `/settings account ${selected.accountId}`);
    const chosen = providerAccounts.find((account) => account.id === selected.accountId);
    if (chosen) rl.notice?.(`Using ${chosen.label}`);
    return id;
  }
}

export async function addAccountForHarness(rl: HarnessPrompter, harness: AiLocalHarnessDefinition): Promise<string | undefined> {
  // One sign-in for every harness: its own, with a key pasted instead on
  // the same screen where it takes one (native/login.ts accountFirst).
  if (!harness.loginArgv) throw new Error(`${harness.displayName} doesn't publish a login command -- nothing here can add an account for it.`);
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
  return withSignIn(rl, harness.displayName, () => aiAccountLogin(harness.command));
}

/** Maintenance actions are deliberately narrow label/value pairs rather than
 * nested PickerOptions. Non-destructive actions open with Tab; destructive
 * deleteAction values open only from Delete; Remove is confirmed by select(),
 * a sign-out (undone by signing in) is not. */
export async function manageAccountAction(rl: HarnessPrompter, accountId: string, action: string): Promise<void> {
  const state = await readState({ transcripts: [] });
  const account = state.accounts.find((item) => item.id === accountId);
  const harness = account ? localHarnessForProvider(account.provider) : undefined;
  if (!account || !harness) return;
  if (action === 'remove') {
    await aiAccountRemove(account.id);
    return;
  }
  if (action === 'verified') {
    account.verification = undefined;
    await writeState(state);
    return;
  }
  if (account.authKind !== 'vendor-cli') {
    if (action === 'disconnect') throw new Error(`${account.label} is an API key, not a sign-in -- remove it from /account (Del) instead.`);
    return;
  }
  const environment = nativeProfileEnvironment(account.nativeProfile);
  if (action === 'disconnect') {
    await signOutAccount(account.id);
    // Said, and how to undo it: it asked nothing first.
    rl.activity?.(`Signed out of ${account.label} · /login signs back in`);
  } else if (action === 'reauthenticate' && harness.loginArgv) {
    await withSignIn(rl, harness.displayName, () => loginNativeHarness(harness, environment));
    await syncAccountIdentityAfterLogin(harness, account, state);
  }
}
