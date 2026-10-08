/** One turn through a directly addressable model API. */
import type { AiHarnessAccount } from '../harness/definition.js';
import type { HarnessSession, HarnessState } from '../session/model.js';
import { prepareSessionTitle, titleStreamForAttempt } from '../session/title.js';
import { sessionTranscriptMessages } from './checkpoint.js';
import { textTranscript } from './turn-activities.js';
import { startTurnCheckpoint, completeTurnCheckpoint } from './turn-journal.js';
import type { TurnRunOptions } from './session-turn.js';
import { streamLocalAiTurn } from '../runtime/lazy-bridge.js';
import { localApiKey } from '../daemon/server.js';
import { classifyAccountFailure } from './failover.js';
import { recordSuccessfulAccountTurn } from './account-outcome.js';
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
}): Promise<void> {
  const { state, session, model, text, prepared, startedAt, signal, run } = input;
  let { account, turnText } = input;
  const prompter = run.prompter;
  if (prepared.images.length) throw new Error('Image attachments need a vendor harness that accepts images; direct API-key accounts do not. Switch providers with /provider or clear them with /attachments clear.');
  if (!model) throw new Error('local AI session has no model selected');
  const baseMessages = textTranscript(sessionTranscriptMessages(session));
  // No harness on this path writes its own titles. One turn asks, once the
  // user has said enough to name the chat, and no other turn touches the reply.
  const directTitle = prepareSessionTitle(session, turnText);
  turnText = directTitle.prompt;
  let titleStream = directTitle.stream;
  const checkpoint = await startTurnCheckpoint(state, session, text, run);
  const accounts = turnAccounts({
    state, session, prompter, matchesBackend: (item) => matchesDirectTurnModel(item, model),
    persist: () => checkpoint.persistNow(), current: () => account, adopt: (to) => { account = to; },
  });
  const sink = turnSink(checkpoint, prompter, { title: () => titleStream });
  try {
  await accounts.start();
  const invoke = (active: AiHarnessAccount) => {
    // A retry is a new response attempt: this path re-sends the whole prompt,
    // so the partial answer from the account that failed is cleared first.
    // Each provider delta then goes straight to the checkpoint and the screen.
    checkpoint.response('', 'replace');
    prompter?.response('', 'replace');
    return streamLocalAiTurn({
      provider: session.provider ?? active.provider, model, apiKey: localApiKey(active),
      messages: [...baseMessages, { role: 'user', content: turnText }], reasoningEffort: session.effort,
      ...(signal ? { abortSignal: signal } : {}),
      onDelta: (delta: string) => sink.response(delta),
    });
  };
  let turn: Awaited<ReturnType<typeof streamLocalAiTurn>>;
  for (;;) {
    // Same rule as the vendor path. This path re-sends the whole prompt on a
    // switch, title request included, so the stream restarts rather than
    // being dropped -- which is a consequence of the rule, not a second rule.
    titleStream = titleStreamForAttempt(titleStream, turnText);
    try {
      turn = await invoke(account);
      break;
    } catch (error) {
      const failureKind = classifyAccountFailure(error);
      await accounts.switchTo(await accounts.after(error, failureKind, signal), failureKind);
    }
  }
  const invocation = recordInvocation(state, {
    sessionId: session.id, accountId: account.id, provider: session.provider ?? account.provider, model, startedAt,
    usage: { input: turn.usage.inputTokens, output: turn.usage.outputTokens },
  });
  recordSuccessfulAccountTurn(state, account, invocation);
  const completedText = await completeTurnCheckpoint(session, checkpoint, turn.text, { title: titleStream?.title, asked: titleStream !== undefined });
  if (!prompter) emitHarnessOutput({ session, text: completedText, toolCalls: turn.toolCalls, usage: turn.usage, invocation, ...accounts.switched() });
  } finally {
    await checkpoint.flush();
  }
}
