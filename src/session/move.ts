/** Moving a chat to another machine (/machine in the terminal, the machine
 * chip in the editor).
 *
 * A chat belongs to the machine that runs it, so moving one is three steps
 * between two ClikCodes, each on its own machine: the one it is on EXPORTS it
 * (ClikCode's own record -- the messages, the name, the conversation id and
 * the chat's settings; never a credential, a vendor thread or a path to use),
 * the one it goes to IMPORTS it as a chat of its own, and the first is MARKED
 * MOVED, read-only from then on: there is only ever one live copy.
 *
 * The importing machine decides everything about its own side: which of the
 * chat's settings it can keep (its harnesses, its accounts, what its vendor
 * allows -- Claude Code refuses bypass as root), and the folder: the one this
 * conversation used on this machine before, else its home. Nothing is asked:
 * `importChat` keeps what it can (`planImport`, its own first step) and the
 * chat's info line shows where it is and what it runs on.
 *
 * The imported chat has no vendor thread: it is taken up the way a provider
 * switch does (turn/thread-start.ts) -- ahead of the first turn, by the worker
 * the import starts warm (turn/vendor-warm.ts) -- with a note to the agent,
 * unseen, that it moved (moveNote). The copy left behind is read-only, and
 * its worker goes. */
import { quiet } from '../runtime/lifecycle-log.js';
import { homedir } from 'node:os';
import type Conf from 'conf';
import type { AiHarnessAccount, AiHarnessPermissionMode, AiLocalHarnessDefinition } from '../harness/definition.js';
import type { ChatMovedTo, HarnessSession, HarnessState, TranscriptMessage } from './model.js';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';
import type { ChatExport, ChatHave, ImportPlan, ImportResult, MoveNames, MoveRequest, PackedChat } from './move-chat.js';
import { STALE_BASE } from './move-chat.js';
import { readState } from './state/read.js';
import { writeState } from './state/write.js';
import { resolveDefaultSettings } from './state/settings.js';
import { folderExists } from '../runtime/machine-folder.js';
import { harnessSupportsEffort, harnessSupportsPermissionMode, localHarnessForCommand, localHarnessForProvider } from '../runtime/lazy-bridge.js';
import { CLIKCODE_LOCAL_LABEL, GATEWAY_LABEL } from './route.js';
import { messageOrigin, sessionTranscriptMessages } from '../turn/checkpoint.js';
import { carriedHandoffSettings } from '../turn/handoff.js';
import { forgetNativeThread } from './native-thread.js';
import { getApiKeyForUrl, getApiUrl } from '../gateway/credentials.js';

const MOVED_ALREADY = (session: HarnessSession): string => `This chat moved to ${session.movedTo!.machine}; it goes on there.`;

// ---- the machine it leaves ---------------------------------------------------

/** How the exporting side knows whether a turn runs: a client that follows
 * the chat's worker already says (the editor's bridge); else its worker is
 * asked -- only when one is running at all. */
export interface ExportOptions { turnRunning?: () => Promise<boolean> }

/** A chat's messages as it exports them: every one keeps whose it was, as
 * when a provider takes a conversation over (leaveProvider). What a target
 * holds (`chat-have`) is hashed in this same form, so a copy that moved away
 * and back matches what the other machine got from it. */
function exportedMessages(session: HarnessSession): TranscriptMessage[] {
  const origin = messageOrigin(session);
  return sessionTranscriptMessages(session).map((message) => (message.origin ? message : { ...message, origin })) as TranscriptMessage[];
}

/** JSON with every object's keys in order: the same message hashes the same on either machine. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => (item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, (item as Record<string, unknown>)[key]]))
    : item));
}

/** A hash of messages, as `chat-have` and a delta's `base` name them. */
export function chatMessagesHash(messages: readonly unknown[]): string {
  const hash = createHash('sha256');
  for (const message of messages) hash.update(canonicalJson(message)).update('\n');
  return hash.digest('hex');
}

