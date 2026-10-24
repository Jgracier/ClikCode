/** Reusable vendor processes. */
import { createCodexSession } from '../harness/transport/codex-app-server.js';
import { createAcpSession } from '../harness/transport/acp-client.js';
import type { AiHarnessAccount, AiLocalHarnessDefinition } from '../harness/definition.js';
import type { HarnessAvailableCommand } from '../harness/events/turn-observer.js';
import type { HarnessTurnTransport } from '../harness/transport/select.js';
import type { CodexSession } from '../harness/transport/codex-app-server.js';
import type { AcpSession } from '../harness/transport/acp-client.js';
import type { VendorBackgroundTurn, VendorBackgroundTurnHandler } from '../harness/transport/background-turn.js';
import { outOfTurnRecorder } from './out-of-turn-record.js';
import type { OutOfTurnRelay } from '../harness/transport/background-turn.js';
import { retiredHeldAgentCount } from '../harness/transport/native/held-vendor.js';
import type { EndedWork } from '../harness/transport/handoff-work.js';

/** ACP `available_commands_update`, per ClikCode session, for the slash registry. */
export const nativeAvailableCommands = new Map<string, readonly HarnessAvailableCommand[]>();
export function sessionNativeCommands(sessionId: string): readonly HarnessAvailableCommand[] {
  return nativeAvailableCommands.get(sessionId) ?? [];
}

interface PersistentTransport { key: string; transport: HarnessTurnTransport; session: CodexSession | AcpSession }
export const persistentTransports = new Map<string, PersistentTransport>();
/** Test seam: the transport session factories. */
const TRANSPORT_SESSIONS = { codex: createCodexSession, acp: createAcpSession };

/** Who receives the work a persistent vendor does between ClikCode turns
 * (harness/transport/background-turn.ts), per ClikCode session. The session
 * worker registers here; without a registration that work is not surfaced. */
/** Who handles what a vendor says out of turn, per conversation: the session worker (records it and
 * tells every window). Without one the text is only recorded. */
const outOfTurnHandlers = new Map<string, OutOfTurnRelay>();
export function setOutOfTurnHandler(sessionId: string, handler: OutOfTurnRelay | undefined): void {
  if (handler) outOfTurnHandlers.set(sessionId, handler);
  else outOfTurnHandlers.delete(sessionId);
}
const outOfTurnFor = (sessionId: string): OutOfTurnRelay => {
  const record = outOfTurnRecorder(sessionId);
  return (said) => { const handler = outOfTurnHandlers.get(sessionId); if (handler) handler(said); else void record(said); };
};

/** Who answers for work a vendor process ran after the conversation left it, and for agents the
 * usage limit cut off (handoff-work.ts), per conversation: the session worker (each becomes a
 * notification turn on the account the conversation is on now). `from` is the process's harness
 * and account. */
export type WorkEndedHandler = (ended: readonly EndedWork[], from: { harness?: string; accountId?: string }) => void;
const workEndedHandlers = new Map<string, WorkEndedHandler>();
export function setWorkEndedHandler(sessionId: string, handler: WorkEndedHandler | undefined): void {
  if (handler) workEndedHandlers.set(sessionId, handler);
  else workEndedHandlers.delete(sessionId);
}
/** Tell `sessionId`'s handler of work that ended outside a persistent child: the agents of a held
 * CLI process a turn did not wait for (turn-steps.ts settleHeldVendor). */
export function reportEndedWork(sessionId: string, ended: readonly EndedWork[], from: { harness?: string; accountId?: string } = {}): void {
  if (!ended.length) return;
  try { workEndedHandlers.get(sessionId)?.(ended, from); } catch { /* fail-open-ok: the owner's bookkeeping */ }
}
/** The harness and account a child key (vendorChildKey) was made for. */
function keyOwner(key: string): { harness?: string; accountId?: string } {
  try {
    const [harness, accountId] = JSON.parse(key) as unknown[];
    return { ...(typeof harness === 'string' ? { harness } : {}), ...(typeof accountId === 'string' ? { accountId } : {}) };
  } catch { return {}; }
}

/** The options every vendor child of `sessionId` is made with. */
function childOptions(sessionId: string, key: string) {
  return {
    backgroundTurns: (turn: VendorBackgroundTurn) => vendorBackgroundTurnHandlers.get(sessionId)?.(turn),
    outOfTurn: outOfTurnFor(sessionId),
    workEnded: (ended: readonly EndedWork[]) => {
      workEndedHandlers.get(sessionId)?.(ended, keyOwner(key));
      retiredWorkChanged(sessionId);
    },
  };
}

