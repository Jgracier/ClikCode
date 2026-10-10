/**
 * What each slash command does, with no terminal involved.
 *
 * Every command has a headless body here that returns text, so the same
 * `/usage` or `/export` works typed into the chat, piped through the control
 * API, or run as an argv subcommand. The implementations the longer ones
 * need live beside this file, one concern each.
 */

import { stripVTControlCharacters } from 'node:util';
import { searchConversations } from '../../search/engine.js';
import { searchResultsText } from '../../search/navigate.js';
import { clikCodeAgentLabel, isAiHarnessRoute, isClikCodeAgent, isGatewayService, ROUTE_CHOICES_TEXT } from '../../session/route.js';
import { hermesTurboFitModelId } from '../../harness/accounts/hermes-discovery.js';
import { isTurboFitModel } from '../../harness/accounts/turbofit-local.js';
import { turboFitModelChanged } from '../../commands/ai/turbofit.js';
import { localModelChosen, releaseHeldLocalModel } from '../../commands/ai/local-model.js';
import { localModelChoices } from '../../local-models/index.js';
import { resolveLocalModelId } from '../../local-models/catalog.js';
import { catalogModel } from '../../local-models/catalog.js';
import { missingBytes } from '../../local-models/models.js';
import { formatBytes } from '../../local-models/download.js';
import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import type { HarnessSession, HarnessState } from '../../session/model.js';
import { compactPath } from '../../harness/protocol/labels.js';
import { harnessSupportsEffort, harnessSupportsModelSelection, localHarnessForCommand, localHarnessForProvider, modelIdFromDisplay } from '../../runtime/lazy-bridge.js';
import { harnessModelLabel, nativeModelCatalogForPicker, resolveNativeModel } from '../../harness/accounts/model-catalog.js';
import { harnessCommand } from '../../session/state/paths.js';
import { readState } from '../../session/state/read.js';
import { resolveDefaultSettings } from '../../session/state/settings.js';
import { accountView } from '../../session/state/views.js';
import { writeState } from '../../session/state/write.js';
import { aiAccountLogin, aiAccountLogout, aiAccountRemove, aiDoctor } from '../../commands/account.js';
import Conf from 'conf';
import { sendScriptedTurn } from '../../worker/scripted-send.js';
import { emitHarnessOutput, renderSessionCard } from '../../harness/output.js';
import { SELECTION_MODE, setSelectionMode } from '../modes.js';
import { TERMINAL } from '../active-terminal.js';
import { parseSendMode, sendModeOf, SEND_MODE_DETAIL, SEND_MODES } from '../../turn/send-mode.js';
import { harnessCanRunTurns } from '../../runtime/lazy-bridge.js';
import { copyToClipboard, decodeAttachmentPath, expandHomePath, queueAttachment } from '../../session/attachments.js';
import { normalizeModelWord, sessionPermissionModes, setSessionHarnessOption } from '../../session/options.js';
import { conversationIdFor } from '../../session/conversation-rows.js';
import { routeSlashInput, slashControls, slashHelpText, unknownSlashMessage, type SlashHandlerKey, type SlashRoute } from './registry.js';
import { modelChoicesFor } from './model-choices.js';
import { effortChoicesFor } from '../../harness/accounts/effort-choices.js';
import { swarmIsOn } from '../../swarm/policy.js';
import { parseSandboxMode, sandboxModeText, sessionSandboxMode } from '../../agent/sandbox.js';

