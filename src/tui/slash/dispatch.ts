/** A line typed between turns, decided once for every client.
 *
 * The terminal loop (commands/ai/interactive.ts) and the editor bridge
 * (ide/bridge.ts) route a line the same way: a file to attach, a message, a
 * vendor command, a handoff, or one of ClikCode's commands -- most of which
 * open a picker. What differs is only the screen, and that is the host: where
 * a panel goes, how a wait shows, how a file is edited, how a vendor's own
 * manager gets a terminal. The handler table is here, once.
 *
 * `!<command>` lines are not routed here: each client runs them its own way
 * (runShellLine, in tui/slash/handlers.ts). */
import { existsSync } from 'node:fs';
import type Conf from 'conf';
import type { AiLocalHarnessDefinition } from '../../harness/definition.js';
import type { HarnessPrompter } from '../../harness/prompter.js';
import type { HarnessSession, HarnessState } from '../../session/model.js';
import { readState } from '../../session/state/read.js';
import { writeState } from '../../session/state/write.js';
import { isClikCodeAgent } from '../../session/route.js';
import { chatNamed } from '../../session/options.js';
import { embeddedImagePaths, expandHomePath, queueAttachment, resolveStandaloneAttachment } from '../../session/attachments.js';
import { compactPath } from '../../harness/protocol/labels.js';
import { turnEnvironment } from '../../turn/turn-environment.js';
import { localHarnessCapabilityManifest, localHarnessForCommand, localHarnessForProvider } from '../../runtime/lazy-bridge.js';
import { harnessModelLabel } from '../../harness/accounts/model-catalog.js';
import { aiSessionLeave } from '../../commands/ai/sessions.js';
import { moveToProvider, newConversation } from '../../commands/ai/conversations.js';
import { aiHarnessSelect } from '../../commands/ai/harness.js';
import { settingLabel } from '../pickers/setting-scope.js';
import { chooseOption } from '../pickers/choose.js';
import { interactiveEnginePicker } from '../pickers/engine.js';
import { addAccountForHarness, interactiveAccountPicker, manageAccountAction, useAddedAccount } from '../pickers/account.js';
import { interactiveModelPicker } from '../pickers/model.js';
import { interactiveEffortPicker } from '../pickers/effort.js';
import { interactivePermissionPicker } from '../pickers/permissions.js';
import { interactiveHarnessOptionPicker } from '../pickers/options.js';
import { interactiveToolsPicker } from '../pickers/tools.js';
import { interactiveSettingsPicker } from '../pickers/settings.js';
import { interactiveSwarmPicker } from '../pickers/swarm.js';
import { doctorSummary } from '../doctor-summary.js';
import { parseSendMode, sendModeOf, SEND_MODE_DETAIL, SEND_MODES } from '../../turn/send-mode.js';
import { aiSessionCommand, slashRouteTurn } from './handlers.js';
import { routeSlashInput, type SlashHandlerKey, type SlashRoute } from './registry.js';
import { sessionHarness, slashRouteContextFor } from './context.js';
import { enqueueCommandLine } from './queue.js';
import { impliedHarnessCommand } from './infer-provider.js';
import { capabilitiesText } from './capabilities-text.js';
import { forkPoint, forkPointOptions } from './fork-at.js';
import { sessionTranscriptMessages } from '../../turn/checkpoint.js';
import { compactConversation } from './compact.js';
import { searchConversations } from '../../search/engine.js';
import { searchResultsText } from '../../search/navigate.js';
import { exportTranscript } from './export-transcript.js';
import { initPrompt, readMemoryFile, reviewPrompt } from './memory.js';
import { nativeManagerListing } from './native-manager.js';
import type { InteractiveSlashHandlerKey, InteractiveSlashOutcome } from './interactive-keys.js';

type CommandRoute = Extract<SlashRoute, { kind: 'command' }>;