/** The copy of a chat that moved away from this machine: what a move back reuses (importChat). */
function movedAwayCopy(state: HarnessState, id: string): HarnessSession | undefined {
  return state.sessions.find((item) => item.id === id && item.movedTo);
}

/** What this machine holds of the chat already: the copy that moved away from
 * here, if any -- the one a move back takes up again. */
export async function chatHave(id: string): Promise<ChatHave | null> {
  const state = await readState({ transcripts: [id] });
  const session = movedAwayCopy(state, id);
  if (!session) return null;
  const messages = exportedMessages(session);
  return messages.length ? { messages: messages.length, hash: chatMessagesHash(messages) } : null;
}

const TURN_RUNS = 'A turn is still running in this conversation -- move it when the turn ends, or stop it first.';

export async function exportChat(id: string, options: ExportOptions = {}, since?: ChatHave): Promise<ChatExport> {
  const state = await readState({ transcripts: [id] });
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  if (session.movedTo) throw new Error(MOVED_ALREADY(session));
  if (options.turnRunning) {
    if (await options.turnRunning()) throw new Error(TURN_RUNS);
  } else {
    const { runningWorker } = await import('../worker/client.js');
    if (await runningWorker(id)) {
      const { refuseWhileTurnRuns } = await import('../commands/ai/conversations.js');
      await refuseWhileTurnRuns(id);
    }
  }
  // What was said in the vendor's own CLI is part of the conversation too.
  // Only the copy sent: this one is marked moved next (and read-only), and a
  // move that does not happen syncs it as any open would.
  const { synchronizeNativeTranscript } = await import('../turn/handoff.js');
  await synchronizeNativeTranscript(state, session);
  let messages = exportedMessages(session);
  // The target holds this chat's first messages already: only the rest goes.
  const base = since && Number.isInteger(since.messages) && since.messages > 0 && since.messages <= messages.length
    && chatMessagesHash(messages.slice(0, since.messages)) === since.hash ? { messages: since.messages, hash: since.hash } : undefined;
  if (base) messages = messages.slice(base.messages);
  const account = session.accountId ? state.accounts.find((item) => item.id === session.accountId)?.label : undefined;
  return {
    ...(base ? { version: 2 as const, base } : { version: 1 as const }), sessionId: session.id, conversationId: session.conversationId ?? session.id,
    ...(session.name ? { name: session.name } : {}), ...(session.nameSource ? { nameSource: session.nameSource } : {}),
    createdAt: session.createdAt, messages,
    ...(session.summary ? { summary: session.summary } : {}), ...(session.plan ? { plan: session.plan } : {}),
    settings: {
      route: session.route, provider: session.provider, model: session.model, effort: session.effort,
      ...(session.nativeHarness ? { nativeHarness: session.nativeHarness } : {}),
      ...(session.routeModels ? { routeModels: session.routeModels } : {}),
      ...(session.permissionMode ? { permissionMode: session.permissionMode } : {}),
      ...(session.planMode ? { planMode: true } : {}), ...(session.speed ? { speed: session.speed } : {}),
      ...(session.sandbox ? { sandbox: session.sandbox } : {}),
      ...(session.harnessOptions ? { harnessOptions: session.harnessOptions } : {}),
      ...(session.gatewayAgentId ? { gatewayAgentId: session.gatewayAgentId } : {}),
      ...(session.gatewayAgentName ? { gatewayAgentName: session.gatewayAgentName } : {}),
      ...(account ? { account } : {}),
    },
    source: { ...(session.workspace ? { folder: session.workspace } : {}) },
  };
}

/** The chat went on elsewhere: read-only here, its row says where. */
export async function markMoved(id: string, movedTo: Omit<ChatMovedTo, 'at'>): Promise<void> {
  const state = await readState({ transcripts: [] });
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  session.movedTo = { ...movedTo, at: new Date().toISOString() };
  delete session.moveNote;
  session.updatedAt = new Date().toISOString();
  await writeState(state);
  // Read-only now: its worker, and the vendor it holds, go rather than idle out.
  const { retireMovedWorker } = await import('../worker/client.js');
  await retireMovedWorker(id).catch(quiet('session/move'));
}

