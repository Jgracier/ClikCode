/** One turn through a directly addressable model API. */
import type { AiHarnessAccount } from '../harness/definition.js';
import { sessionTranscriptMessages } from './checkpoint.js';
import { textTranscript } from './turn-activities.js';
import { startTurnCheckpoint, completeTurnCheckpoint } from './turn-journal.js';
import type { AccountTurnInput } from './session-turn.js';
import { streamLocalAiTurn } from '../runtime/lazy-bridge.js';
import { localApiKey } from '../gateway/credentials.js';
import { switchAccountAfterFailure } from './account-switch.js';
import { unfinishedUsageRecorder } from './turn-steps.js';
import { recordSuccessfulAccountTurn } from './account-outcome.js';
import { isTurnCancelled, turnCancelledError } from '../agent/cancellation.js';
import { matchesDirectTurnModel, turnAccounts } from './account-routing.js';
import { recordInvocation, turnSink } from './turn-output.js';
import { emitHarnessOutput } from '../harness/output.js';

export async function sendDirectApiTurn(input: AccountTurnInput): Promise<void> {
  const { state, session, model, text, prepared, startedAt, signal, run } = input;
  let { account } = input;
  const { turnText } = input;
  const prompter = run.prompter;
  if (prepared.images.length) throw new Error('Image attachments need a vendor harness that accepts images; direct API-key accounts do not. Switch providers with /provider or clear them with /attachments clear.');
  if (!model) throw new Error('local AI session has no model selected');
  const baseMessages = textTranscript(sessionTranscriptMessages(session));
  const checkpoint = await startTurnCheckpoint(state, session, text, run);
  const accounts = turnAccounts({
    state, session, prompter, matchesBackend: (item) => matchesDirectTurnModel(item, model),
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
