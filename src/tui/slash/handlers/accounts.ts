import { aiSessionCommand } from '../handlers.js';
/** /accounts, /login, /logout, /doctor and /gateway: who the conversation runs as. */
import { isClikCodeAgent } from '../../../session/route.js';
import { releaseHeldLocalModel } from '../../../commands/ai/local-model.js';
import { localHarnessForCommand, localHarnessForProvider, harnessCanRunTurns } from '../../../runtime/lazy-bridge.js';
import { resolveNativeModel } from '../../../harness/accounts/model-catalog.js';
import { harnessCommand } from '../../../session/state/paths.js';
import { resolveDefaultSettings } from '../../../session/state/settings.js';
import { accountView } from '../../../session/state/views.js';
import { writeState } from '../../../session/state/write.js';
import { aiAccountLogin, aiAccountLogout, aiAccountRemove, aiDoctor } from '../../../commands/account.js';
import { emitHarnessOutput } from '../../../harness/output.js';
import type { SlashHandlerKey } from '../registry.js';
import { sessionTranscriptMessages } from '../../../turn/checkpoint.js';
import { moveToProvider } from '../../../commands/ai/conversations.js';
import { applyFreshLocalSessionPolicy, applyGatewaySessionPolicy } from '../../../commands/ai/sessions.js';
import { sessionHarness } from '../context.js';
import { clearQuotaMark } from '../../../harness/accounts/usage-reading.js';
import { forgetNativeThread } from '../../../session/native-thread.js';
import type { HeadlessSlashHandler } from './shared.js';

/** A real model for a local account's harness, or undefined when its harness
 * publishes none. Shared by both leavingAgentRoute branches so they cannot
 * disagree about what "no model yet" resolves to. */
async function resolveLocalModelFor(
  account: { provider: string; id: string },
  state: { accounts: { id: string }[] },
): Promise<string | undefined> {
  const harness = localHarnessForProvider(account.provider);
  if (!harness) return undefined;
  return resolveNativeModel(harness, state.accounts.find((item) => item.id === account.id) as never);
}

export const accountsHandlers = {
  accounts: async ({ id, state, session, words }) => {
    // `/account work` and `/accounts use work` are one command: a word that
    // is not an action is the account to use.
    const ACTIONS = ['use', 'select', 'login', 'add', 'remove', 'rm'];
    const action = words.length && !ACTIONS.includes(words[0]!.toLowerCase()) ? 'use' : words.shift()?.toLowerCase();
    if (action === 'use' || action === 'select') {
      const labelOrId = words.join(' ').trim();
      if (!labelOrId) throw new Error('usage: /accounts use <label-or-id>');
      const account = state.accounts.find((item) => item.id === labelOrId || item.label.toLowerCase() === labelOrId.toLowerCase());
      if (!account) throw new Error(`No account named "${labelOrId}" -- /account lists them`);
      // Leaving either agent route: an account means a vendor harness.
      const leavingAgentRoute = isClikCodeAgent(session);
      if (session.route === 'clikcode-local') await releaseHeldLocalModel(session.id);
      if (leavingAgentRoute) applyFreshLocalSessionPolicy(state, session);
      if (session.nativeHarness) {
        const selectedHarness = localHarnessForCommand(session.nativeHarness);
        const accountCommand = localHarnessForProvider(account.provider)?.command ?? account.provider;
        // Naming an account of another provider names the provider too: the
        // conversation moves there -- the move /<harness> makes -- and then
        // takes the account named.
        if (selectedHarness && selectedHarness.provider !== account.provider) {
          await moveToProvider(id, accountCommand);
          await aiSessionCommand(id, `/accounts use ${account.id}`);
          return id;
        }
      }
      const accountHarness = localHarnessForProvider(account.provider);
      if (accountHarness && harnessCanRunTurns(accountHarness) && session.nativeHarness !== accountHarness.command) {
        session.nativeHarness = accountHarness.command;
        forgetNativeThread(session);
      }
      // A native thread lives in the profile of the account that wrote it
      // (`nativeThreadAccountId`), so `--resume` under another account's
      // profile finds nothing. This only records the pick: this process is not
      // the one running the turn, and a thread moved here while that turn has
      // it open would race its file. The conversation's next model call --
      // mid-turn at the next call boundary, or the next turn -- moves it
      // (turn/vendor-turn.ts settleThread).
      session.accountId = account.id;
      // Explicit selection is the user's retry signal for an account previously
      // marked exhausted: it is tried now rather than when the mark expires.
      clearQuotaMark(account);
      session.provider = account.provider;
      session.route = 'local';
      if (leavingAgentRoute) {
        const defaults = resolveDefaultSettings(state, account.provider);
        // Coming back from the gateway the session has no local model yet. A
        // remembered provider setting wins; otherwise resolve a real one from
        // the harness rather than leaving null for the UI to paper over.
        session.model = state.providerSettings[account.provider]?.model
          ?? await resolveLocalModelFor(account, state) ?? null;
        session.effort = defaults.effort;
        session.permissionMode = defaults.permissionMode;
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
      if (knownHarness) { await aiAccountLogin(knownHarness.command, words.join(' ') || undefined); return; }
      return emitHarnessOutput({ panel: 'add-account', provider, next: `${harnessCommand()} accounts add --provider ${provider} --label <label> --auth api-key|vendor-cli --credential-ref <local-reference>`, credentialBoundary: 'local-only' });
    }
    return emitHarnessOutput({ panel: 'accounts', session, accounts: state.accounts.map(accountView), controls: ['use <label-or-id>', 'login <harness> [label]', 'add <harness> [label]', 'remove <label-or-id>'] });
  },
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
  doctor: async () => aiDoctor(),
  gateway: async ({ state, session }) => {
    if (sessionTranscriptMessages(session).length || session.nativeSessionId) {
      throw new Error('Use the interactive /provider menu to hand off an existing conversation to ClikDeploy Gateway.');
    }
    applyGatewaySessionPolicy(session, state);
    session.updatedAt = new Date().toISOString();
    await writeState(state);
    return emitHarnessOutput({ panel: 'provider-selected', harness: 'gateway', displayName: 'ClikDeploy Gateway', provider: 'gateway', account: null, model: 'platform', centralized: true });
  },
} satisfies Partial<Record<SlashHandlerKey, HeadlessSlashHandler>>;
