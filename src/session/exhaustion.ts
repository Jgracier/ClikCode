/** What carries a turn on after it ran out of usage on every account: the same provider again once an account is back, the
 * conversation moved on by "Resume in", parked until the reset, or handed back. Shared by the terminal, the editor and the worker;
 * the one interactive step -- the "Resume in" list -- is handed in (tui/pickers/resume-in.ts offerResumeIn), so this layer does
 * not reach into the terminal UI. */
import type { AiHarnessAccount } from '../harness/definition.js';
import { accountCanTakeTurn } from '../harness/accounts/usage-reading.js';
import { matchesVendorTurn } from '../turn/account-routing.js';
import type { ResumeAt } from '../turn/usage-exhausted.js';
import { takeQueuedMessages } from '../commands/ai/conversations.js';
import type { HarnessSession } from './model.js';
import { readState } from './state/read.js';
import { writeState } from './state/write.js';

/** Where "Resume in" took the conversation. `prompt` is what to send there;
 * absent when another window already carried this turn on, which is then
 * only followed. */
export type ResumedIn = { id: string; prompt?: string };

/** The "Resume in" list for conversation `id`: the conversation moved on, parked for the reset (`waiting`), or nothing (no other
 * provider has usage, or the user backed out). */
export type ResumeInOffer = (id: string, prompt: string, sent: string) => Promise<ResumedIn | { waiting: ResumeAt } | undefined>;

/** An account that can take a turn now -- the one rule failover uses too. */
export function accountHasUsage(account: AiHarnessAccount): boolean {
  return accountCanTakeTurn(account);
}

/** Whether an account of the chat's own provider can take the turn. While
 * one can, the same-provider switch is the one to make, not another provider. */
export function sessionProviderHasUsage(accounts: readonly AiHarnessAccount[], provider: string | null | undefined): boolean {
  return accounts.some((account) => account.provider === provider && matchesVendorTurn(account) && accountHasUsage(account));
}

async function sameProviderCanTakeTurn(id: string): Promise<boolean> {
  const state = await readState({ transcripts: [id] });
  const session = state.sessions.find((item) => item.id === id);
  return session ? sessionProviderHasUsage(state.accounts, session.provider) : false;
}

/** What to send after the turn on record failed.
 *
 * Compared with what the turn recorded, which is the sent prompt, trimmed:
 * comparing the typed line re-sent an expanded /review whole. The user's own
 * request goes again in those same words, whether or not the turn wrote
 * anything: what it wrote is in the conversation the new provider is given.
 * A turn that never started sends the typed line. */
export function resumePromptForPendingTurn(pending: HarnessSession['pendingTurn'], prompt: string, sent = prompt): string {
  if (!pending || pending.prompt.trim() !== sent.trim()) return prompt;
  return sent;
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
type ExhaustedTurnNext =
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
  offer: ResumeInOffer, id: string, prompt: string, guard: ExhaustionRetryGuard, sent = prompt,
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
  const moved = await offer(id, prompt, sent);
  if (moved && 'waiting' in moved) return moved;
  if (moved) return { moved };
  // Not carried on (Esc on Resume-in, or nowhere to go): the message comes
  // back to the composer to send again, with anything queued behind it.
  return { stayed: [prompt, ...(await sameProviderCanTakeTurn(id) ? [] : await takeQueuedMessages(id))] };
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
