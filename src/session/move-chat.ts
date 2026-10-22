/** The move of a chat between machines as a client drives it (session/move.ts
 * says what a move is): the requests, and the one order they go in. No state
 * is read here -- each side answers for its own machine -- so the terminal and
 * the editor share it. */
import type { AiHarnessPermissionMode } from '../harness/definition.js';
import type { ChatMovedTo, HarnessSession, TranscriptMessage } from './model.js';

/** What a machine already holds of a chat (`chat-have`): the copy that moved
 * away from it, as it would export it -- how many messages, and a hash of
 * them (chatMessagesHash). Only what the target lacks then travels. */
export interface ChatHave { messages: number; hash: string }

/** A chat as one machine hands it to another. Plain data, sent as JSON.
 * Version 2 is a delta: `base` names the first messages the target already
 * holds (its `chat-have`), and `messages` are only the ones after them. An
 * importer from before deltas refuses version 2 rather than import half a
 * chat (it is never sent one: the client asks `chat-have` first, which such a
 * machine does not answer). */
/** A ChatExport as it travels between machines (revision 5): gzipped JSON, base64. A chat is
 * mostly repeated text, so it is about a quarter of the size -- and the client in the middle
 * passes it on unopened, needing only these few fields. */
export interface PackedChat {
  packed: string;
  sessionId: string;
  base?: ChatHave;
  /** How many messages it carries. */
  count: number;
}

export interface ChatExport {
  version: 1 | 2;
  base?: ChatHave;
  sessionId: string;
  conversationId: string;
  name?: string;
  nameSource?: HarnessSession['nameSource'];
  createdAt: string;
  messages: TranscriptMessage[];
  summary?: HarnessSession['summary'];
  plan?: HarnessSession['plan'];
  settings: {
    route: HarnessSession['route'];
    provider: string | null;
    nativeHarness?: string;
    model: string | null;
    routeModels?: HarnessSession['routeModels'];
    effort: string;
    permissionMode?: AiHarnessPermissionMode;
    planMode?: boolean;
    speed?: 'fast';
    sandbox?: 'off' | 'workspace';
    harnessOptions?: Record<string, unknown>;
    gatewayAgentId?: string;
    gatewayAgentName?: string;
    /** The account by its label (an email, mostly): the importing machine
     * looks for the same one among its own. Nothing else of it travels. */
    account?: string;
  };
  /** Where it ran, for the agent's note only: never a folder to use. */
  source: { folder?: string };
}

/** What the machines are called, by the client moving the chat. */
export interface MoveNames { source: string; target: string }

export interface ImportPlan {
  /** What will not be as it was, one sentence each (for the log: nothing asks). */
  changes: string[];
  /** The folder the chat goes on in there. */
  folder: string;
}

export interface ImportResult extends ImportPlan {
  sessionId: string;
  /** The importing ClikCode's installation id (ChatMovedTo.installationId). */
  installationId: string;
}

/** What a move asks a machine's ClikCode, as the bridge takes it (ide/protocol.ts).
 * An older client may still send `dryRun` on import-chat: it is ignored, and
 * the chat is imported (it is sent once now; nothing is planned up front). */
export type MoveRequest =
  /** `since`: what the target holds (its `chat-have`). When this chat's first
   * messages are exactly those, only the rest is exported (version 2). */
  | { type: 'export-chat'; sessionId?: string; since?: ChatHave; /** Answer a PackedChat (an older ClikCode ignores it). */ pack?: boolean }
  /** Revision 5: what this machine holds of the chat already (the copy that
   * moved away from here), or null. */
  | { type: 'chat-have'; sessionId: string }
  | { type: 'import-chat'; chat: ChatExport | PackedChat; names: MoveNames }
  | { type: 'mark-moved'; sessionId: string; movedTo: Omit<ChatMovedTo, 'at'> }
  /** Revision 6: the machine a chat moved to cannot be reached from the
   * client opening it, so the copy kept on this machine goes on (reclaimMovedChat). */
  | { type: 'reclaim-moved'; sessionId: string };

/** A chat that moved is read-only here: what to say instead of acting on it. */
export function movedChatMessage(session: Pick<HarnessSession, 'movedTo'>): string | undefined {
  return session.movedTo ? `This chat moved to ${session.movedTo.machine}; continue it there.` : undefined;
}

/** Whether a chat has anything to move: one nothing was said in is a new chat there instead. */
export function chatHasContent(session: Pick<HarnessSession, 'messages' | 'pendingTurn' | 'listMessageCount'>): boolean {
  return Boolean(session.messages?.length || session.pendingTurn || session.listMessageCount);
}