/** The screen a line is dispatched for. */
export interface SlashHost {
  readonly config: Conf;
  /** Answers every picker and question. Its optional `notice` confirms a
   * setting typed with its value ("Model set to …"). */
  readonly prompter: HarnessPrompter;
  /** Whether a picker can be shown at all (a terminal without an alternate
   * screen cannot). Without one, a command that needs a provider says so. */
  readonly canPick: boolean;
  /** A message with no provider chosen yet: choosing one comes first. */
  readonly pickProviderBeforeSending?: boolean;
  /** A titled panel. `kind` and `plain` are the record a client that draws
   * none emits instead. */
  panel(kind: string, title: string, body: string, plain: string): void;
  withBusy<T>(label: string, work: () => Promise<T>): Promise<T>;
  /** A one-line question ("Conversation name"). */
  ask(label: string): Promise<string>;
  redraw(id: string): Promise<void>;
  /** A synthetic turn (/compact), with this client's waiting UI. */
  runTurn(targetId: string, prompt: string): Promise<void>;
  /** /resume and /sessions without a name. */
  openConversationPicker(id: string): Promise<InteractiveSlashOutcome>;
  /** /search <words> where the conversation can be walked mention by
   * mention. Absent: the results are listed in a panel. */
  browseSearch?(query: string): Promise<InteractiveSlashOutcome>;
  /** `/memory edit`. */
  editFile(path: string, cwd: string): Promise<void>;
  /** A vendor's own manager (an argv it runs interactively), given a
   * terminal. Absent: the client has none to give. */
  runManager?(harness: AiLocalHarnessDefinition, label: string, argv: readonly string[], environment: Readonly<Record<string, string>>): Promise<void>;
  /** Written by /export. */
  exported?(path: string): void;
  /** A file attached by naming it: the attachments now queued. */
  attached?(attachments: readonly string[]): void;
  /** The client's own answer to a command, before the shared handlers: a
   * command it replaced, or its own list. Undefined to carry on. */
  intercept?(route: CommandRoute, session: HarnessSession, harness: AiLocalHarnessDefinition | undefined): Promise<InteractiveSlashOutcome | undefined> | InteractiveSlashOutcome | undefined;
}

type ManagerSpec = { label: string; listArgv?: readonly string[]; manageArgv?: readonly string[] };

function sessionAccount(state: HarnessState, session: HarnessSession) {
  return session.accountId ? state.accounts.find((item) => item.id === session.accountId) : undefined;
}

async function hasHarness(id: string): Promise<boolean> {
  const session = (await readState({ transcripts: [] })).sessions.find((item) => item.id === id);
  return Boolean(session && (session.nativeHarness || isClikCodeAgent(session)));
}

/** Route one line on conversation `id`. A line taken from the queue as a
 * command (`fromQueuedCommand`) is never handed back to the queue. */
