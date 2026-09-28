/** One turn through a directly addressable model API. */
import { randomUUID } from 'node:crypto';
import chalk from 'chalk';
import type { AiHarnessAccount } from '../harness/definition.js';
import type { HarnessSession, HarnessState } from '../session/model.js';
import { prepareSessionTitle, titleStreamForAttempt } from '../session/title.js';
import { sessionTranscriptMessages } from './checkpoint.js';
import { startTurnCheckpoint, completeTurnCheckpoint, nextUsableFailoverAccount, type TurnRunOptions } from './runtime.js';
import { writeState } from '../session/state/write.js';
import { streamLocalAiTurn } from '../runtime/lazy-bridge.js';
import { localApiKey } from '../daemon/server.js';
import { accountSwitchNotice, accountSwitchPhase, classifyAccountFailure, type AccountFailureKind } from './failover.js';
import { recordQuotaRefusal, recordSuccessfulAccountTurn } from './account-outcome.js';
import { initialAccountChoice, matchesDirectTurnModel, terminalFailoverError } from './account-routing.js';
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
  const attemptedAccounts = new Set<string>();
  try {
  const initial = initialAccountChoice(
    state, account, session.accountFailover, (item) => matchesDirectTurnModel(item, model), attemptedAccounts,
  );
  if (initial.kind === 'exhausted') { await writeState(state); throw initial.error; }
  if (initial.kind === 'switch') {
    const fallback = initial.account;
    switchedFrom = account.label;
    prompter?.activity(chalk.yellow(accountSwitchNotice('quota-exhausted', fallback.label)));
    prompter?.phase(accountSwitchPhase(fallback.label));
    account = fallback;
    session.accountId = fallback.id;
    await checkpoint.persistNow();
  }
  const invoke = (active: AiHarnessAccount) => {
    // A retry is a new response attempt. Clear any partial text from the
    // exhausted account, then append each real provider delta directly to the
    // checkpoint/UI. The router has always exposed onDelta;
    // omitting it here was why direct-API responses appeared only at the end.
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
  /** Whether any account here actually ran out, as opposed to failing some
   * other way -- decides whether "Usage Exhausted" is the truth at the end. */
  let exhaustedAnyApiAccount = false;
  let lastOtherApiFailure: unknown;
  for (;;) {
    // Same rule as the native loop above. This path re-sends the whole prompt
    // on a switch, title request included, so the stream restarts rather than
    // being dropped -- which is a consequence of the rule, not a second rule.
    titleStream = titleStreamForAttempt(titleStream, turnText, session);
    try {
      turn = await invoke(account);
      break;
    } catch (error) {
      const failureKind = classifyAccountFailure(error);
      if (failureKind === 'authentication-required') {
        account.status = 'needs_login';
        await writeState(state);
      }
      // Same rules as the vendor-CLI path above, both of them: a rejected
      // request is not an account problem and no other account will accept
      // it either, so surface it rather than walking the list; otherwise move
      // to the next account that has usage whatever went wrong, and only call
      // an account spent when it actually refused for quota.
      if (failureKind === 'request-invalid') throw error;
      if (session.accountFailover !== 'on-quota-exhausted') throw error;
      const exhaustedAccount = account;
      if (failureKind === 'quota-exhausted') {
        recordQuotaRefusal(state, exhaustedAccount, error);
        exhaustedAnyApiAccount = true;
      } else lastOtherApiFailure = error;
      attemptedAccounts.add(exhaustedAccount.id);
      // Preserve every failed candidate before looking for the next one. A
      // chain of stale account records therefore terminates instead of merely
      // moving the same failure to one alternate and abandoning the router.
      await writeState(state);
      const fallback = await nextUsableFailoverAccount(
        state, exhaustedAccount,
        (item) => matchesDirectTurnModel(item, model),
        attemptedAccounts,
      );
      if (!fallback) {
        await writeState(state);
        throw terminalFailoverError({
          state, current: exhaustedAccount, attempted: attemptedAccounts,
          matchesBackend: (item) => matchesDirectTurnModel(item, model),
          exhaustedAny: exhaustedAnyApiAccount, lastFailure: error, lastOtherFailure: lastOtherApiFailure,
        });
      }
      switchedFrom = exhaustedAccount.label;
      switchReason = failureKind;
      prompter?.activity(chalk.yellow(accountSwitchNotice(failureKind, fallback.label)));
      prompter?.phase(accountSwitchPhase(fallback.label));
      account = fallback;
      session.accountId = fallback.id;
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
