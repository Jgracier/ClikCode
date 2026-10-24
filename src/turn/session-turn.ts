/** A turn of a conversation, on whatever route it is on -- the one entry
 * point every caller uses: a window's worker, a scripted send, the plain
 * console loop. The route decides what runs it: ClikCode's own agent (the
 * Gateway, ClikCode Local) or an account's harness, reached through its
 * vendor CLI or protocol or, for an API key on a model API, directly. */
import type Conf from 'conf';
import { readState } from '../session/state/read.js';
import type { HarnessSession, HarnessState } from '../session/model.js';
import type { AiHarnessAccount } from '../harness/definition.js';
import { isClikCodeAgent } from '../session/route.js';
import { prepareAttachments } from '../session/attachments.js';
import { shellContextBlock } from '../commands/ai/shell-run.js';
import { releaseHeldLocalModel } from '../commands/ai/local-model.js';
import type { LiveTurnInputBroker } from './live-input.js';
import { LiveSettings } from './live-settings.js';
import type { TurnObserver } from './observer.js';
import { turnBackendForAccount } from './account-routing.js';
import { runAgentTurn } from './agent-turn.js';
import { sendDirectApiTurn } from './direct-turn.js';
import { sendVendorTurn } from './vendor-turn.js';
import { isTurnCancelled } from '../agent/cancellation.js';
import { isQueuedTurnAlreadyRun } from './turn-journal.js';
import { TurnRecorder } from '../session/turn-changes.js';
import { stateDirectory } from '../session/store/paths.js';
import { beginTurnClock, currentTurnId, endTurnClock, markTurn, setTurnHarness } from '../runtime/turn-latency.js';
import { randomUUID } from 'node:crypto';
import { homedir, hostname } from 'node:os';
import { localHarnessForCommand } from '../runtime/lazy-bridge.js';
import { turnPermissionMode } from './turn-permission.js';
import { folderExists, missingFolderMessage } from '../runtime/machine-folder.js';
import { movedChatMessage } from '../session/move-chat.js';

/** Options supplied by any caller of a turn. */
export interface TurnRunOptions {
  liveInput?: LiveTurnInputBroker;
  /** What the user changes mid-turn, held by the worker (turn/live-settings.ts). Seeded here. */
  liveSettings?: LiveSettings;
  queuedTurnId?: string;
  /** ClikCode sends this prompt itself, and why: saved with it and drawn as
   * ClikCode's notice instead of the user's message (TranscriptMessage.automatic). */
  automatic?: string;
  /** A worker keeps ONE app-server / ACP child per open session and closes
   * it itself; a turn run anywhere else stays one-shot. */
  persistentTransports?: boolean;
  /** Who is watching this turn, explicitly -- never read from a global. A
   * headless caller (a scripted send, a slash command with no terminal)
   * omits this and gets the plain stdout/emitHarnessOutput fallback. Any
   * TurnObserver, not necessarily a real terminal -- a worker's own
   * broadcaster to its attached clients satisfies this the same way
   * TerminalHarnessPrompter does, structurally. */
  prompter?: TurnObserver;
  /** Set by runSessionTurn, not by callers: the turn's record for /undo. */
  recorder?: TurnRecorder;
  /** Called when the turn's work is over and only its record is left to save. */
  onWorkFinished?: () => void;
  /** The vendor that actually finished this turn, after any mid-turn handoffs. */
  onCompletedHarness?: (harness: string | undefined) => void;
}

/** One turn through an account, as runAccountTurn hands it to the route that
 * runs it (vendor-turn.ts, direct-turn.ts). */
export interface AccountTurnInput {
  state: HarnessState;
  session: HarnessSession;
  account: AiHarnessAccount;
  model: string | null;
  text: string;
  prepared: Awaited<ReturnType<typeof prepareAttachments>>;
  turnText: string;
  startedAt: number;
  signal?: AbortSignal;
  run: TurnRunOptions;
}

const MAX_TURN_HANDOFFS = 8;

/** Chats told this process that Bypass is not available here (runSessionTurn). */
const toldBypassDowngrade = new Set<string>();

