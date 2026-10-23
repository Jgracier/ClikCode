/** One turn through a directly addressable model API. */
import type { AiHarnessAccount } from '../harness/definition.js';
import type { HarnessSession, HarnessState } from '../session/model.js';
import { sessionTranscriptMessages } from './checkpoint.js';
import { textTranscript } from './turn-activities.js';
import { lifecycle } from '../runtime/lifecycle-log.js';
import { liveCallsForSwitch } from './live-settings.js';
import { startTurnCheckpoint, completeTurnCheckpoint, discardInterruptedTurn } from './turn-journal.js';
import type { TurnRunOptions } from './session-turn.js';
import { streamLocalAiTurn } from '../runtime/lazy-bridge.js';
import { localApiKey } from '../gateway/credentials.js';
import { switchAccountAfterFailure } from './account-switch.js';
import { unfinishedUsageRecorder } from './turn-steps.js';
import { recordSuccessfulAccountTurn } from './account-outcome.js';
import { isTurnCancelled, turnCancelledError } from '../agent/cancellation.js';
import { matchesDirectTurnModel, turnAccounts } from './account-routing.js';
import { recordInvocation, turnSink } from './turn-output.js';
import { emitHarnessOutput } from '../harness/output.js';
import type { prepareAttachments } from '../session/attachments.js';

export async function sendDirectApiTurn(input: {
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
}): Promise<'switch' | void> {
  const { state, session, text, prepared, startedAt, signal, run } = input;
  let { account, model } = input;
  const { turnText } = input;
  const prompter = run.prompter;
  if (prepared.images.length) throw new Error('Image attachments need a vendor harness that accepts images; direct API-key accounts do not. Switch providers with /provider or clear them with /attachments clear.');
  if (!model) throw new Error('local AI session has no model selected');
  const baseMessages = textTranscript(sessionTranscriptMessages(session));
  const checkpoint = await startTurnCheckpoint(state, session, text, run);
  // The account this turn holds now. A later failover changes the account it runs;
  // only a different id in the live settings is the user's choice.
  let seenAccountId: string | null | undefined = account.id;
  const accounts = turnAccounts({
    state, session, prompter, matchesBackend: (item) => Boolean(model && matchesDirectTurnModel(item, model)),
    persist: () => checkpoint.persistNow(), current: () => account, adopt: (to) => { account = to; },
  });
  const sink = turnSink(checkpoint, prompter);
  // A provider that fails mid-answer reports no usage, but what it streamed was
  // generated and billed: counted from the text (about four characters a token).
  let streamedChars = 0;
  let promptChars = 0;
  const recordUnfinished = unfinishedUsageRecorder(state, checkpoint, () => {
    const output = Math.ceil(streamedChars / 4);
    const input = Math.ceil(promptChars / 4);
    streamedChars = 0;
    if (!output) return undefined;
    return { sessionId: session.id, accountId: account.id, provider: session.provider ?? account.provider, model, startedAt, usage: { input, output } };
  });
  try {
  await accounts.start();
  const invoke = (active: AiHarnessAccount) => {
    // A retry is a new response attempt: this path re-sends the whole prompt,
    // so the partial answer from the account that failed is cleared first.
    // Each provider delta then goes straight to the checkpoint and the screen.
    checkpoint.response('', 'replace');
    prompter?.response('', 'replace');
    const messages = [...baseMessages, { role: 'user', content: turnText }];
    promptChars = messages.reduce((sum, message) => sum + message.content.length, 0);
    return streamLocalAiTurn({
      provider: session.provider ?? active.provider, model, apiKey: localApiKey(active),
      messages, reasoningEffort: session.effort,
      ...(signal ? { abortSignal: signal } : {}),
      onDelta: (delta: string) => { streamedChars += delta.length; sink.response(delta); },
    });
  };
  let turn: Awaited<ReturnType<typeof streamLocalAiTurn>>;
  for (;;) {
    const live = run.liveSettings;
    if (liveCallsForSwitch(live, { route: session.route, accountId: account.id, accountProvider: account.provider }, state.accounts)) {
      const progressed = Boolean(session.pendingTurn?.response?.trim() || session.pendingTurn?.outputStarted);
      if (progressed) await completeTurnCheckpoint(session, checkpoint, session.pendingTurn?.response ?? '');
      else await discardInterruptedTurn(session.id, text);
      lifecycle('turn.switch', { route: live?.route, ...(live?.accountId ? { account: String(live.accountId).slice(0, 8) } : {}) });
      return 'switch';
    }
    if (live && live.accountId !== seenAccountId) {
      seenAccountId = live.accountId;
      const next = live.accountId ? state.accounts.find((item) => item.id === live.accountId && item.provider === account.provider) : undefined;
      if (next && next.id !== account.id) { account = next; session.accountId = next.id; }
    }
    if (live && live.model !== undefined && live.model !== model) { model = live.model; session.model = model; }
    if (live?.effort !== undefined && live.effort !== session.effort) session.effort = live.effort;
    if (!model) throw new Error('local AI session has no model selected');
    try {
      turn = await invoke(account);
      break;
    } catch (error) {
      // Stopping is an outcome, not an account failure: never classified, never retried elsewhere.
      if (isTurnCancelled(error) || signal?.aborted) { recordUnfinished('stopped'); throw turnCancelledError(); }
      // This attempt's tokens were spent whether the turn then moves on or ends.
      recordUnfinished('error');
      await switchAccountAfterFailure({ accounts, from: account, failure: error, signal, harness: 'direct' });
    }
  }
  const invocation = recordInvocation(state, {
    sessionId: session.id, accountId: account.id, provider: session.provider ?? account.provider, model, startedAt,
    usage: { input: turn.usage.inputTokens, output: turn.usage.outputTokens },
  });
  recordSuccessfulAccountTurn(account);
  const completedText = await completeTurnCheckpoint(session, checkpoint, turn.text);
  if (!prompter) emitHarnessOutput({ session, text: completedText, toolCalls: turn.toolCalls, usage: turn.usage, invocation, ...accounts.switched() });
  } finally {
    await checkpoint.flush();
  }
}
