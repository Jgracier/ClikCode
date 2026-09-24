/**
 * What each slash command does, with no terminal involved.
 *
 * Every command has a headless body here that returns text, so the same
 * `/usage` or `/export` works typed into the chat, piped through the control
 * API, or run as an argv subcommand. The implementations the longer ones
 * need live beside this file, one concern each.
 */

import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { stdin as input } from 'node:process';
import type { HarnessSession, HarnessState } from '../../session/model.js';
import { compactPath } from '../../harness/protocol/labels.js';
import { harnessSupportsPermissionMode, localHarnessForCommand, localHarnessForProvider } from '../../runtime/lazy-bridge.js';
import { resolveNativeModel } from '../../harness/accounts/model-catalog.js';
import { harnessCommand } from '../../session/state/paths.js';
import { readState } from '../../session/state/read.js';
import { resolveDefaultSettings } from '../../session/state/settings.js';
import { accountView } from '../../session/state/views.js';
import { writeState } from '../../session/state/write.js';
import { aiAccountLogin, aiAccountLogout, aiAccountRemove, aiDoctor } from '../../commands/account.js';
import { aiSessionSend } from '../../turn/drive.js';
import { emitHarnessOutput } from '../../harness/output.js';
import { SELECTION_MODE, setSelectionMode } from '../modes.js';
import { TERMINAL } from '../active-terminal.js';
import { harnessCanRunTurns } from '../../runtime/lazy-bridge.js';
import { copyToClipboard, decodeAttachmentPath, expandHomePath, queueAttachment } from '../../session/attachments.js';
import { conversationIdFor, normalizeModelWord, requiresProviderHandoff, setSessionHarnessOption, VALID_PERMISSION_MODES } from '../../session/options.js';
import { routeSlashInput, slashControls, slashHelpText, unknownSlashMessage, type SlashHandlerKey } from './registry.js';
import { modelChoicesFor } from './model-choices.js';
import { effortChoicesFor } from '../../harness/accounts/effort-choices.js';
import { impliedHarnessCommand } from './infer-provider.js';
import type { AiHarnessAccount, AiLocalHarnessDefinition } from '../../harness/definition.js';
import { customCommandPrompt } from '../../session/custom-commands.js';
import { sessionTranscriptMessages } from '../../turn/checkpoint.js';
import { newConversationSession, newProviderConversation } from '../../commands/ai/conversations.js';
import { aiHarnessSelect } from '../../commands/ai/harness.js';
import { aiSessionClose, aiSessionLeave, applyFreshLocalSessionPolicy, applyGatewaySessionPolicy, assertRealModel } from '../../commands/ai/sessions.js';
import { aiSettingsClearProvider, aiSettingsSetGlobal, aiSettingsSetProvider } from '../../commands/ai/settings.js';
import { capabilitiesText } from './capabilities-text.js';
import { compactConversation } from './compact.js';
import { customCommandsFor, sessionHarness, slashExtrasFor, slashRouteContextFor } from './context.js';
import { contextUsageText } from './cost.js';
import { usageReport } from './usage-report.js';
import { exportTranscript } from './export-transcript.js';
import { nativeManagerListing } from './native-manager.js';
import { initPrompt, readMemoryFile, reviewPrompt } from './memory.js';
import { addSessionDirectory, changeSessionWorkspace, workspaceDiff } from './workspace.js';
import { isShellCommandLine, runShellCommand, shellMessageContent, type ShellNote } from '../../commands/ai/shell-run.js';

