/** The move of a chat between machines as a client drives it (session/move.ts
 * says what a move is): the requests, and the one order they go in. No state
 * is read here -- each side answers for its own machine -- so the terminal and
 * the editor share it. */
import type { AiHarnessPermissionMode } from '../harness/definition.js';
import type { ChatMovedTo, HarnessSession, TranscriptMessage } from './model.js';

/** A chat as one machine hands it to another. Plain data, sent as JSON. */
export interface ChatExport {
  version: 1;
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
  /** What will not be as it was, one sentence each. Empty: nothing changes. */
  changes: string[];
  /** The folder the chat goes on in there. */
  folder: string;
}

export interface ImportResult extends ImportPlan {
  sessionId: string;
  /** The importing ClikCode's installation id (ChatMovedTo.installationId). */
  installationId: string;
}

/** What a move asks a machine's ClikCode, as the bridge takes it (ide/protocol.ts). */
export type MoveRequest =
  | { type: 'export-chat'; sessionId?: string }
  | { type: 'import-chat'; chat: ChatExport; names: MoveNames; dryRun?: boolean }
  | { type: 'mark-moved'; sessionId: string; movedTo: Omit<ChatMovedTo, 'at'> };

/** A chat that moved is read-only here: what to say instead of acting on it. */
export function movedChatMessage(session: Pick<HarnessSession, 'movedTo'>): string | undefined {
  return session.movedTo ? `This chat moved to ${session.movedTo.machine}; continue it there.` : undefined;
}

/** Whether a chat has anything to move: one nothing was said in is a new chat there instead. */
export function chatHasContent(session: Pick<HarnessSession, 'messages' | 'pendingTurn' | 'listMessageCount'>): boolean {
  return Boolean(session.messages?.length || session.pendingTurn || session.listMessageCount);
}

/** A machine's side of a move: its name and how to ask its ClikCode. */
export interface MoveEnd {
  name: string;
  call<T>(request: MoveRequest): Promise<T>;
}

export type MoveOutcome =
  | { moved: true; sessionId: string; folder: string; changes: string[] }
  | { moved: false };

/** The move itself, from whichever client: export there, plan here, ask only
 * if something changes, import, then mark the old copy moved. `confirm` gets
 * the one sentence that says what changes. */
export async function moveChat(
  source: MoveEnd, target: MoveEnd, sessionId: string, confirm: (text: string) => Promise<boolean>,
): Promise<MoveOutcome> {
  const chat = await source.call<ChatExport>({ type: 'export-chat', sessionId });
  const names = { source: source.name, target: target.name };
  const plan = await target.call<ImportPlan>({ type: 'import-chat', chat, names, dryRun: true });
  if (plan.changes.length && !await confirm(moveConfirmation(target.name, plan.changes))) return { moved: false };
  const imported = await target.call<ImportResult>({ type: 'import-chat', chat, names });
  await source.call({ type: 'mark-moved', sessionId: chat.sessionId, movedTo: { machine: target.name, installationId: imported.installationId, sessionId: imported.sessionId } });
  return { moved: true, sessionId: imported.sessionId, folder: imported.folder, changes: imported.changes };
}

/** What the confirmation says: only what changes. */
export function moveConfirmation(target: string, changes: readonly string[]): string {
  return `Moving to ${target}: ${changes.join(' ')}`;
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
