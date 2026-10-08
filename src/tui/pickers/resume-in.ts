/** "Resume in": every account on this chat's harness is out of usage, so the
 * chat continues on another harness that still has some.
 *
 * Failover only ever moves between accounts of one harness. When the last of
 * them runs out, the chat used to stop at "All accounts exhausted" and the
 * user had to know that `/<harness>` would carry it elsewhere. This offers
 * the harnesses with an account that has usage left, then that harness's
 * models; choosing a model moves the conversation there (the same move
 * `/<harness>` makes) and the caller resends the message that ran out. */

import { join } from 'node:path';
import type { AiHarnessAccount, AiLocalHarnessDefinition } from '../../harness/definition.js';
import type { HarnessPrompter, PickerOption } from '../../harness/prompter.js';
import { nativeModelCatalogForPicker } from '../../harness/accounts/model-catalog.js';
import { allLocalHarnesses, harnessCanRunTurns, harnessTierRank } from '../../runtime/lazy-bridge.js';
import { readState } from '../../session/state/read.js';
import { writeState } from '../../session/state/write.js';
import { moveToProvider, takeQueuedMessages } from '../../commands/ai/conversations.js';
import { preferredAccountId } from '../../commands/ai/preferred-account.js';
import { INTERRUPTED_TURN_REQUEST } from '../../turn/failover-prompt.js';
import { nextQuotaReset, type ResumeAt } from '../../turn/usage-exhausted.js';
import { quotaResetPhrase } from '../../harness/protocol/format.js';
import { chooseOption } from './choose.js';
import { accountCanTakeTurn } from '../../harness/accounts/usage-reading.js';
import { matchesVendorTurn } from '../../turn/account-routing.js';
import type { HarnessSession } from '../../session/model.js';
import { withFileLock } from '../../session/store/locks.js';
import { safeRecordFileName, sessionsDirectory } from '../../session/store/paths.js';

/** An account that can take a turn now -- the one rule failover uses too. */
export function accountHasUsage(account: AiHarnessAccount): boolean {
  return accountCanTakeTurn(account);
}

/** Whether an account of the chat's own provider can take the turn. While
 * one can, the same-provider switch is the one to make, not another provider. */
export function sessionProviderHasUsage(accounts: readonly AiHarnessAccount[], provider: string | null | undefined): boolean {
  return accounts.some((account) => account.provider === provider && matchesVendorTurn(account) && accountHasUsage(account));
}

export async function sameProviderCanTakeTurn(id: string): Promise<boolean> {
  const state = await readState({ transcripts: [id] });
  const session = state.sessions.find((item) => item.id === id);
  return session ? sessionProviderHasUsage(state.accounts, session.provider) : false;
}

/** Harnesses other than `current` with an account that has usage, best
 * tier first, each with those accounts. */
export function resumeInCandidates(
  harnesses: readonly AiLocalHarnessDefinition[], accounts: readonly AiHarnessAccount[], current: string | undefined,
  rank: (harness: AiLocalHarnessDefinition) => number,
): { harness: AiLocalHarnessDefinition; accounts: AiHarnessAccount[] }[] {
  return harnesses
    .filter((harness) => harness.command !== current)
    .map((harness) => ({ harness, accounts: accounts.filter((account) => account.provider === harness.provider && accountHasUsage(account)) }))
    .filter((candidate) => candidate.accounts.length > 0)
    .sort((left, right) => rank(left.harness) - rank(right.harness) || left.harness.displayName.localeCompare(right.harness.displayName));
}

/** The "Wait for reset" row's value: no harness command starts with a NUL. */
const WAIT_FOR_RESET = '\u0000wait';

/** Returns the new conversation's id, `{ waiting }` when the user chose to
 * wait for this provider's reset (parked on the session; the worker sends it
 * then), or undefined when there is nowhere to go or the user backs out (the
 * chat then stays as it was). */