import { impliedHarnessCommand } from './infer-provider.js';
import type { AiHarnessAccount, AiHarnessPermissionMode, AiLocalHarnessDefinition } from '../../harness/definition.js';
import { customCommandPrompt } from '../../session/custom-commands.js';
import { sessionTranscriptMessages } from '../../turn/checkpoint.js';
import { textTranscript } from '../../turn/turn-activities.js';
import { moveToProvider, newConversationSession } from '../../commands/ai/conversations.js';
import { aiHarnessSelect } from '../../commands/ai/harness.js';
import { aiSessionClose, aiSessionLeave, applyClikCodeAgentSessionPolicy, applyFreshLocalSessionPolicy, applyGatewaySessionPolicy, assertRealModel, chooseGatewayModel } from '../../commands/ai/sessions.js';
import { gatewayModelDetail, gatewayModelLabel, gatewayModels, isAutomaticModelWord } from '../../gateway/models.js';
import { aiSettingsClearProvider, aiSettingsSetGlobal, aiSettingsSetProvider } from '../../commands/ai/settings.js';
import { capabilitiesText } from './capabilities-text.js';
import { compactConversation } from './compact.js';
import { customCommandsFor, sessionHarness, slashExtrasFor, slashRouteContextFor } from './context.js';
import { contextUsageText } from './cost.js';
import { usageReport, usageReportAll } from './usage-report.js';
import { forkPoint, messagesThrough } from './fork-at.js';
import { exportTranscript } from './export-transcript.js';
import { nativeManagerListing } from './native-manager.js';
import { initPrompt, readMemoryFile, reviewPrompt } from './memory.js';
import { addSessionDirectory, changeSessionWorkspace, workspaceDiff } from './workspace.js';
import { isShellCommandLine, runShellCommand, shellMessageContent, type ShellNote } from '../../commands/ai/shell-run.js';
import { clearQuotaMark } from '../../harness/accounts/usage-reading.js';
import { GATEWAY_DEFAULT_EFFORT, GATEWAY_EFFORTS } from '../../gateway/options.js';
import { cliThreadTransport } from '../../harness/transport/select.js';
import { forgetNativeThread } from '../../session/native-thread.js';
import { undoTurnsBack } from '../../session/undo-turn.js';
import { redoFrom } from '../../session/redo.js';
import { readTurnChanges, turnChangesAgo, turnChangesDiff, turnChangesList } from '../../session/turn-changes.js';
import { stateDirectory } from '../../session/store/paths.js';

/** What /copy copies: the conversation's last answer. */
export function lastAnswer(session: HarnessSession): string {
  const last = textTranscript(sessionTranscriptMessages(session)).reverse().find((message) => message.role === 'assistant');
  if (!last) throw new Error('There is no assistant response to copy yet.');
  return last.content;
}

/** A setting changed: stamp the session, store the state, and show the
 * settings panel -- in the terminal, the status line it re-renders. */
async function saveSettings(state: HarnessState, session: HarnessSession): Promise<void> {
  session.updatedAt = new Date().toISOString();
  await writeState(state);
  return emitHarnessOutput({ panel: 'settings', session, account: state.accounts.find((item) => item.id === session.accountId)?.label });
}


/** `/model` on ClikCode Local. With no name, fitting local and Hub models;
 * with one, download consent is required before it is loaded and answering, and
 * the session moves to it -- a failure (it does not fit, a download failed)
 * leaves the session on the model it had. */
async function localModelCommand(session: HarnessSession, value: string): Promise<void> {
  if (!value) {
    const choices = await localModelChoices();
    return emitHarnessOutput({
      panel: 'models',
      models: choices.map((choice) => ({
        model: choice.id, provider: [choice.label, choice.recommended ? 'recommended' : undefined, choice.detail].filter(Boolean).join(' · '),
        label: choice.label, detail: choice.detail, fits: choice.fits, recommended: choice.recommended,
      })),
      selected: session.model,
    });
  }
  const explicitDownload = value.startsWith('--download ');
  const model = resolveLocalModelId(explicitDownload ? value.slice('--download '.length) : value);
  const entry = catalogModel(model)!;
  const bytes = await missingBytes([entry.weights]);
  if (bytes && !explicitDownload) {
    if (!TERMINAL.active?.select) {
      throw new Error(`${entry.label} needs a ${formatBytes(bytes)} download. Run /model --download ${model} to authorize it.`);
    }
    const confirmed = await TERMINAL.active.select(`Download ${entry.label} (${formatBytes(bytes)})?`, [
      { label: 'Cancel', value: false }, { label: `Download ${formatBytes(bytes)}`, value: true },
    ]);
    if (!confirmed) return;
  }
  await localModelChosen(session.id, model);
  // Re-read: loading a model can take a minute, and the turn worker or
  // another command may have written the state since this command read it.
  const state = await readState({ transcripts: [session.id] });
  const current = state.sessions.find((item) => item.id === session.id);
  if (!current) throw new Error(`AI session "${session.id}" was not found`);
  current.model = model;
  if (current.reported?.model) delete current.reported.model;
  return saveSettings(state, current);
}

