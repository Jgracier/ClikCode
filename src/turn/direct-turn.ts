/** One turn through a directly addressable model API. */
import { randomUUID } from 'node:crypto';
import chalk from 'chalk';
import type { AiHarnessAccount } from '../harness/definition.js';
import type { HarnessSession, HarnessState } from '../session/model.js';
import { prepareSessionTitle, titleStreamForAttempt } from '../session/title.js';
import { sessionTranscriptMessages } from './checkpoint.js';
import { startTurnCheckpoint, completeTurnCheckpoint } from './turn-journal.js';
import type { TurnRunOptions } from './session-turn.js';
import { writeState } from '../session/state/write.js';
import { streamLocalAiTurn } from '../runtime/lazy-bridge.js';
import { localApiKey } from '../daemon/server.js';
import { accountSwitchNotice, accountSwitchPhase, classifyAccountFailure, type AccountFailureKind } from './failover.js';
import { recordSuccessfulAccountTurn } from './account-outcome.js';
import { accountAfterFailure, initialAccountChoice, matchesDirectTurnModel, turnAccountRecorder, type FailoverTally } from './account-routing.js';
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
  const baseMessages = sessionTranscriptMessages(session);
  // No harness on this path writes its own titles, so the first turns of a
  // conversation ask the model for one and the answer is stripped of it.
  const directTitle = prepareSessionTitle(session, turnText);
  turnText = directTitle.prompt;
  let titleStream = directTitle.stream;
  const checkpoint = await startTurnCheckpoint(state, session, text, run);
  let switchedFrom: string | undefined;
  /** Why the turn left that account: the failure it met there. */
  let switchReason: AccountFailureKind = 'quota-exhausted';
  const tally: FailoverTally = { attempted: new Set(), exhaustedAny: false };
  const onThisModel = (item: AiHarnessAccount): boolean => matchesDirectTurnModel(item, model);
  const recordAccount = turnAccountRecorder(session, () => checkpoint.persistNow());
  const switchAccount = async (to: AiHarnessAccount, why: AccountFailureKind): Promise<void> => {
    prompter?.activity(chalk.yellow(accountSwitchNotice(why, to.label)));
    prompter?.phase(accountSwitchPhase(to.label));
    switchedFrom = account.label;
    switchReason = why;
    account = to;
    await recordAccount(to);
  };
  try {
  const initial = initialAccountChoice(state, account, session.accountFailover, onThisModel, tally.attempted);
  if (initial.kind === 'exhausted') { await writeState(state); throw initial.error; }
  if (initial.kind === 'switch') {
    await switchAccount(initial.account, 'quota-exhausted');
  }
  const invoke = (active: AiHarnessAccount) => {
    // A retry is a new response attempt: this path re-sends the whole prompt,
    // so the partial answer from the account that failed is cleared first.
    // Each provider delta then goes straight to the checkpoint and the screen.
    checkpoint.response('', 'replace');
    prompter?.response('', 'replace');
    return streamLocalAiTurn({
      provider: session.provider ?? active.provider, model, apiKey: localApiKey(active), credentialSource: 'env',
      messages: [...baseMessages, { role: 'user', content: turnText }], reasoningEffort: session.effort as never,
      ...(signal ? { abortSignal: signal } : {}),
      onDelta: (delta: string) => {
        const visible = titleStream ? titleStream.push(delta, 'append') : delta;
        if (visible === undefined) return;
        checkpoint.response(visible, 'append');
        prompter?.response(visible, 'append');
      },
    });
  };
  let turn: Awaited<ReturnType<typeof streamLocalAiTurn>>;
  for (;;) {
    // Same rule as the vendor path. This path re-sends the whole prompt on a
    // switch, title request included, so the stream restarts rather than
    // being dropped -- which is a consequence of the rule, not a second rule.
    titleStream = titleStreamForAttempt(titleStream, turnText, session);
    try {
      turn = await invoke(account);
      break;
    } catch (error) {
      const failureKind = classifyAccountFailure(error);
      const fallback = await accountAfterFailure({
        state, session, account, failure: error, kind: failureKind, signal, matchesBackend: onThisModel, tally,
        persist: () => checkpoint.persistNow(),
        notice: (message) => prompter?.activity(chalk.yellow(message)),
      });
      await switchAccount(fallback, failureKind);
    }
  }
  const invocation = {
    id: randomUUID(), sessionId: session.id, accountId: account.id, provider: session.provider ?? account.provider, model,
    at: new Date().toISOString(), inputTokens: turn.usage.inputTokens,
    outputTokens: turn.usage.outputTokens, latencyMs: Date.now() - startedAt,
  };
  if (prompter && Array.isArray(turn.toolCalls)) {
    for (const call of turn.toolCalls) {
      const name = call && typeof call.name === 'string' ? call.name : 'tool';
      // The tool's own name, with nothing in front of it -- the same rule the
      // native-harness rows follow. This is the Gateway/direct-API path, and
      // it was the one place still prepending a status word.
      prompter.activity(chalk.dim(name));
    }
  }
  state.invocations.push(invocation);
  recordSuccessfulAccountTurn(state, account, invocation.at);
  const completedText = await completeTurnCheckpoint(session, checkpoint, turn.text, { title: titleStream?.title });
  if (!prompter) emitHarnessOutput({ session, text: completedText, toolCalls: turn.toolCalls, usage: turn.usage, invocation, ...(switchedFrom ? { accountSwitchedFrom: switchedFrom, reason: switchReason } : {}) });
  } finally {
    await checkpoint.flush();
  }
}