export async function interactiveResumeInPicker(
  rl: HarnessPrompter, id: string, prompt: string, sent = prompt, now: number = Date.now(),
): Promise<ResumedIn | { waiting: ResumeAt } | undefined> {
  // Index for every chat's last model; this chat's transcript is not needed
  // to list other harnesses with usage left.
  const state = await readState({ transcripts: [] });
  const session = state.sessions.find((item) => item.id === id);
  if (!session) return undefined;
  // Another provider is the answer only when this one has nothing left.
  if (sessionProviderHasUsage(state.accounts, session.provider)) return undefined;
  const candidates = resumeInCandidates(allLocalHarnesses().filter(harnessCanRunTurns), state.accounts, session.nativeHarness, harnessTierRank);
  const spent = state.accounts.filter((account) => account.provider === session.provider);
  const reset = nextQuotaReset(spent, now);
  if (!candidates.length && !reset) return undefined;
  const title = candidates.length
    ? `All accounts exhausted${reset ? ` · back ${quotaResetPhrase(reset, now)}` : ''} — resume in`
    : `All accounts exhausted · back ${quotaResetPhrase(reset!, now)}`;
  for (;;) {
    const command = await chooseOption(rl, title, [
      ...candidates.map(({ harness, accounts }): PickerOption<string> => ({
        label: harness.displayName,
        detail: `· ${accounts.slice(0, 2).map((account) => account.label).join(', ')}${accounts.length > 2 ? ` +${accounts.length - 2}` : ''}`,
        value: harness.command,
      })),
      ...(reset ? [{ label: `Wait for reset (${quotaResetPhrase(reset, now)})`, detail: '· sends it again here then', value: WAIT_FOR_RESET }] : []),
    ]);
    if (command === WAIT_FOR_RESET && reset) return { waiting: await waitForReset(id, reset, prompt, sent, now) };
    const chosen = candidates.find((candidate) => candidate.harness.command === command);
    if (!chosen) return undefined;
    const accountId = preferredAccountId(state, chosen.harness.provider, null,
      (candidate) => chosen.accounts.some((account) => account.id === candidate.id));
    const account = chosen.accounts.find((candidate) => candidate.id === accountId)!;
    const catalog = await nativeModelCatalogForPicker(chosen.harness, account);
    const lastUsedModel = [...state.sessions]
      .filter((item) => item.nativeHarness === chosen.harness.command && item.model)
      .sort((left, right) => Date.parse(right.updatedAt ?? '') - Date.parse(left.updatedAt ?? ''))[0]?.model;
    const model = lastUsedModel ?? state.providerSettings[chosen.harness.provider]?.model ?? catalog.configured ?? null;
    return resumeIn(id, chosen.harness, account.id, model, prompt, sent, session.nativeHarness);
  }
}

/** Parks the turn on the session until `reset`: what to send then is decided
 * now, against the interrupted turn on record (resumePromptForPendingTurn). */
export async function waitForReset(id: string, reset: Date, prompt: string, sent = prompt, now: number = Date.now()): Promise<ResumeAt> {
  const state = await readState({ transcripts: [id] });
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  const resumeAt: ResumeAt = { at: reset.toISOString(), prompt: resumePromptForPendingTurn(session.pendingTurn, prompt, sent), setAt: new Date(now).toISOString() };
  session.resumeAt = resumeAt;
  await writeState(state);
  return resumeAt;
}

/** Where "Resume in" took the conversation. `prompt` is what to send there;
 * absent when another window already carried this turn on, which is then
 * only followed. */
export type ResumedIn = { id: string; prompt?: string };