/** The chat is wanted here again and the machine it went to cannot hand it
 * back (offline, removed, too old): the copy kept here stops being read-only,
 * its vendor thread forgotten as on any move back (the next turn takes the
 * conversation up again). Whatever happened on the other machine since is not here. */
export async function reclaimMovedChat(id: string): Promise<string> {
  const state = await readState({ transcripts: [id] });
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  if (!session.movedTo) return id;
  delete session.movedTo;
  session.updatedAt = new Date().toISOString();
  forgetNativeThread(session);
  await writeState(state);
  const { warmSessionWorker } = await import('../worker/client.js');
  await warmSessionWorker(id).catch(quiet('session/move'));
  return id;
}

// ---- the machine it goes to --------------------------------------------------

/** The same person's account, by label or the email in it. */
function sameAccount(account: Pick<AiHarnessAccount, 'label'>, label: string): boolean {
  const email = (text: string): string | undefined => /[^\s<>()]+@[^\s<>()]+\.[^\s<>()]+/.exec(text)?.[0]?.toLowerCase();
  if (account.label.trim().toLowerCase() === label.trim().toLowerCase()) return true;
  const mine = email(account.label);
  return Boolean(mine && mine === email(label));
}

const MODE_NAMES: Record<AiHarnessPermissionMode, string> = { ask: 'Ask', auto: 'Auto', bypass: 'Bypass' };

/** What a route or harness is called, in a sentence. */
function providerName(settings: Pick<ChatExport['settings'], 'route' | 'nativeHarness' | 'provider'>): string {
  if (settings.route === 'gateway') return GATEWAY_LABEL;
  if (settings.route === 'clikcode-local') return CLIKCODE_LOCAL_LABEL;
  const harness = settings.nativeHarness ? localHarnessForCommand(settings.nativeHarness) : settings.provider ? localHarnessForProvider(settings.provider) : undefined;
  return harness?.displayName ?? settings.provider ?? 'its provider';
}

/** Facts of this machine the plan reads; the defaults are the real ones, a test passes its own. */
export interface MoveFacts {
  /** The harness is installed here. */
  installed(harness: AiLocalHarnessDefinition): Promise<boolean>;
  /** ClikDeploy Gateway is signed in here. */
  gatewaySignedIn(): boolean;
  /** The account the vendor's own sign-in on disk is (its label), when it
   * keeps one and ClikCode has no account for it yet: a new chat's first
   * turn makes that account (aiHarnessSelect). */
  vendorSignIn(harness: AiLocalHarnessDefinition): Promise<string | undefined>;
  /** The effort levels the harness offers here, when it says. */
  efforts(harness: AiLocalHarnessDefinition, account: AiHarnessAccount | undefined, model: string | null): Promise<readonly string[] | undefined>;
  home(): string;
}

export function machineFacts(config: Conf | undefined): MoveFacts {
  return {
    installed: async (harness) => (await import('../harness/transport/native/inspect.js')).inspectNativeHarnessForPicker(harness).then((found) => found.installed, () => false),
    gatewaySignedIn: () => Boolean(config && getApiKeyForUrl(config, getApiUrl(config))),
    vendorSignIn: async (harness) => {
      const { authEvidencePresent, hasAuthEvidence } = await import('../harness/accounts/auth-files.js');
      if (!hasAuthEvidence(harness) || !await authEvidencePresent(harness, {}).catch(() => false)) return undefined;
      const { deriveAccountLabel } = await import('../harness/accounts/labels.js');
      return await deriveAccountLabel(harness, undefined).catch(quiet('session/move')) ?? harness.displayName;
    },
    efforts: async (harness, account, model) => (harnessSupportsEffort(harness)
      ? (await (await import('../harness/accounts/effort-choices.js')).effortChoicesFor(harness, account, model).catch(quiet('session/move')))?.values
      : undefined),
    home: homedir,
  };
}