/** What one slash command did, for a caller that must follow it. */
interface HeadlessSlashContext {
  id: string; state: HarnessState; session: HarnessSession;
  /** Canonical registry name (aliases already resolved). */
  head: string; args: string; words: string[];
}

/** Resolves with the resulting session id when the command moved the
 * conversation to another session (`/new`, `/fork`), otherwise nothing. */
type HeadlessSlashHandler = (context: HeadlessSlashContext) => Promise<string | void>;

const INTERACTIVE_ONLY = (name: string): HeadlessSlashHandler => async () => {
  throw new Error(`/${name} opens a picker and is only available in the interactive ClikCode session.`);
};

/** A turn a slash command sends, through the conversation's worker when one
 * is running -- any route, the Gateway and ClikCode Local included. */
const sendSessionTurn = (id: string, prompt: string): Promise<void> => (
  sendScriptedTurn(new Conf({ projectName: 'clikcode', configFileMode: 0o600 }), id, prompt)
);

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
    // `text` too: the card as plain lines, for a surface that draws a
    // panel's text (VS Code) rather than the session it carries.
    return emitHarnessOutput({ panel: 'status', session, account, text: stripVTControlCharacters(renderSessionCard(session, account)) });
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
    const value = words.shift()?.toLowerCase();
    // ClikCode's own agent implements every mode itself; a vendor harness
    // only the ones it carries to a real flag.
    const agent = isClikCodeAgent(session);
    const harness = !agent && session.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
    if (!agent && !harness) throw new Error('Choose a provider before setting permissions.');
    const controls = sessionPermissionModes(session, harness);
    if (!value) {
      if (!controls.length) throw new Error(`${harness!.displayName} does not map ClikCode's permission modes to a real flag.`);
      return emitHarnessOutput({ panel: 'permissions', session, controls });
    }
    if (agent) {
      if (!controls.includes(value as AiHarnessPermissionMode)) throw new Error('permissions must be ask, bypass, or auto');
      session.permissionMode = value as AiHarnessPermissionMode;
    } else setSessionHarnessOption(session, harness!, 'permissions', value);
    // Same as /model: the reported mode described the previous request.
    if (session.reported?.permissionMode) delete session.reported.permissionMode;
    return saveSettings(state, session);
  },
  sandbox: async ({ state, session, words }) => {
    if (!isClikCodeAgent(session)) throw new Error("The sandbox applies to ClikCode's own agent; a vendor harness sandboxes its own commands.");
    if (!words[0]) {
      const current = sessionSandboxMode(session.sandbox);
      return emitHarnessOutput({ panel: 'sandbox', sandbox: current, text: sandboxModeText(current), controls: ['sandbox on', 'sandbox off'] });
    }
    const mode = words.length === 1 ? parseSandboxMode(words[0]) : undefined;
    if (!mode) throw new Error('usage: /sandbox [on|off]');
    // On is the default, so it is stored as no value; off is the explicit choice.
    if (mode === 'off') session.sandbox = 'off';
    else delete session.sandbox;
    return saveSettings(state, session);
  },
  // Global, not this chat's: how mid-turn messages go is the user's habit.
  // The worker reads it as each message arrives (session-worker.ts).
  send: async ({ state, words }) => {
    if (!words[0]) {
      const current = sendModeOf(state.globalSettings);
      return emitHarnessOutput({ panel: 'send', sendMode: current, text: `Messages typed mid-turn: ${current} · ${SEND_MODE_DETAIL[current]}`, controls: SEND_MODES.map((mode) => `send ${mode}`) });
    }
    const mode = parseSendMode(words[0]);
    await aiSettingsSetGlobal('send', mode, false);
    return emitHarnessOutput({ panel: 'settings-updated', sendMode: mode, text: `Messages typed mid-turn: ${mode}` });
  },
  search: async ({ args }) => {
    if (!args.trim()) throw new Error('usage: /search <words>');
    const result = await searchConversations(args);
    if (!result) throw new Error('usage: /search <words>');
    return emitHarnessOutput({
      panel: 'search', query: result.query.text, text: searchResultsText(result),
      results: result.hits.map((hit) => ({
        conversationId: hit.conversationId, sessionId: hit.sessionId, title: hit.title, provider: hit.provider, model: hit.model,
        updatedAt: hit.updatedAt, mentions: hit.mentions.length, exact: hit.exactCount,
        first: hit.mentions[0] ? { sessionId: hit.mentions[0].sessionId, messageIndex: hit.mentions[0].messageIndex } : undefined,
      })),
    });
  },
  history: async ({ session }) => {
    return emitHarnessOutput({ panel: 'history', messages: textTranscript(sessionTranscriptMessages(session)) });
  },
  copy: async ({ session }) => {
    const via = await copyToClipboard(lastAnswer(session));
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
    const diff = await workspaceDiff(session.workspace ?? process.cwd());
    return emitHarnessOutput(diff === undefined ? { panel: 'diff', text: 'Not a git repository' } : { panel: 'diff', diff });
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
  delete: async ({ id, state, words }) => {
    if (words[0]?.toLowerCase() !== 'confirm') throw new Error('Use /delete confirm to permanently delete this ClikCode conversation. Provider-owned history is not deleted.');
    state.sessions = state.sessions.filter((item) => item.id !== id);
    await writeState(state);
    return emitHarnessOutput({ panel: 'session-deleted', text: 'Conversation deleted from ClikCode.' });
  },
  fork: async ({ state, session, words }) => {
    // `/fork @N [name]`: only through user message N and its answer. Stored
    // as a reference into this conversation's history (TranscriptRef).
    const at = forkPoint(words[0]);
    if (at !== undefined) words.shift();
    const messages = sessionTranscriptMessages(session);
    const now = new Date().toISOString();
    const fork: HarnessSession = {
      ...session, id: randomUUID(), name: words.join(' ').trim() || (session.name ? `${session.name} (fork)` : undefined),
      conversationId: conversationIdFor(session), parentSessionId: session.id, fork: true,
      messages: at === undefined ? messages : messagesThrough(messages, at), pendingTurn: undefined,
      // No vendor thread: the next turn replays the kept messages to rebuild
      // the context, so a fork at N does not carry what came after it.
      nativeSessionId: undefined, nativeStartedAt: undefined, createdAt: now, updatedAt: now, status: 'active', closedAt: undefined,
    };
    // A turn parked for the reset is the original's to send.
    delete fork.resumeAt;
    state.sessions.push(fork);
    await writeState(state);
    // The fork is where the user goes next: returning its id switches to it.
    const text = at === undefined
      ? `Forked as ${fork.id.slice(0, 8)} -- you are in the fork; the original is still in your conversations.`
      : `Forked after message ${at} as ${fork.id.slice(0, 8)} -- you are in the fork; the original is still in your conversations. Files on disk are not rewound: /changes lists what each turn edited, /undo takes it back.`;
    emitHarnessOutput({ panel: 'session-forked', text, session: fork });
    return fork.id;
  },
  model: async ({ state, session, words }) => {
    // `--any`: an id typed on purpose (the picker's "Enter a model ID…") is
    // taken as given. The published-list check catches a typo in `/model x`;
    // it made "Enter a model ID…" able to enter only ids already listed.
    const trusted = words[0] === '--any';
    if (trusted) words.shift();
    const value = words.join(' ').trim();
    if (session.route === 'clikcode-local') return localModelCommand(session, value);
    // A Gateway conversation chooses from the Gateway's own list; `auto` hands
    // the choice back to it. The Gateway serves the model from its cheapest
    // provider -- subscription, then free, then paid -- and never another model.
    if (isGatewayService(session)) {
      if (!value) {
        const { models, automatic } = await gatewayModels();
        return emitHarnessOutput({
          panel: 'models',
          // The model and its price only: which provider serves it is the Gateway's decision.
          models: models.map((model) => ({ model: model.id, label: gatewayModelLabel(model), price: gatewayModelDetail(model) })),
          selected: session.model ?? automatic,
        });
      }
      session.model = trusted && !isAutomaticModelWord(value) ? value : await chooseGatewayModel(value);
      // The model that answered last was answering the previous choice.
      if (session.reported?.model) delete session.reported.model;
      return saveSettings(state, session);
    }
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
      const account = state.accounts.find((item) => item.id === session.accountId);
      const catalog = harness ? await nativeModelCatalogForPicker(harness, account) : undefined;
      return emitHarnessOutput({
        panel: 'models',
        models: catalog && harness
          ? catalog.models.map((model) => ({ account: account?.label ?? 'automatic', provider: harness.provider, model, label: harnessModelLabel(harness, model) }))
          : modelChoicesFor({ ...session, provider: harness?.provider ?? session.provider }, state.accounts),
        selected: session.model,
      });
    }
    if (!harness || !harnessSupportsModelSelection(harness)) throw new Error(`${harness?.displayName ?? 'This provider'} does not publish a model selector.`);
    const account = state.accounts.find((item) => item.id === session.accountId);
    // `/model auto` and `/model default` mean "stop overriding", not "store a
    // word no vendor accepts" -- so they RESOLVE to whatever the harness
    // really publishes instead of clearing the field to null. A null here is
    // what used to surface as "automatic", then as "default": a session whose
    // real model nobody could name.
    // Typed the way the picker shows it (`claude-code:sonnet`), stored the
    // way the harness takes it (`claude-code/sonnet`).
    const typed = normalizeModelWord(harness ? modelIdFromDisplay(harness, value) : value);
    const asked = typed && harness?.turboFit ? hermesTurboFitModelId(typed) : typed;
    const requested = asked && !trusted ? await assertRealModel(harness, account, asked) : asked;
    const model = requested ?? await resolveNativeModel(harness, account) ?? null;
    if (!model) throw new Error(`${harness.displayName} does not publish any models to choose from.`);
    // A TurboFit model is running before it is chosen: if its setup fails,
    // the session keeps the model it had.
    const previous = session.model;
    if (isTurboFitModel(model)) await turboFitModelChanged(harness, account, session.id, previous, model);
    session.model = model;
    // What the vendor reported running answered the PREVIOUS request. The
    // status line prefers it (a vendor that substitutes a model says so), so
    // left in place it kept naming the old model after this one was chosen,
    // until the next turn happened to report again.
    if (session.reported?.model) delete session.reported.model;
    await keepEffortValidFor(session, harness, account);
    session.updatedAt = new Date().toISOString();
    await writeState(state);
    if (!isTurboFitModel(model)) await turboFitModelChanged(harness, account, session.id, previous, model);
    return emitHarnessOutput({ panel: 'settings', session, account: state.accounts.find((item) => item.id === session.accountId)?.label });
  },
  effort: async ({ state, session, words }) => {
    const value = words.join(' ').trim().toLowerCase();
    if (isGatewayService(session)) {
      if (value !== 'default' && !(GATEWAY_EFFORTS as readonly string[]).includes(value)) {
        throw new Error(`usage: /effort <${['default', ...GATEWAY_EFFORTS].join('|')}>`);
      }
      session.effort = value === 'default' ? GATEWAY_DEFAULT_EFFORT : value;
      return saveSettings(state, session);
    }
    const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
    if (!harness) throw new Error('Choose a provider before setting effort.');
    const account = state.accounts.find((item) => item.id === session.accountId);
    // `default`: no level sent, so the harness uses its own (drive sends the
    // flag only for a non-empty effort).
    if (value === 'default') session.effort = '';
    else setSessionHarnessOption(session, harness, 'effort', value, (await effortChoicesFor(harness, account, session.model)).values);
    return saveSettings(state, session);
  },
  fast: async ({ state, session, words }) => {
    if (!isGatewayService(session)) throw new Error('Speed is a ClikDeploy Gateway choice: it picks among the providers of one model.');
    const value = words.join(' ').trim().toLowerCase();
    const on = value === '' ? session.speed !== 'fast' : value === 'on' ? true : value === 'off' ? false : undefined;
    if (on === undefined) throw new Error('usage: /fast [on|off]');
    if (on) session.speed = 'fast';
    else delete session.speed;
    return saveSettings(state, session);
  },
  swarm: async ({ state, session, words }) => {
    const asked = words.map((word) => word.toLowerCase()).filter(Boolean);
    const word = asked.length === 0 ? (swarmIsOn(session) ? 'off' : 'on') : asked.length === 1 ? asked[0] : '';
    if (word !== 'on' && word !== 'off') throw new Error('usage: /swarm [on|off]');
    if (word === 'off') delete session.swarm;
    else session.swarm = true;
    await saveSettings(state, session);
  },
  sessions: async ({ state, words }) => {
    const action = words.shift()?.toLowerCase();
    const targetId = words.shift();
    if (action === 'close') {
      if (!targetId) throw new Error('usage: /sessions close <id>');
      return aiSessionClose(targetId);
    }
    if (action === 'show' || action === 'open' || action === 'resume') {
      if (!targetId) throw new Error(`usage: /sessions ${action} <id>`);
      const target = (await readState({ transcripts: [targetId] })).sessions.find((item) => item.id === targetId);
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
  usage: async ({ state, session, words }) => {
    if (words[0]?.toLowerCase() === 'all') {
      const report = usageReportAll(state, session, { providerName: (provider) => localHarnessForProvider(provider)?.displayName ?? provider });
      return emitHarnessOutput({ panel: 'usage', text: report.text });
    }
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
      if (!key || !rest.length) throw new Error('usage: /settings global <effort|permissions|send> <value>');
      await aiSettingsSetGlobal(key, rest.join(' '), false);
      return emitHarnessOutput({ panel: 'settings-updated', text: `Global default updated: ${key} = ${rest.join(' ')}` });
    }
    if (setting === 'provider') {
      const [providerId, key, ...rest] = words;
      if (!providerId || !key) throw new Error('usage: /settings provider <id> <model|effort|permissions> <value>, or /settings provider <id> clear');
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
      if (!isAiHarnessRoute(value)) throw new Error(ROUTE_CHOICES_TEXT);
      // Leaving ClikCode Local lets go of its model at once, not at the
      // interactive loop's next pass.
      if (session.route === 'clikcode-local' && value !== 'clikcode-local') await releaseHeldLocalModel(session.id);
      if (value === 'gateway' || value === 'clikcode-local') applyClikCodeAgentSessionPolicy(session, value);
      else if (isClikCodeAgent(session)) applyFreshLocalSessionPolicy(state, session);
      else session.route = 'local';
    } else if (setting === 'account' || setting === 'model' || setting === 'effort' || setting === 'permissions' || setting === 'permission') {
      // One way to set each, with that command's checks. The copies here had
      // fewer: /settings account moved a conversation with content to another
      // harness, and /settings model kept an effort the new model rejects.
      const command = setting === 'account' ? 'accounts use' : setting === 'permission' ? 'permissions' : setting;
      return aiSessionCommand(id, `/${command} ${value}`);
    } else if (setting === 'option') {
      const [optionId, ...optionValue] = value.split(/\s+/);
      const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
      if (!harness || !optionId || !optionValue.length) throw new Error('usage: /settings option <id> <value|default>');
      // `default` clears it: nothing is sent, the harness decides.
      if (optionValue.join(' ') === 'default') {
        const { [optionId]: _cleared, ...rest } = session.harnessOptions ?? {};
        session.harnessOptions = rest;
      } else setSessionHarnessOption(session, harness, optionId, optionValue.join(' '));
    } else if (setting === 'native-session') {
      if (!session.nativeHarness) throw new Error('select a native harness before attaching its session id');
      const selectedHarness = localHarnessForCommand(session.nativeHarness);
      if (!selectedHarness?.session?.resumeIdPrefix) throw new Error(`${selectedHarness?.displayName ?? session.nativeHarness} does not support exact session resume`);
      session.nativeSessionId = value;
      delete session.nativeSessionPreallocated;
      // An id given by hand is the vendor CLI's: the thread stays on it.
      const pinned = cliThreadTransport(selectedHarness);
      if (pinned) session.nativeTransport = pinned;
      else delete session.nativeTransport;
    } else {
      throw new Error(`unknown setting: ${setting}`);
    }
    return saveSettings(state, session);
  },
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
      if (knownHarness?.surface === 'terminal') { await aiAccountLogin(knownHarness.command, words.join(' ') || undefined); return; }
      return emitHarnessOutput({ panel: 'add-account', provider, next: `${harnessCommand()} accounts add --provider ${provider} --label <label> --auth api-key|vendor-cli --credential-ref <local-reference>`, credentialBoundary: 'local-only' });
    }
    return emitHarnessOutput({ panel: 'accounts', session, accounts: state.accounts.map(accountView), controls: ['use <label-or-id>', 'login <harness> [label]', 'add <harness> [label]', 'remove <label-or-id>'] });
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
  init: (context) => HEADLESS_SLASH_HANDLERS.review(context),
  redraw: async () => emitHarnessOutput({ panel: 'redraw', text: 'Nothing to repaint outside the interactive session.' }),
  exit: async ({ id }) => aiSessionLeave(id),
  provider: INTERACTIVE_ONLY('provider'),
  resume: INTERACTIVE_ONLY('resume'),
  options: INTERACTIVE_ONLY('options'),
  capabilities: async ({ session }) => emitHarnessOutput({ panel: 'capabilities', text: capabilitiesText(session) }),
  native: async ({ id, session, args }) => {
    if (!args) throw new Error('usage: /native <text>  (or //text)');
    if (isClikCodeAgent(session)) throw new Error('Native harness commands apply only to local harnesses.');
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
  changes: async ({ session, words }) => {
    const records = await readTurnChanges(stateDirectory(), session.id);
    if (!words[0]) return emitHarnessOutput({ panel: 'changes', text: turnChangesList(records, session.workspace) });
    const n = Number(words[0]);
    const record = turnChangesAgo(records, n);
    if (!record) throw new Error(records.length ? `usage: /changes [N]  -- N from 1 (the last turn) to ${records.length}` : 'No turns recorded yet in this conversation.');
    return emitHarnessOutput({ panel: 'changes', text: turnChangesDiff(record, n, session.workspace), diff: record.changes });
  },
  redo: async ({ state, session, words }) => {
    const n = forkPoint(words[0]);
    if (n === undefined) throw new Error('usage: /redo @N [keep]  -- N as /fork numbers your prompts; keep leaves files as they are');
    const who = isClikCodeAgent(session) ? clikCodeAgentLabel(session) : sessionHarness(session)?.displayName ?? 'This provider';
    const redone = await redoFrom(state, session, n, { keepFiles: words[1] === 'keep', stateDir: stateDirectory(), who });
    await writeState(state);
    return emitHarnessOutput({ panel: 'redo', text: redone.text, prompt: redone.prompt });
  },
  undo: async ({ session, words }) => {
    const who = isClikCodeAgent(session) ? clikCodeAgentLabel(session) : sessionHarness(session)?.displayName ?? 'This provider';
    // `/undo N`: the last N turns, as /changes numbers them.
    const back = words[0] ? Number(words[0]) : 1;
    if (!Number.isInteger(back) || back < 1) throw new Error('usage: /undo [N]  -- N turns back, as /changes numbers them');
    const undone = await undoTurnsBack(session, back, { stateDir: stateDirectory(), who });
    return emitHarnessOutput({ panel: 'undo', text: undone.text, restored: undone.restored, removed: undone.removed, conflicts: undone.conflicts });
  },
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
  if (!session.effort || !harnessSupportsEffort(harness)) return;
  const choices = await effortChoicesFor(harness, account, session.model);
  if (!choices.values.length || choices.values.includes(session.effort)) return;
  // An empty level sends no effort flag at all (every argv builder checks
  // `input.effort &&`), which is exactly "the vendor's own default".
  session.effort = choices.default ?? '';
}

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