export async function resumeIn(
  id: string, harness: AiLocalHarnessDefinition, accountId: string, model: string | null, prompt: string, sent: string,
  /** The harness the turn ran out on: the conversation still being there is
   * what says no other window has moved it on yet. */
  from: string | undefined,
): Promise<ResumedIn> {
  // Two windows following one turn that ran out both offer "Resume in"; the
  // first to choose moves the conversation, the other follows it there.
  return withFileLock(join(sessionsDirectory(), `${safeRecordFileName(id)}.resume-in.lock`), async () => {
    const state = await readState({ transcripts: [id] });
    const session = state.sessions.find((item) => item.id === id);
    if (session?.nativeHarness !== from) return { id };
    // The interrupted request and all progress recorded for it stay in the
    // conversation. Asking the new provider to continue avoids running that
    // request a second time and preserves the partial answer and tool activity.
    const nextPrompt = resumePromptForPendingTurn(session?.pendingTurn, prompt, sent);
    await moveToProvider(id, harness.command, { accountId, model });
    return { id, prompt: nextPrompt };
  });
}

/** What to send after the turn on record failed.
 *
 * Compared with what the turn recorded, which is the sent prompt, trimmed:
 * comparing the typed line re-sent an expanded /review whole. The continuation
 * is only for a turn that already wrote an answer or ran a tool. One that
 * died before any output is sent again in those same words: "continue the
 * interrupted request" points at the previous finished turn. A turn that
 * never started sends the typed line. */
export function resumePromptForPendingTurn(pending: HarnessSession['pendingTurn'], prompt: string, sent = prompt): string {
  if (!pending || pending.prompt.trim() !== sent.trim()) return prompt;
  return pending.outputStarted ? INTERRUPTED_TURN_REQUEST : sent;
}

/** What carries a turn on after it ran out of usage on every account:
 *  - `retry`: an account of this provider got its quota back after failover
 *    looked, so the turn goes again here, once;
 *  - `moved`: "Resume in" moved the conversation to another provider,
 *    with what was queued behind the turn;
 *  - `waiting`: parked until this provider's reset; the worker sends it then,
 *    and what was queued behind it stays queued;
 *  - `stayed`: nothing carried it on; `queued` are the messages that were
 *    typed behind it, taken back for the composer when nothing here could
 *    run them (each would fail the same way and offer this again). */
export type ExhaustedTurnNext =
  | { retry: string }
  | { moved: ResumedIn }
  | { waiting: ResumeAt }
  | { stayed: string[] };

/** The same-provider retry is at most once per interrupted turn. It is keyed
 * on what was SENT, in the conversation it was sent in: the retry sends the
 * continuation, not the original words, so keying on the original let the
 * continuation's own exhaustion retry a second time. */
export interface ExhaustionRetryGuard { autoResent?: string }

export async function carryOnAfterExhaustion(
  rl: HarnessPrompter, id: string, prompt: string, guard: ExhaustionRetryGuard, sent = prompt,
): Promise<ExhaustedTurnNext> {
  const key = (text: string): string => `${id}\n${text}`;
  if (guard.autoResent !== key(prompt) && await sameProviderCanTakeTurn(id)) {
    const state = await readState({ transcripts: [id] });
    const session = state.sessions.find((item) => item.id === id);
    if (session) {
      const continuation = resumePromptForPendingTurn(session.pendingTurn, prompt, sent);
      guard.autoResent = key(continuation);
      return { retry: continuation };
    }
  }
  const moved = await interactiveResumeInPicker(rl, id, prompt, sent);
  if (moved && 'waiting' in moved) return moved;
  if (moved) return { moved };
  return { stayed: await sameProviderCanTakeTurn(id) ? [] : await takeQueuedMessages(id) };
}

/** Takes a parked turn off the session ("Wait for reset" cancelled from a
 * window). The conversation's worker learns of it on its next look; send it a
 * `refresh` to have that be now. True when there was one. */
export async function stopWaitingForReset(id: string): Promise<boolean> {
  const state = await readState({ transcripts: [] });
  const session = state.sessions.find((item) => item.id === id);
  if (!session?.resumeAt) return false;
  delete session.resumeAt;
  await writeState(state);
  return true;
}