export async function dispatchLine(host: SlashHost, id: string, line: string, options: { fromQueuedCommand?: boolean } = {}): Promise<InteractiveSlashOutcome> {
  const rl = host.prompter;
  const viaHeadless = async (text: string): Promise<InteractiveSlashOutcome> => {
    const resulting = await aiSessionCommand(id, text);
    return resulting !== id ? { id: resulting } : {};
  };
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  const workspace = session.workspace ?? process.cwd();
  const attachment = await resolveStandaloneAttachment(line, workspace);
  if (attachment) {
    await queueAttachment(session, attachment);
    session.updatedAt = new Date().toISOString();
    await writeState(state);
    host.attached?.(session.attachments ?? []);
    return { notice: `Attached ${compactPath(attachment)} for the next request` };
  }
  const harness = sessionHarness(session);
  // `/etc/hosts explain this` is a request about a file, not a command.
  const route = routeSlashInput(line, slashRouteContextFor(session, harness, (path) => existsSync(expandHomePath(path))));
  if (route.kind === 'prompt') {
    // An image named in the message goes with the message.
    const images = await embeddedImagePaths(route.prompt, workspace);
    if (images.length) {
      for (const image of images) await queueAttachment(session, image).catch(() => undefined);
      await writeState(state);
    }
    if (host.pickProviderBeforeSending && !session.nativeHarness && !isClikCodeAgent(session)) {
      const chosen = await interactiveEnginePicker(host.config, rl, id) ?? id;
      return { id: chosen, ...(await hasHarness(chosen) ? { prompt: route.prompt, echo: true } : { notice: 'Choose a provider to send this.' }) };
    }
    return { prompt: route.prompt, echo: true };
  }
  if (route.kind === 'native' || route.kind === 'custom' || route.kind === 'unknown') {
    return slashRouteTurn(route, session, harness) ?? {};
  }
  if (route.kind === 'harness') {
    // `/<harness> [request]`: the conversation moves there, and the request
    // runs there.
    await moveToProvider(id, route.command);
    return route.args ? { prompt: route.args, echo: true } : {};
  }
  if (route.kind === 'manager') {
    const manager = harness ? (localHarnessCapabilityManifest(harness).managers as Record<string, ManagerSpec | undefined> | undefined)?.[route.name] : undefined;
    if (!harness || !manager) throw new Error('Choose a provider first.');
    if (manager.listArgv) {
      const listing = await host.withBusy(`loading ${manager.label}…`, () => nativeManagerListing(state, session, route.name));
      host.panel(route.name, listing.label, listing.text, `${listing.label}\n\n${listing.text}`);
    } else if (manager.manageArgv && host.runManager) {
      await host.runManager(harness, manager.label, manager.manageArgv, turnEnvironment(harness, sessionAccount(state, session)));
    } else throw new Error(`${harness.displayName} requires an interactive terminal for ${manager.label}.`);
    return {};
  }
  const intercepted = await host.intercept?.(route, session, harness);
  if (intercepted) return intercepted;
  // Availability is decided BEFORE any picker opens, so `/model` on a
  // harness without a model selector says so instead of offering a list.
  const availability = route.entry.availability(session, harness);
  // The one refusal worth turning into a question: the command needs a
  // provider and none is chosen. The command is queued on the chat the
  // picker produced (choosing a provider can branch it) rather than run on
  // the stale copy read above.
  if (!availability.available && availability.needs === 'provider' && !options.fromQueuedCommand) {
    const commandLine = `/${route.entry.name}${route.args ? ` ${route.args}` : ''}`;
    // Derived before asked: `/model claude-opus-5` has already named its
    // provider if exactly one configured account publishes that model.
    const implied = impliedHarnessCommand(route, state.accounts, localHarnessForProvider);
    if (implied) {
      await aiHarnessSelect(implied, id);
      await enqueueCommandLine(id, commandLine);
      return {};
    }
    if (!host.canPick) throw new Error(availability.reason ?? `/${route.entry.name} is not available here.`);
    const chosen = await interactiveEnginePicker(host.config, rl, id) ?? id;
    if (await hasHarness(chosen)) await enqueueCommandLine(chosen, commandLine);
    return { id: chosen };
  }
  if (!availability.available) throw new Error(availability.reason ?? `/${route.entry.name} is not available here.`);
  const text = `/${route.entry.name}${route.args ? ` ${route.args}` : ''}`;
  const { args } = route;
  /** A setting typed with its value says what it set, as the pickers do. */
  const setWithValue = async (said: string): Promise<InteractiveSlashOutcome> => {
    const outcome = await viaHeadless(text);
    rl.notice?.(said);
    return outcome;
  };
  const handlers: Record<InteractiveSlashHandlerKey, () => Promise<InteractiveSlashOutcome | void>> = {
    exit: async () => { await aiSessionLeave(id); return { exit: true }; },
    new: async () => ({ id: await newConversation(id), ...(args ? { prompt: args, echo: true } : {}) }),
    redraw: () => host.redraw(id),
    provider: async () => ({ id: await interactiveEnginePicker(host.config, rl, id) ?? id }),
    accounts: async () => {
      // `/accounts login <harness>` and `/accounts add <harness>` sign in with
      // a terminal handed over, the same as + Add account.
      const [action, name] = args.split(/\s+/);
      const target = (action === 'login' || action === 'add') && name ? localHarnessForCommand(name.toLowerCase()) : undefined;
      if (target?.surface === 'terminal') {
        const added = await addAccountForHarness(rl, target);
        if (added && target.provider === session.provider) await useAddedAccount(id, target, added);
        return {};
      }
      return args ? viaHeadless(text) : { id: await interactiveAccountPicker(rl, id) ?? id };
    },
    model: async () => {
      if (!args) return interactiveModelPicker(rl, id);
      const outcome = await viaHeadless(text);
      const movedTo = outcome.id ?? id;
      const model = (await readState({ transcripts: [movedTo] })).sessions.find((item) => item.id === movedTo)?.model;
      if (model) rl.notice?.(`Model set to ${harness ? harnessModelLabel(harness, model) : model}`);
      return outcome;
    },
    effort: async () => args ? setWithValue(`Effort set to ${settingLabel(args.trim().toLowerCase() === 'default' ? '' : args.trim().toLowerCase())}`) : interactiveEffortPicker(rl, id),
    permissions: async () => args ? setWithValue(`Permissions set to ${settingLabel(args.trim().toLowerCase())}`) : interactivePermissionPicker(rl, id),
    send: async () => {
      if (args) return setWithValue(`Messages typed mid-turn: ${parseSendMode(args)}`);
      // Two rows, the current one marked: what a message typed while a turn
      // runs does from now on, in every conversation.
      const current = sendModeOf(state.globalSettings);
      const chosen = await chooseOption(rl, 'Messages typed mid-turn', SEND_MODES.map((mode) => ({
        label: mode[0]!.toUpperCase() + mode.slice(1), detail: `· ${SEND_MODE_DETAIL[mode]}${mode === current ? ' · current' : ''}`, value: mode,
      })), undefined, { startAt: current });
      if (!chosen) return {};
      await viaHeadless(`/send ${chosen}`);
      rl.notice?.(`Messages typed mid-turn: ${chosen}`);
      return {};
    },
    swarm: async () => (args ? viaHeadless(text) : interactiveSwarmPicker(rl, id)),
    options: async () => interactiveHarnessOptionPicker(rl, id),
    capabilities: async () => {
      const [title = 'Capabilities', ...rest] = capabilitiesText(session).split('\n');
      host.panel('capabilities', title, rest.join('\n'), [title, ...rest].join('\n'));
    },
    settings: async () => {
      // `/settings tools`: straight to Tools & integrations (MCP servers, skills, agents).
      if (args.trim().toLowerCase() === 'tools') {
        if (!harness) throw new Error('Choose a provider first: tools and MCP servers belong to a harness.');
        await interactiveToolsPicker(rl, id, harness);
        return {};
      }
      return args ? viaHeadless(text) : { id: await interactiveSettingsPicker(host.config, rl, id) ?? id };
    },
    sessions: async () => (args ? viaHeadless(text) : host.openConversationPicker(id)),
    // Resume reopens the chosen conversation at its source: its account,
    // harness and native session. `/resume <name>` goes straight there when
    // the name picks out one conversation.
    resume: async () => {
      const named = args ? chatNamed(state.sessions, args, id) : undefined;
      return named ? { id: named } : host.openConversationPicker(id);
    },
    search: async () => {
      const query = args.trim();
      if (!query) throw new Error('usage: /search <words>');
      if (host.browseSearch) return host.browseSearch(query);
      const result = await host.withBusy('searching conversations…', () => searchConversations(query));
      if (!result?.hits.length) return { notice: `No conversation mentions "${query}"` };
      const listed = searchResultsText(result);
      const [title = 'Search', ...rest] = listed.split('\n');
      host.panel('search', title, rest.join('\n'), listed);
    },
    rename: async () => {
      const name = args || (await host.ask('Conversation name')).trim();
      if (name) await aiSessionCommand(id, `/rename ${name}`);
    },
    // No "[y/N]": archiving is undone by resuming it. A confirmation earns
    // its keypress only for what cannot be taken back -- /delete keeps its own.
    // `/fork` with nothing after it, where a picker can be shown: which of
    // the user's messages to fork after, newest first.
    fork: async () => {
      const options = args || !host.canPick ? [] : forkPointOptions(sessionTranscriptMessages(session));
      const at = options.length > 1 ? await chooseOption(rl, 'Fork after which message?', options) : forkPoint(route.words[0]);
      if (options.length > 1 && at === undefined) return {};
      const outcome = await viaHeadless(options.length > 1 ? `/fork @${at}` : text);
      // Said here too: the panel is drawn on the conversation being left.
      return at === undefined ? outcome : { ...outcome, notice: `Forked after message ${at} · files on disk are not rewound: /changes lists each turn's edits, /undo takes them back` };
    },
    archive: async () => { await aiSessionCommand(id, '/archive'); return { exit: true }; },
    delete: async () => {
      // The same confirmation every delete uses: Cancel first.
      const confirmed = await chooseOption(rl, 'Delete this conversation?', [
        { label: 'Cancel', value: false }, { label: 'Delete this conversation', value: true },
      ]);
      if (!confirmed) return {};
      await aiSessionCommand(id, '/delete confirm');
      return { exit: true };
    },
    mention: async () => {
      const path = args || (await host.ask('File to attach')).trim();
      return path ? viaHeadless(`/mention ${path}`) : {};
    },
    review: async () => ({ prompt: reviewPrompt(args), echo: false }),
    init: async () => ({ prompt: initPrompt(session), echo: false }),
    native: async () => {
      if (!args) throw new Error('usage: /native <text>  (or //text)');
      return { prompt: args, echo: true };
    },
    compact: async () => {
      // No confirmation line: the compacted conversation on screen is that.
      const compacted = await compactConversation(id, session, args, (targetId, promptText) => host.runTurn(targetId, promptText));
      return typeof compacted === 'string' ? { id: compacted } : {};
    },
    export: async () => {
      const path = await exportTranscript(session, args, async (existing) =>
        ['y', 'yes'].includes((await host.ask(`${compactPath(existing)} exists. Overwrite? [y/N]`)).trim().toLowerCase()));
      host.exported?.(path);
      return { notice: `Transcript written to ${compactPath(path)}` };
    },
    memory: async () => {
      if (route.words[0]?.toLowerCase() !== 'edit') return viaHeadless(text);
      const memory = await readMemoryFile(session);
      await host.editFile(memory.path, session.workspace ?? process.cwd());
      return {};
    },
    doctor: async () => {
      const report = await host.withBusy('checking harnesses…', () => doctorSummary(state));
      host.panel('doctor', 'ClikCode doctor', report, report);
    },
    login: async () => {
      if (!harness) throw new Error('Choose a provider before signing in.');
      // Sign the current account in again only when it needs it; otherwise
      // /login means another account, which becomes this chat's.
      const current = sessionAccount(state, session);
      if (current?.authKind === 'vendor-cli' && (current.status !== 'ready' || current.verification)) {
        await manageAccountAction(rl, current.id, 'reauthenticate');
        return {};
      }
      const added = await addAccountForHarness(rl, harness);
      if (added) await useAddedAccount(id, harness, added);
      return {};
    },
    logout: async () => {
      if (!session.accountId) throw new Error('This conversation has no account to sign out.');
      await host.withBusy('signing out…', () => manageAccountAction(rl, session.accountId!, 'disconnect'));
      return {};
    },
  };
  const handler = (handlers as Partial<Record<SlashHandlerKey, () => Promise<InteractiveSlashOutcome | void>>>)[route.entry.handlerKey];
  return (handler ? await handler() : await viaHeadless(text)) ?? {};
}