const vendorBackgroundTurnHandlers = new Map<string, VendorBackgroundTurnHandler>();
export function setVendorBackgroundTurnHandler(sessionId: string, handler: VendorBackgroundTurnHandler | undefined): void {
  if (handler) vendorBackgroundTurnHandlers.set(sessionId, handler);
  else vendorBackgroundTurnHandlers.delete(sessionId);
}
/** The registered receiver, if any: a transport that can only hand work over
 * when someone will show it (native/held-vendor.ts) asks first. */
export function vendorBackgroundTurnHandlerFor(sessionId: string): VendorBackgroundTurnHandler | undefined {
  return vendorBackgroundTurnHandlers.get(sessionId);
}

/** Everything a vendor child was started with that a later turn must match
 * to reuse it: its harness, the account and the sign-in it holds, the
 * profile environment, and the working directory. */
export function vendorChildKey(
  harness: AiLocalHarnessDefinition, account: AiHarnessAccount, environment: Readonly<Record<string, string>>, workspace: string | undefined,
): string {
  return JSON.stringify([harness.command, account.id, account.signedInAt, environment, workspace]);
}

/** One live child per open ClikCode session, keyed by everything that makes a
 * child reusable (harness, account, profile env, cwd). A different key closes
 * the old child first, which is what covers account/harness/cwd changes. */
export function persistentTransportFor(sessionId: string, transport: HarnessTurnTransport, key: string): PersistentTransport {
  const existing = persistentTransports.get(sessionId);
  if (existing && existing.key === key && existing.transport === transport) return existing;
  if (existing) void leaveTransport(sessionId, existing);
  // A standby opened for exactly this launch (prepareAcpStandby) becomes the
  // live child: its agent is started and its thread loaded already.
  const standby = standbyTransports.get(sessionId);
  if (standby && standby.transport.key === key && standby.transport.transport === transport) {
    standbyTransports.delete(sessionId);
    persistentTransports.set(sessionId, standby.transport);
    return standby.transport;
  }
  const background = childOptions(sessionId, key);
  const created: PersistentTransport = {
    key, transport, session: transport === 'codex-app-server' ? TRANSPORT_SESSIONS.codex(background) : TRANSPORT_SESSIONS.acp(background),
  };
  persistentTransports.set(sessionId, created);
  return created;
}

export function hasPersistentTransport(sessionId: string): boolean {
  return persistentTransports.has(sessionId);
}

/** Processes a conversation left with work still running in them (leavePersistentTransport). */
const retiredTransports = new Map<string, Set<PersistentTransport>>();

/** The retired processes of `sessionId` still running work; the rest are forgotten. */
async function retiredRunning(sessionId: string): Promise<PersistentTransport[]> {
  const set = retiredTransports.get(sessionId);
  if (!set) return [];
  const running: PersistentTransport[] = [];
  for (const retired of [...set]) {
    if (await retired.session.backgroundWorkRunning().catch(() => false)) running.push(retired);
    else set.delete(retired);
  }
  if (!set.size) retiredTransports.delete(sessionId);
  return running;
}

/** Whether work this session's vendors started is still running -- in the process the conversation
 * uses, or one it left: its worker stays up for it rather than ending it. */
export async function persistentWorkRunning(sessionId: string): Promise<boolean> {
  if (await persistentTransports.get(sessionId)?.session.backgroundWorkRunning?.().catch(() => false)) return true;
  if (retiredHeldAgentCount(sessionId) > 0) return true;
  return (await retiredRunning(sessionId)).length > 0;
}

/** Who is told what the processes a conversation left still run (the session worker: a list shows
 * the conversation working while they do). */
type RetiredWorkListener = (work: { agents: number; terminals: number }) => void;
const retiredWorkListeners = new Map<string, RetiredWorkListener>();
export function setRetiredWorkListener(sessionId: string, listener: RetiredWorkListener | undefined): void {
  if (listener) retiredWorkListeners.set(sessionId, listener);
  else retiredWorkListeners.delete(sessionId);
}
/** Tell the listener what `sessionId`'s retired processes run now. */
export function retiredWorkChanged(sessionId: string): void {
  const listener = retiredWorkListeners.get(sessionId);
  if (!listener) return;
  const work = { agents: 0, terminals: 0 };
  for (const retired of retiredTransports.get(sessionId) ?? []) {
    work.agents += retired.session.retiredWork.agents;
    work.terminals += retired.session.retiredWork.terminals;
  }
  work.agents += retiredHeldAgentCount(sessionId);
  try { listener(work); } catch { /* fail-open-ok: the owner's bookkeeping */ }
}