type Planned = ImportPlan & { session: Omit<HarnessSession, 'id' | 'createdAt' | 'updatedAt' | 'status' | 'messages'> };

/** What the chat would be here, and what of it changes. Reads only. */
export async function planImport(state: HarnessState, chat: ChatExport, facts: MoveFacts): Promise<Planned> {
  const wanted = chat.settings;
  const changes: string[] = [];
  // The folder: the one this conversation used on this machine before (a chat
  // moved away and back, or a fork of it), while it is still here; else home.
  const remembered = state.sessions
    .filter((item) => (item.conversationId ?? item.id) === chat.conversationId && item.workspace && folderExists(item.workspace))
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0]?.workspace;
  const folder = remembered ?? facts.home();

  const harness = wanted.route === 'local' ? (wanted.nativeHarness ? localHarnessForCommand(wanted.nativeHarness) : wanted.provider ? localHarnessForProvider(wanted.provider) : undefined) : undefined;
  // A vendor CLI not installed there is still the chat's provider: its first
  // turn installs it and signs in (vendor-turn-context.ts), as choosing it in
  // /provider would. Handing the chat to whatever that machine ran last
  // instead put it on a provider nobody had set up there (seen live: Claude
  // Code's chat landed on a Hermes with no model configured).
  const installedThere = harness ? await facts.installed(harness) : false;
  const usable = wanted.route === 'gateway' ? facts.gatewaySignedIn()
    : wanted.route === 'clikcode-local' ? true
      : Boolean(harness);
  if (harness && !installedThere) changes.push(`${harness.displayName} is not installed there; the first message installs it and signs in.`);
  const kept = { route: wanted.route, provider: wanted.provider, model: wanted.model, effort: wanted.effort };
  let session: Planned['session'];
  if (!usable) {
    // What a new chat here would run on: this machine's last provider (launchSession).
    const { launchSession } = await import('../commands/ai/sessions.js');
    const fresh = launchSession(state, folder);
    const { id: _id, createdAt: _created, updatedAt: _updated, status: _status, messages: _messages, ...settings } = fresh;
    session = { ...settings, conversationId: chat.conversationId };
    const why = wanted.route === 'gateway' ? `${GATEWAY_LABEL} is not signed in there` : `${providerName(wanted)} is not installed there`;
    const next = fresh.route === 'local' && !fresh.nativeHarness ? 'the first message there asks for a provider' : `using ${providerName(fresh)}`;
    if (wanted.route !== 'local' || harness || wanted.provider) changes.push(`${why}; ${next}.`);
  } else if (wanted.route !== 'local' || !harness) {
    // ClikCode's own agent: its settings are its own, whatever machine runs it.
    session = {
      ...kept, conversationId: chat.conversationId, accountId: null,
      ...(wanted.permissionMode ? { permissionMode: wanted.permissionMode } : {}),
      ...(wanted.planMode ? { planMode: true } : {}), ...(wanted.speed ? { speed: wanted.speed } : {}),
      ...(wanted.sandbox ? { sandbox: wanted.sandbox } : {}),
      ...(wanted.gatewayAgentId ? { gatewayAgentId: wanted.gatewayAgentId } : {}),
      ...(wanted.gatewayAgentName ? { gatewayAgentName: wanted.gatewayAgentName } : {}),
      ...(wanted.route === 'gateway' ? { gatewayConfirmed: true as const } : {}),
    };
  } else {
    // The same account here, else this machine's signed-in one, else none: the first turn signs in.
    const ofProvider = state.accounts.filter((account) => account.provider === harness.provider);
    const same = wanted.account ? ofProvider.find((account) => sameAccount(account, wanted.account!)) : undefined;
    let account: AiHarnessAccount | undefined = same?.status === 'ready' ? same : undefined;
    if (!account) {
      const { signedInAccountId } = await import('../commands/ai/preferred-account.js');
      const other = signedInAccountId(state, harness.provider);
      account = other ? state.accounts.find((item) => item.id === other) : undefined;
      // Signed in with the vendor there, with no account in ClikCode yet: that one.
      const onDisk = account || ofProvider.length ? undefined : await facts.vendorSignIn(harness);
      const using = account?.label ?? onDisk;
      // Not installed there: its line already says the first message signs in.
      if (installedThere && wanted.account && !(using && sameAccount({ label: using }, wanted.account))) {
        changes.push(using
          ? `account ${wanted.account} is not signed in there; using ${using}.`
          : `account ${wanted.account} is not signed in there; the first message there signs in.`);
      }
    }
    // The model, when this account lists it (or lists none, so says nothing against it).
    const listed = account?.models ?? [];
    let model = wanted.model;
    if (model && listed.length && !listed.includes(model)) {
      const fallback = [state.providerSettings[harness.provider]?.model, harness.defaultModel].find((candidate) => candidate && listed.includes(candidate)) ?? listed[0]!;
      changes.push(`model ${model} is not available there; using ${fallback}.`);
      model = fallback;
    }
    // Effort and permissions within what this machine allows (its vendor, its user).
    const efforts = await facts.efforts(harness, account, model);
    const carried = carriedHandoffSettings({ effort: wanted.effort, ...(wanted.permissionMode ? { permissionMode: wanted.permissionMode } : {}), nativeHarness: harness.command },
      harness, resolveDefaultSettings(state, harness.provider), efforts);
    if (wanted.effort && carried.effort !== wanted.effort) changes.push(`Effort ${wanted.effort} → ${carried.effort || `${harness.displayName}'s default`}.`);
    if (wanted.permissionMode && carried.permissionMode !== wanted.permissionMode) {
      const root = wanted.permissionMode === 'bypass' && harness.bypassRefusedAsRoot && !harnessSupportsPermissionMode(harness, 'bypass');
      changes.push(`${MODE_NAMES[wanted.permissionMode]} → ${MODE_NAMES[carried.permissionMode]}${root ? ' (root)' : ''}.`);
    }
    session = {
      route: 'local', conversationId: chat.conversationId, provider: harness.provider, nativeHarness: harness.command,
      accountId: account?.id ?? same?.id ?? ofProvider[0]?.id ?? null, model, effort: carried.effort, permissionMode: carried.permissionMode,
      ...(wanted.harnessOptions ? { harnessOptions: wanted.harnessOptions } : {}),
    };
  }
  if (wanted.routeModels) session.routeModels = wanted.routeModels;
  return { changes, folder, session };
}

