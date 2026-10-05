/** A turn of a conversation, on whatever route it is on -- the one entry
 * point every caller uses: a window's worker, a scripted send, the plain
 * console loop. The route decides what runs it: ClikCode's own agent (the
 * Gateway, ClikCode Local) or an account's harness, reached through its
 * vendor CLI or protocol or, for an API key on a model API, directly. */
import type Conf from 'conf';
import { readState } from '../session/state/read.js';
import type { HarnessSession, HarnessState } from '../session/model.js';
import { isClikCodeAgent } from '../session/route.js';
import { hermesTurboFitModelId } from '../harness/accounts/hermes-discovery.js';
import { prepareAttachments } from '../session/attachments.js';
import { shellContextBlock } from '../commands/ai/shell-run.js';
import { releaseHeldLocalModel } from '../commands/ai/local-model.js';
import type { LiveTurnInputBroker } from './live-input.js';
import type { TurnObserver } from './observer.js';
import { turnBackendForAccount } from './account-routing.js';
import { runAgentTurn } from './agent-turn.js';
import { sendDirectApiTurn } from './direct-turn.js';
import { sendVendorTurn } from './vendor-turn.js';
import { isQueuedTurnAlreadyRun } from './turn-journal.js';
import { TurnRecorder } from '../session/turn-changes.js';
import { stateDirectory } from '../session/store/paths.js';

/** Options supplied by any caller of a turn. */
export interface TurnRunOptions {
  liveInput?: LiveTurnInputBroker;
  queuedTurnId?: string;
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
}

export async function runSessionTurn(
  config: Conf, id: string, prompt: string, signal?: AbortSignal, run: TurnRunOptions = {},
): Promise<void> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  // A session that left ClikCode Local lets go of the model this process
  // held for it (a worker that ran its earlier turns, say).
  if (session.route !== 'clikcode-local') await releaseHeldLocalModel(session.id);
  // Every turn that starts is recorded when it ends, however it ends and
  // whatever ran it (a worker, a script, the console loop), edits or none:
  // /undo acts on the conversation's actual last turn, with the store of the
  // route that turn ran on (session/turn-changes.ts).
  const agent = isClikCodeAgent(session);
  const recorder = new TurnRecorder(prompt.trim(), agent ? 'agent' : 'reported');
  const recorded = { ...run, recorder };
  try {
    if (agent) return await runAgentTurn({ config, state, session, prompt, signal, run: recorded });
    return await runAccountTurn(state, session, prompt, signal, recorded);
  } catch (error) {
    // Already run by another submit of the same queued entry: nothing to do,
    // and nothing went wrong.
    if (isQueuedTurnAlreadyRun(error)) return;
    throw error;
  } finally {
    // A record that failed to write must not fail the turn it records.
    await recorder.finish(stateDirectory(), id).catch(() => undefined);
  }
}

/** A turn through the session's account: its harness, or a model API. */
async function runAccountTurn(
  state: HarnessState, session: HarnessSession, prompt: string, signal: AbortSignal | undefined, run: TurnRunOptions,
): Promise<void> {
  if (!session.accountId) throw new Error('local AI session has no account selected');
  const account = state.accounts.find((item) => item.id === session.accountId);
  if (!account) throw new Error('local AI session account was removed');
  let model: string | null = session.model ?? account.models[0] ?? null;
  // A model this account lists, spelled as it was listed: TurboFit ids saved
  // before they were corrected to `custom:turbofit:` still count, or a session
  // corrected on its first turn would be refused on its second.
  const listed = (candidate: string): boolean => account!.models.includes(candidate)
    || account!.models.some((item) => hermesTurboFitModelId(item) === candidate);
  if (model && account.models.length > 0 && !listed(model)) {
    throw new Error(`model "${model}" is not available through local account "${account.label}"`);
  }
  const text = prompt.trim();
  if (!text) throw new Error('prompt is required');
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
  if (turnBackendForAccount(account) === 'vendor') return sendVendorTurn(input);
  return sendDirectApiTurn(input);
}