function undoUnavailableMessage(session: HarnessSession): string {
  const harness = sessionHarness(session);
  const who = session.route === 'gateway' ? 'ClikDeploy Gateway' : harness?.displayName ?? 'This provider';
  return `${who} does not expose an undo/rewind operation to ClikCode, so /undo is not available here. ClikCode will not fake it: use /diff to see what changed and git to revert it${harness?.nativeSlashPassthrough ? `, or send the vendor's own command with //rewind` : ''}.`;
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
const SLASH_TURN = { send: (id: string, prompt: string): Promise<void> => aiSessionSend(id, prompt) };

const sendSessionTurn = (id: string, prompt: string): Promise<void> => SLASH_TURN.send(id, prompt);

/** Headless half of the slash registry. Typed by SlashHandlerKey, so a
 * registry entry without a handler here (or a handler without an entry) does
 * not compile; slash-registry.vitest.test.ts asserts the same at runtime. */
const HEADLESS_SLASH_HANDLERS: Record<SlashHandlerKey, HeadlessSlashHandler> = {
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
    // Same as /model: the reported mode described the previous request.
    if (session.reported?.permissionMode) delete session.reported.permissionMode;
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
  select: async ({ words }) => {
    // Mouse tracking is what makes a swipe scroll; it is also what stops the
    // terminal selecting text, because the drag is delivered to ClikCode
    // instead. No setting gives both, so this hands the mouse back on demand.
    const asked = words.join(' ').trim().toLowerCase();
    const active = asked === 'on' ? true : asked === 'off' ? false : !SELECTION_MODE.active;
    if (!TERMINAL.active) {
      throw new Error('Selection mode needs the interactive terminal; there is no mouse to release here.');
    }
    return emitHarnessOutput({ panel: 'select', text: setSelectionMode(active) });
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
    // `changed`: this is the confirmation of an attach or a clear, not the
    // list someone asked to see (that is the no-argument form above).
    return emitHarnessOutput({ panel: 'attachments', attachments: session.attachments ?? [], changed: true });
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
    const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
    // No value: show what there is to choose from, which is what
    // /permissions with no value already does. The interactive session opens
    // a picker before reaching here, so this is the headless answer -- and
    // there, listing the models is strictly more useful than a sentence
    // telling the user to go and list the models.
    //
    // THIS session's provider only, and its own account where it has one.
    // `/model` on a chosen provider is not a question about providers: the
    // conversation runs on one, and a model belonging to another is not a
    // thing this command could set. /models is the cross-provider list.
    if (!value) {
      return emitHarnessOutput({
        panel: 'models',
        models: modelChoicesFor({ ...session, provider: harness?.provider ?? session.provider }, state.accounts),
        selected: session.model,
      });
    }
    if (!harness?.modelArgvPrefix) throw new Error(`${harness?.displayName ?? 'This provider'} does not publish a model selector.`);
    const account = state.accounts.find((item) => item.id === session.accountId);
    // `/model auto` and `/model default` mean "stop overriding", not "store a
    // word no vendor accepts" -- so they RESOLVE to whatever the harness
    // really publishes instead of clearing the field to null. A null here is
    // what used to surface as "automatic", then as "default": a session whose
    // real model nobody could name.
    const requested = normalizeModelWord(value);
    if (requested) await assertRealModel(harness, account, requested);
    const model = requested ?? await resolveNativeModel(harness, account) ?? null;
    if (!model) throw new Error(`${harness.displayName} does not publish any models to choose from.`);
    session.model = model;
    // What the vendor reported running answered the PREVIOUS request. The
    // status line prefers it (a vendor that substitutes a model says so), so
    // left in place it kept naming the old model after this one was chosen,
    // until the next turn happened to report again.
    if (session.reported?.model) delete session.reported.model;
    await keepEffortValidFor(session, harness, account);
    session.updatedAt = new Date().toISOString();
    await writeState(state);
    return emitHarnessOutput({ panel: 'settings', session, account: state.accounts.find((item) => item.id === session.accountId)?.label });
  },
  effort: async ({ state, session, words }) => {
    const value = words.join(' ').trim().toLowerCase();
    const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
    if (!harness) throw new Error('Choose a provider before setting effort.');
    const account = state.accounts.find((item) => item.id === session.accountId);
    setSessionHarnessOption(session, harness, 'effort', value, (await effortChoicesFor(harness, account, session.model)).values);
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
    const harness = sessionHarness(session);
    const report = usageReport(state, session, {
      ...(harness ? { providerName: harness.displayName, providerId: harness.provider } : {}),
    });
    return emitHarnessOutput({ panel: 'usage', text: report.text, totals: report.totals });
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
        // Coming back from the gateway the session has no local model yet. A
        // remembered provider setting wins; otherwise resolve a real one from
        // the harness rather than leaving null for the UI to paper over.
        session.model = state.providerSettings[account.provider]?.model
          ?? await resolveLocalModelFor(account, state) ?? null;
        session.effort = defaults.effort;
        session.permissionMode = defaults.permissionMode;
        session.accountFailover = defaults.accountFailover;
      }
      account.quotaState = 'available';
      account.quotaRetryAt = undefined;
    } else if (setting === 'model') {
      const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
      if (!harness?.modelArgvPrefix) throw new Error(`${harness?.displayName ?? 'This provider'} does not publish a model selector.`);
      const modelAccount = state.accounts.find((item) => item.id === session.accountId);
      const requestedModel = normalizeModelWord(value);
      if (requestedModel) await assertRealModel(harness, modelAccount, requestedModel);
      // Same rule as the /model handler above: clear-words resolve, never null.
      const resolvedModel = requestedModel ?? await resolveNativeModel(harness, modelAccount) ?? null;
      if (!resolvedModel) throw new Error(`${harness.displayName} does not publish any models to choose from.`);
      session.model = resolvedModel;
    } else if (setting === 'effort') {
      const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
      if (!harness) throw new Error('Choose a provider before setting effort.');
      const effortAccount = state.accounts.find((item) => item.id === session.accountId);
      setSessionHarnessOption(session, harness, 'effort', value, (await effortChoicesFor(harness, effortAccount, session.model)).values);
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
        const accountCommand = localHarnessForProvider(account.provider)?.command ?? account.provider;
        // Naming an account of another provider names the provider too, and
        // the switch below already knows how to follow it. The refusal is
        // only right where the move would take a conversation with real
        // content to a different provider -- that always branches, and
        // branching is /<harness>'s decision to make, not a side effect of
        // choosing an account. An empty conversation has nothing to branch,
        // so it simply moves.
        if (selectedHarness && selectedHarness.provider !== account.provider
          && requiresProviderHandoff(session, accountCommand)) {
          throw new Error(`account "${account.label}" belongs to ${account.provider}; use /${accountCommand} to hand this conversation off -- a provider change always branches.`);
        }
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
        // Coming back from the gateway the session has no local model yet. A
        // remembered provider setting wins; otherwise resolve a real one from
        // the harness rather than leaving null for the UI to paper over.
        session.model = state.providerSettings[account.provider]?.model
          ?? await resolveLocalModelFor(account, state) ?? null;
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
    return emitHarnessOutput({ panel: 'provider-selected', harness: 'gateway', displayName: 'ClikDeploy Gateway', provider: 'gateway', account: null, model: 'platform', centralized: true });
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
  export: async ({ session, words }) => {
    const force = words.includes('--force');
    const path = await exportTranscript(session, words.filter((word) => word !== '--force').join(' '), async () => force);
    return emitHarnessOutput({ panel: 'exported', text: `Transcript written to ${compactPath(path)}.`, path });
  },
  cwd: async ({ state, session, args }) => {
    if (!args) return emitHarnessOutput({ panel: 'cwd', text: compactPath(session.workspace ?? process.cwd()), workspace: session.workspace ?? process.cwd() });
    const notice = await changeSessionWorkspace(state, session, args);
    // The new directory is on the status line; this only confirms the change.
    return emitHarnessOutput({ panel: 'cwd', text: notice, workspace: session.workspace, changed: true });
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

/** Moving to a model that does not accept the session's effort level adjusts
 * the level rather than leaving a turn to be rejected. Codex publishes levels
 * per model -- gpt-6-luna stops at `max` where gpt-6-sol has `ultra` -- so a
 * model switch can make a valid setting invalid without the user touching it.
 * The model's own published default is the assumption to make; where there is
 * none, the level is dropped and the vendor applies its own default, rather
 * than ClikCode guessing an order of levels it does not own. Never a question
 * and never a notice: the status line shows the level in use. */
async function keepEffortValidFor(
  session: HarnessSession, harness: AiLocalHarnessDefinition, account: AiHarnessAccount | undefined,
): Promise<void> {
  if (!session.effort || !harness.effortArgvPrefix) return;
  const choices = await effortChoicesFor(harness, account, session.model);
  if (!choices.values.length || choices.values.includes(session.effort)) return;
  // An empty level sends no effort flag at all (every argv builder checks
  // `input.effort &&`), which is exactly "the vendor's own default".
  session.effort = choices.default ?? '';
}

/** A real model for a local account's harness, or undefined when its harness
 * publishes none. Shared by both leavingGateway branches so they cannot
 * disagree about what "no model yet" resolves to. */
async function resolveLocalModelFor(
  account: { provider: string; id: string },
  state: { accounts: { id: string }[] },
): Promise<string | undefined> {
  const harness = localHarnessForProvider(account.provider);
  if (!harness) return undefined;
  return resolveNativeModel(harness, state.accounts.find((item) => item.id === account.id) as never);
}

export async function aiSessionCommand(id: string, input: string, inferred = false): Promise<string> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  const text = input.trim();
  if (!text.replace(/^\/+/, '')) throw new Error('slash command is required');
  // A `!` line is a shell command, not a slash command: run it headlessly and
  // record it as a transcript message the same way the interactive loop does,
  // so piped/argv callers can ask for real machine state too.
  if (isShellCommandLine(text)) {
    const command = text.slice(1).trim();
    if (!command) throw new Error('Type `!<command>` to run it, e.g. `!git status`.');
    const result = await runShellCommand(command, session.workspace ?? process.cwd());
    const note: ShellNote = { command, output: result.output, exitCode: result.exitCode, at: new Date().toISOString() };
    session.messages = [...(session.messages ?? []), { role: 'user', content: shellMessageContent(note) }];
    session.shellNotes = [...(session.shellNotes ?? []), note];
    session.updatedAt = new Date().toISOString();
    await writeState(state);
    emitHarnessOutput({ panel: 'shell', text: shellMessageContent(note) });
    return id;
  }
  const harness = sessionHarness(session);
  const route = routeSlashInput(text.startsWith('/') ? text : `/${text}`, slashRouteContextFor(session, harness));
  if (route.kind === 'command') {
    const availability = route.entry.availability(session, harness);
    // Same as the interactive session: a command that names its provider --
    // `/model claude-opus-5` when only one account publishes that model --
    // selects it and runs, instead of refusing. Once only: a selection that
    // still leaves the command unavailable is a real refusal.
    if (!availability.available && availability.needs === 'provider' && !inferred) {
      const implied = impliedHarnessCommand(route, state.accounts, localHarnessForProvider);
      if (implied) {
        await aiHarnessSelect(implied, id);
        return aiSessionCommand(id, input, true);
      }
    }
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