/** The note the agent is given, unseen, with the chat's first turn here. */
export function moveNoteText(names: MoveNames, from: string | undefined, to: string): string {
  return `This conversation moved from ${names.source}${from ? ` (folder ${from})` : ''} to ${names.target} (folder ${to}). `
    + 'Files, processes and anything started before the move are on the previous machine; paths may differ. '
    + 'Check the state here before relying on earlier findings.';
}

/** The chat, as a chat of this machine. Its id stays when this machine has
 * no chat by that id, or has only the copy that moved away from here (it is
 * taken up again); a live chat of the same id here keeps its own. */
export async function importChat(chat: ChatExport, names: MoveNames, facts: MoveFacts): Promise<ImportResult> {
  const delta = chat?.version === 2 && chat.base;
  if (!(chat?.version === 1 || delta) || !Array.isArray(chat.messages)) throw new Error('This ClikCode cannot read that chat: update ClikCode on both machines.');
  const state = await readState({ transcripts: [chat.sessionId] });
  let messages = chat.messages;
  if (delta) {
    // A move back: the first messages are the ones the copy here holds, as it said (chatHave).
    const copy = movedAwayCopy(state, chat.sessionId);
    const held = copy ? exportedMessages(copy) : [];
    if (held.length < delta.messages || chatMessagesHash(held.slice(0, delta.messages)) !== delta.hash) throw new Error(STALE_BASE);
    messages = [...held.slice(0, delta.messages), ...chat.messages];
  }
  const planned = await planImport(state, chat, facts);
  const existing = state.sessions.find((item) => item.id === chat.sessionId);
  const { randomUUID } = await import('node:crypto');
  const id = existing && !existing.movedTo ? randomUUID() : chat.sessionId;
  const now = new Date().toISOString();
  const session: HarnessSession = {
    ...planned.session,
    id, createdAt: chat.createdAt || now, updatedAt: now, status: 'active', workspace: planned.folder,
    ...(chat.name ? { name: chat.name } : {}), ...(chat.nameSource ? { nameSource: chat.nameSource } : {}),
    messages,
    ...(chat.summary ? { summary: chat.summary } : {}), ...(chat.plan ? { plan: chat.plan } : {}),
    moveNote: moveNoteText(names, chat.source?.folder, planned.folder),
  };
  if (existing && id === existing.id) {
    // The copy that moved away from here: what it held of a vendor thread is
    // stale now (turns happened elsewhere), and is kept only as ClikCode's own.
    forgetNativeThread(existing);
    if (existing.ownedThreads?.length) session.ownedThreads = existing.ownedThreads;
    state.sessions = state.sessions.map((item) => (item.id === id ? session : item));
  } else state.sessions.push(session);
  await writeState(state);
  // A provider with no account here at all gets the one a new chat would (its
  // vendor's own sign-in, if any): the first turn signs in where it must.
  if (session.route === 'local' && session.nativeHarness && !session.accountId) {
    const { aiHarnessSelect } = await import('../commands/ai/harness.js');
    await aiHarnessSelect(session.nativeHarness, id, { emit: false, signIn: false }).catch(quiet('session/move'));
  }
  // Warm here now, so the first reply comes at warm speed (turn/vendor-warm.ts).
  const { warmSessionWorker } = await import('../worker/client.js');
  await warmSessionWorker(id).catch(quiet('session/move'));
  return { sessionId: id, changes: planned.changes, folder: planned.folder, installationId: state.installationId };
}