export async function runSessionTurn(
  config: Conf, id: string, prompt: string, signal?: AbortSignal, run: TurnRunOptions = {},
): Promise<void> {
  // A turn nobody is timing yet (a scripted send, the console loop) is timed
  // from here; a worker's turn already has its window's clock.
  const ownClock = currentTurnId() === undefined ? randomUUID() : undefined;
  if (ownClock) { beginTurnClock({ turnId: ownClock }); markTurn('submit'); markTurn('accepted'); }
  let outcome = 'completed';
  const state = await readState({ transcripts: [id] });
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  // One live copy: a chat that went on on another machine is read-only here (session/move.ts).
  const moved = movedChatMessage(session);
  if (moved) throw new Error(moved);
  // The one check before anything runs in the chat's folder -- ClikCode's agent, a
  // vendor CLI, an ACP or app-server child. A folder this machine does not have
  // (named by another machine, or removed since) would otherwise surface as
  // `spawn <binary> ENOENT`, which reads as a harness that is not installed.
  // Opening the chat again moves it to this machine's home (session/attach.ts).
  if (session.workspace && !folderExists(session.workspace)) {
    throw new Error(`${missingFolderMessage(session.workspace)}. Open the chat again to continue it in ${homedir()}.`);
  }
  // A mode the harness refuses on this machine (Claude Code's bypass as root) is not sent to fail
  // the turn: the turn runs with the nearest mode it takes (turn-permission.ts), the chat keeps what
  // was chosen, and the user is told once per chat in this process.
  const harness = !isClikCodeAgent(session) && session.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
  if (harness && session.permissionMode === 'bypass') {
    const used = turnPermissionMode(harness, session.permissionMode);
    if (used !== 'bypass' && !toldBypassDowngrade.has(session.id)) {
      toldBypassDowngrade.add(session.id);
      run.prompter?.activity(`Bypass is not available for ${harness.displayName} running as root on ${hostname()}; this turn uses ${used === 'auto' ? 'Auto' : 'Ask'}. The chat keeps Bypass.`);
    }
  }
  setTurnHarness(session.nativeHarness ?? session.route);
  // A session that left ClikCode Local lets go of the model this process
  // held for it (a worker that ran its earlier turns, say).
  if (session.route !== 'clikcode-local') await releaseHeldLocalModel(session.id);
  // Every turn that starts is recorded when it ends, however it ends and
  // whatever ran it (a worker, a script, the console loop), edits or none:
  // /undo acts on the conversation's actual last turn, with the store of the
  // route that turn ran on (session/turn-changes.ts).
  const agent = isClikCodeAgent(session);
  const recorder = new TurnRecorder(prompt.trim(), agent ? 'agent' : 'reported');
  // Seeded from the conversation as it is stored now; from here the turn reads this, never the state file.
  const liveSettings = run.liveSettings ?? new LiveSettings(session);
  liveSettings.seed(session);
  const recorded = { ...run, recorder, liveSettings };
  try {
    // A provider or account change between steps continues this same request
    // there, the way a usage-limit failover does. A change that did not land
    // stops the handoff. Bound repeated changes, but never report a dropped
    // continuation as a completed turn.
    let stateNow = state;
    let sessionNow = session;
    for (let hop = 0; hop < MAX_TURN_HANDOFFS; hop += 1) {
      const placed = where(sessionNow);
      if (isClikCodeAgent(sessionNow)) {
        const handed = await runAgentTurn({ config, state: stateNow, session: sessionNow, prompt, signal, run: recorded });
        if (!handed) { run.onCompletedHarness?.(undefined); return; }
      } else {
        const handed = await runAccountTurn(stateNow, sessionNow, prompt, signal, recorded);
        if (handed !== 'switch') return;
      }
      const fresh = await readState({ transcripts: [id] });
      const now = fresh.sessions.find((item) => item.id === id);
      if (!now || where(now) === placed) return;
      setTurnHarness(now.nativeHarness ?? now.route);
      stateNow = fresh;
      sessionNow = now;
    }
    throw new Error(`This turn changed providers or accounts ${MAX_TURN_HANDOFFS} times before it could finish. Send it again after the selection settles.`);
  } catch (error) {
    // Already run by another submit of the same queued entry: nothing to do,
    // and nothing went wrong.
    if (isQueuedTurnAlreadyRun(error)) return;
    outcome = isTurnCancelled(error) ? 'cancelled' : 'error';
    throw error;
  } finally {
    markTurn('end', { outcome });
    run.onWorkFinished?.();
    if (ownClock) endTurnClock(ownClock);
    // A record that failed to write must not fail the turn it records.
    await recorder.finish(stateDirectory(), id).catch(() => undefined);
  }
}

/** Where this conversation runs, for telling a real move from a handoff that did not land. */
function where(session: HarnessSession): string {
  return [session.route, session.nativeHarness ?? '', session.accountId ?? ''].join('|');
}

/** A turn through the session's account: its harness, or a model API.
 * `'switch'` means the user moved it before the next attempt, and the caller continues the same request. */
async function runAccountTurn(
  state: HarnessState, session: HarnessSession, prompt: string, signal: AbortSignal | undefined, run: TurnRunOptions,
): Promise<'switch' | void> {
  if (!session.accountId) throw new Error('local AI session has no account selected');
  const account = state.accounts.find((item) => item.id === session.accountId);
  if (!account) throw new Error('local AI session account was removed');
  let model: string | null = session.model ?? account.models[0] ?? null;
  if (model && account.models.length > 0 && !account.models.includes(model)) {
    throw new Error(`model "${model}" is not available through local account "${account.label}"`);
  }
  const text = prompt.trim();
  if (!text) throw new Error('prompt is required');
  // The account and its model are settled: what follows is the route's own work.
  markTurn('account');
  const prepared = await prepareAttachments(session.attachments ?? []);
  let turnText = `${text}${prepared.textContext}`;
  // A resumed native-harness thread never replays ClikCode's own transcript
  // (see turn/thread-start.ts and the attachment envelope: the vendor process keeps
  // its own session and ClikCode's `messages` are not passed back in). So `!`
  // output has to ride in like an attachment -- injected here and cleared
  // beside session.attachments, so a resumed vendor still learns what the
  // shell printed. Fresh native threads and the direct/gateway routes replay
  // session.messages and already carry the note; gating on resumed-only keeps
  // it from being delivered twice to them.
  if (session.nativeSessionId && !session.nativeSessionPreallocated) {
    turnText += shellContextBlock(session.shellNotes ?? []);
  }
  const startedAt = Date.now();

  const input = { state, session, account, model, text, prepared, turnText, startedAt, signal, run };
  const backend = turnBackendForAccount(account);
  const handed = backend === 'vendor' ? await sendVendorTurn(input) : await sendDirectApiTurn(input);
  if (handed !== 'switch') run.onCompletedHarness?.(backend === 'vendor' ? session.nativeHarness : undefined);
  return handed;
}