/** `!<command>`: run exactly what was typed in the chat's workspace, and
 * record its output as a transcript message (so the model sees it next turn)
 * and a shell note (so a resumed native-harness thread, which never replays
 * ClikCode's transcript, still does; see shellContextBlock in
 * turn/session-turn.ts). `signal` kills the command's process tree. */
export async function runShellLine(id: string, command: string, signal?: AbortSignal): Promise<ShellNote> {
  const workspace = (await readState({ transcripts: [] })).sessions.find((item) => item.id === id)?.workspace ?? process.cwd();
  const result = await runShellCommand(command, workspace, signal);
  const note: ShellNote = { command, output: result.output, exitCode: result.exitCode, at: new Date().toISOString() };
  const state = await readState({ transcripts: [id] });
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  session.messages = [...(session.messages ?? []), { role: 'user', content: shellMessageContent(note) }];
  session.shellNotes = [...(session.shellNotes ?? []), note];
  session.updatedAt = new Date().toISOString();
  await writeState(state);
  return note;
}

export async function aiSessionCommand(id: string, input: string, options: { inferred?: boolean; signal?: AbortSignal } = {}): Promise<string> {
  // Every command acts on this chat; any other chat is named by the index
  // (/resume, /sessions) and read on its own when shown.
  const state = await readState({ transcripts: [id] });
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
    const note = await runShellLine(id, command, options.signal);
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
    if (!availability.available && availability.needs === 'provider' && !options.inferred) {
      const implied = impliedHarnessCommand(route, state.accounts, localHarnessForProvider);
      if (implied) {
        await aiHarnessSelect(implied, id);
        return aiSessionCommand(id, input, { ...options, inferred: true });
      }
    }
    if (!availability.available) throw new Error(availability.reason ?? `/${route.entry.name} is not available here.`);
    const moved = await HEADLESS_SLASH_HANDLERS[route.entry.handlerKey]({ id, state, session, head: route.entry.name, args: route.args, words: [...route.words] });
    return typeof moved === 'string' ? moved : id;
  }
  if (route.kind === 'harness') {
    // `/<harness> [request]`: the conversation moves there, and the request
    // runs there.
    await moveToProvider(id, route.command);
    if (route.args) await sendSessionTurn(id, route.args);
    return id;
  }
  if (route.kind === 'manager') {
    const listing = await nativeManagerListing(state, session, route.name);
    emitHarnessOutput({ panel: route.name, text: `${listing.label}\n\n${listing.text}` });
    return id;
  }
  const turn = slashRouteTurn(route, session, harness);
  if (turn) {
    await sendSessionTurn(id, turn.prompt);
    return id;
  }
  throw new Error('slash command is required');
}

/** The turn a slash line becomes, when it becomes one: a native command the
 * harness runs itself, or a custom command expanded into its prompt (not
 * echoed as if typed). An unknown command is refused here. One decision for
 * the interactive loop and the headless handler, which each run the turn
 * their own way. */
export function slashRouteTurn(
  route: SlashRoute, session: HarnessSession, harness: AiLocalHarnessDefinition | undefined,
): { prompt: string; echo: boolean } | undefined {
  if (route.kind === 'unknown') throw new Error(unknownSlashMessage(route));
  if (route.kind === 'native') {
    if (isClikCodeAgent(session)) throw new Error('Native harness commands apply only to local harnesses.');
    return { prompt: route.prompt, echo: true };
  }
  if (route.kind === 'custom') {
    const command = customCommandsFor(session, harness).find((item) => item.name === route.name);
    if (!command) throw new Error(`custom command /${route.name} is no longer available`);
    return { prompt: customCommandPrompt(command, route.args, harness), echo: false };
  }
  return undefined;
}