/** One move request, answered by this machine's ClikCode: the bridge's
 * `export-chat` / `import-chat` / `mark-moved` / `reclaim-moved`, and the terminal's own chat
 * in-process. */
export async function answerMoveRequest(config: Conf | undefined, request: MoveRequest, currentId?: string, options: ExportOptions = {}): Promise<unknown> {
  switch (request.type) {
    case 'export-chat': {
      const id = request.sessionId ?? currentId;
      if (!id) throw new Error('No conversation is open.');
      const chat = await exportChat(id, options, request.since);
      return request.pack ? packChat(chat) : chat;
    }
    case 'chat-have':
      return chatHave(request.sessionId);
    case 'import-chat': {
      // A client from before moves were one step plans first: answered as
      // before (what would change, nothing imported), and its import follows.
      if ((request as { dryRun?: unknown }).dryRun) {
        const state = await readState({ transcripts: [] });
        const { changes, folder } = await planImport(state, await unpackChat(request.chat), machineFacts(config));
        return { changes, folder } satisfies ImportPlan;
      }
      return importChat(await unpackChat(request.chat), request.names, machineFacts(config));
    }
    case 'mark-moved':
      await markMoved(request.sessionId, request.movedTo);
      return undefined;
    case 'reclaim-moved':
      return reclaimMovedChat(request.sessionId);
    default:
      throw new Error('unknown move request');
  }
}

const gzipped = promisify(gzip);
const gunzipped = promisify(gunzip);

/** A chat as it travels (PackedChat): compressed off the event loop. */
export async function packChat(chat: ChatExport): Promise<PackedChat> {
  return {
    packed: (await gzipped(Buffer.from(JSON.stringify(chat)))).toString('base64'),
    sessionId: chat.sessionId, ...(chat.base ? { base: chat.base } : {}), count: chat.messages.length,
  };
}

export async function unpackChat(chat: ChatExport | PackedChat): Promise<ChatExport> {
  if (!('packed' in chat)) return chat;
  return JSON.parse((await gunzipped(Buffer.from(chat.packed, 'base64'))).toString('utf8')) as ChatExport;
}