/** Retire `live` (persistent-session.ts retire) when it still runs work, else close it. */
async function leaveTransport(sessionId: string, live: PersistentTransport): Promise<void> {
  if (await live.session.retire().catch(() => false)) {
    const set = retiredTransports.get(sessionId) ?? new Set<PersistentTransport>();
    set.add(live);
    retiredTransports.set(sessionId, set);
    retiredWorkChanged(sessionId);
    return;
  }
  await live.session.close().catch(() => undefined);
}

/** The conversation is moving off its vendor process -- another account, provider, workspace or
 * sign-in. Nothing that process runs is waited on, and nothing is killed: work still running stays
 * with it, and its end is told to the conversation's account of the moment (setWorkEndedHandler). */
export async function leavePersistentTransport(sessionId: string, only?: { accountId: string }): Promise<void> {
  const live = persistentTransports.get(sessionId);
  if (!live) return;
  // Only the process on that account: by now the conversation may run on another's.
  if (only && keyOwner(live.key).accountId !== only.accountId) return;
  persistentTransports.delete(sessionId);
  await leaveTransport(sessionId, live);
}

/** End this session's vendor processes and their work (a stop, a closing worker); every session's
 * when `sessionId` is undefined. */
export async function closePersistentTransport(sessionId?: string): Promise<void> {
  // Everything at once (the worker going away): standbys too.
  if (sessionId === undefined) await Promise.all([...standbyTransports.keys()].map((id) => closeStandby(id)));
  const ids = sessionId === undefined ? [...new Set([...persistentTransports.keys(), ...retiredTransports.keys()])] : [sessionId];
  await Promise.all(ids.map(async (id) => {
    const live = persistentTransports.get(id);
    const retired = [...retiredTransports.get(id) ?? []];
    retiredTransports.delete(id);
    if (live) persistentTransports.delete(id);
    await Promise.all([live, ...retired].map((item) => item?.session.close().catch(() => undefined)));
    if (retired.length) retiredWorkChanged(id);
  }));
}

/** A second vendor child per ClikCode session, opened for the account a
 * failover would move to while the current account's turn runs: its agent
 * started and the thread loaded, so a refusal hands the turn over without a
 * cold start (seconds: a Claude session connects every MCP server first). */
interface StandbyTransport { accountId: string; transport: PersistentTransport; ready: Promise<boolean> }
const standbyTransports = new Map<string, StandbyTransport>();

/** The standby for `sessionId`, if one was opened for `accountId`. */
export function standbyFor(sessionId: string, accountId: string): StandbyTransport | undefined {
  const standby = standbyTransports.get(sessionId);
  return standby?.accountId === accountId ? standby : undefined;
}

/** Open a standby: `prepare` runs the session up to the prompt on it. */
export function openStandby(sessionId: string, accountId: string, transport: HarnessTurnTransport, key: string,
  prepare: (session: CodexSession | AcpSession) => Promise<void>): StandbyTransport {
  void closeStandby(sessionId);
  const background = childOptions(sessionId, key);
  const created: PersistentTransport = {
    key, transport, session: transport === 'codex-app-server' ? TRANSPORT_SESSIONS.codex(background) : TRANSPORT_SESSIONS.acp(background),
  };
  const standby: StandbyTransport = {
    accountId, transport: created,
    ready: prepare(created.session).then(() => true, () => {
      // A standby that could not be prepared is no standby: the failover
      // takes the ordinary path.
      if (standbyTransports.get(sessionId) === standby) void closeStandby(sessionId);
      return false;
    }),
  };
  standbyTransports.set(sessionId, standby);
  return standby;
}

/** Close the standby for `sessionId`, if one is open and was not taken up. */
export async function closeStandby(sessionId: string): Promise<void> {
  const standby = standbyTransports.get(sessionId);
  if (!standby) return;
  standbyTransports.delete(sessionId);
  await standby.transport.session.close().catch(() => undefined);
}