/** The bridge revision that answers `chat-have` and delta exports (ide/protocol-version.ts). */
export const CHAT_HAVE_REVISION = 5;

/** What an importer says when the base of a delta is not what it holds (it
 * changed since `chat-have`): the client sends the whole chat instead. */
export const STALE_BASE = 'The copy of this chat there changed: sending all of it.';

/** A machine's side of a move: its name and how to ask its ClikCode.
 * `revision`: its bridge revision, when known -- `chat-have` is asked only of
 * one at CHAT_HAVE_REVISION or later. */
export interface MoveEnd {
  name: string;
  revision?: number;
  call<T>(request: MoveRequest): Promise<T>;
}

export interface MoveOutcome {
  moved: true; sessionId: string; folder: string; changes: string[];
  /** Messages the target already held and kept (not sent), and how many were sent. */
  reused: number; sent: number;
}

/** The move itself, from whichever client: one pick, nothing asked. Export
 * there, import here (the chat sent once; the importer keeps what it can of
 * the settings and says nothing up front -- a turn it cannot run says so when
 * it is sent, as any new chat there would), then mark the old copy moved. The
 * importer warms the chat on its machine; marking moved lets the old copy's
 * worker go.
 *
 * Only what the target lacks travels: it is asked first what it holds of the
 * chat (`chat-have` -- the copy left there when the chat moved away), and the
 * source exports only the messages after those when its own first ones are
 * the same (by hash). Anything else -- an older target, nothing held, a copy
 * that differs or changed meanwhile -- sends the whole chat, as before. */
export async function moveChat(source: MoveEnd, target: MoveEnd, sessionId: string): Promise<MoveOutcome> {
  const names = { source: source.name, target: target.name };
  // What the target holds already (a chat moving back): only the rest is sent.
  // A target that cannot say, or holds nothing, gets the whole chat.
  const have = (target.revision ?? 0) >= CHAT_HAVE_REVISION
    ? await target.call<ChatHave | null>({ type: 'chat-have', sessionId }).catch(() => null)
    : null;
  // Packed only for a target that can open it; an older source answers unpacked, which any target reads.
  const pack = (target.revision ?? 0) >= CHAT_HAVE_REVISION;
  let chat = await source.call<ChatExport | PackedChat>({ type: 'export-chat', sessionId, ...(validHave(have) ? { since: have } : {}), ...(pack ? { pack } : {}) });
  let imported: ImportResult;
  try {
    imported = await target.call<ImportResult>({ type: 'import-chat', chat, names });
  } catch (error) {
    // Its copy changed since it said: all of it, then.
    if (!chat.base || !String((error as Error)?.message ?? error).includes(STALE_BASE)) throw error;
    chat = await source.call<ChatExport | PackedChat>({ type: 'export-chat', sessionId, ...(pack ? { pack } : {}) });
    imported = await target.call<ImportResult>({ type: 'import-chat', chat, names });
  }
  await source.call({ type: 'mark-moved', sessionId: chat.sessionId, movedTo: { machine: target.name, installationId: imported.installationId, sessionId: imported.sessionId } });
  return {
    moved: true, sessionId: imported.sessionId, folder: imported.folder, changes: imported.changes,
    reused: chat.base?.messages ?? 0, sent: 'packed' in chat ? chat.count : chat.messages.length,
  };
}

function validHave(have: unknown): have is ChatHave {
  const value = have as ChatHave | null;
  return Boolean(value && Number.isInteger(value.messages) && value.messages > 0 && typeof value.hash === 'string' && value.hash);
}

/** The machine a moved chat went to, among the ones a client knows: 'local'
 * (the client's own), an added machine's id -- by installation id, else by
 * name -- or undefined for one it has not added. */
export function movedChatMachine(
  movedTo: Pick<ChatMovedTo, 'machine' | 'installationId'>, machines: ReadonlyArray<{ id: string; name: string; installationId?: string; ready?: boolean }>,
  here: { name: string; installationId?: string },
): string | undefined {
  if (movedTo.installationId && movedTo.installationId === here.installationId) return 'local';
  const ready = machines.filter((machine) => machine.ready !== false);
  const machine = (movedTo.installationId ? ready.find((item) => item.installationId === movedTo.installationId) : undefined)
    ?? ready.find((item) => item.name === movedTo.machine);
  if (machine) return machine.id;
  return movedTo.machine === here.name ? 'local' : undefined;
}
