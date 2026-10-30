/** What anything the vendor says or does tells about the conversation's account -- one place.
 *
 * A main turn that failed, an agent or a command that ended, words the vendor said out of turn, a
 * reply that ends in its refusal: each is evidence about the account the conversation is on, and
 * each used to be read by its own code with its own wording (four regexes, tuned to Claude's
 * sentence, and a different path per transport). Now each source builds a FailureEvidence -- the
 * fields its transport knows (harness/transport/handoff-work.ts) -- and asks here:
 *  - classifyEvidence: what kind of failure it is. Structured fields first, then the wording, and
 *    the wording only through classifyAccountFailure (failover.ts), the one place that knows how a
 *    vendor says it is out;
 *  - observeAccountHealth: for evidence from outside a turn, what follows when it says the account is
 *    spent -- the account is marked once, the conversation is moved off it now, and the work it cut
 *    off is for the next account to take up (the ledger, turn/vendor-process.ts, tells the worker).
 *
 * A turn in progress records its own refusal on its own copy of the state (account-routing.ts
 * accountAfterFailure); it classifies through here, and records there. */
import { lifecycle } from '../runtime/lifecycle-log.js';
import { quotaRefusalHolds } from '../harness/accounts/usage-reading.js';
import type { FailureEvidence } from '../harness/transport/handoff-work.js';
import type { AiHarnessAccount } from '../harness/definition.js';
import { readState } from '../session/state/read.js';
import { writeState } from '../session/state/write.js';
import { classifyAccountFailure, type AccountFailureKind } from './failover.js';
import { storeQuotaRefusal } from './account-outcome.js';
import { nextUsableFailoverAccount, turnBackendForAccount } from './account-routing.js';

/** The error a piece of evidence stands for: its words with its fields beside them, as a failed
 * attempt carries them (the classifier reads `statusCode`, `errorKind`, `rateLimitStatus`). */
export function evidenceError(evidence: FailureEvidence): Error {
  const { statusCode, errorKind, rateLimitStatus, text } = evidence;
  return Object.assign(new Error(text ?? ''), {
    ...(statusCode !== undefined ? { statusCode } : {}), ...(errorKind ? { errorKind } : {}), ...(rateLimitStatus ? { rateLimitStatus } : {}),
  });
}

/** What kind of failure this evidence is. The same answer for an ended agent, an ended command, a
 * main turn's error and a vendor's words said out of turn. */
export function classifyEvidence(evidence: FailureEvidence, extra: { replyErrorPatterns?: readonly { pattern: string; status?: number }[] } = {}): AccountFailureKind {
  return classifyAccountFailure(evidenceError(evidence), {
    ...(evidence.statusCode !== undefined ? { statusCode: evidence.statusCode } : {}),
    ...(evidence.errorKind ? { errorKind: evidence.errorKind } : {}),
    ...(evidence.rateLimitStatus ? { rateLimitStatus: evidence.rateLimitStatus } : {}),
    ...(evidence.vendorError !== undefined ? { isResultError: evidence.vendorError } : {}),
    ...(extra.replyErrorPatterns ? { replyErrorPatterns: extra.replyErrorPatterns } : {}),
  });
}

/** Whether words are the vendor's own refusal. The shapes below are what keeps a model's prose out
 * ("I raised the rate limit" is the model talking); whether the words say the account is out is
 * the classifier's answer, not another pattern. */
function isRefusal(words: string): boolean {
  return classifyEvidence({ text: words, vendorError: true }) === 'quota-exhausted';
}

/** The reset the vendor ends a refusal with: "· resets 1pm (America/Denver)", "· resets Oct 28, 1am". */
const REFUSAL_RESET = /\s*·\s*resets (?:[A-Z][a-z]{2} \d{1,2}, )?\d{1,2}(?::\d{2})?\s?[ap]m(?: \([^)\n]+\))?$/i;

/** The refusal a reply ends with, when it ends with the vendor's: a sentence and the reset time as
 * the very last words. A model quoting the words mid-answer, or without the reset, is not it. */
export function refusalEndingReply(reply: string): string | undefined {
  const text = reply.trimEnd();
  const reset = REFUSAL_RESET.exec(text);
  if (!reset) return undefined;
  const before = text.slice(0, reset.index);
  // The sentence is what follows the reply's last sentence break (a refusal may follow "Done." directly).
  const sentence = before.slice(Math.max(before.lastIndexOf('\n'), before.lastIndexOf('. '), before.lastIndexOf('.')) + 1).trim();
  const refusal = `${sentence}${reset[0]}`.trim();
  return sentence && isRefusal(refusal) ? refusal : undefined;
}

/** Whether the vendor, speaking with no turn open, said only its refusal: one short line. */
export function isVendorRefusalSaid(text: string): boolean {
  const said = text.trim();
  return said.length > 0 && said.length < 300 && !said.includes('\n') && isRefusal(said);
}

/** What taking the conversation off a spent account touches outside the state: the vendor
 * processes (turn/vendor-process.ts supplies them). */
export interface AccountMoveEffects {
  /** The conversation leaves its process on that account; work still running in it is kept. */
  leave(sessionId: string, accountId: string): Promise<void>;
  /** The turn in progress on that account fails as if the vendor had refused it, so the turn's own
   * failover (standby included) takes over. False: no turn is running there. */
  refuseTurn(sessionId: string, accountId: string, error: Error): boolean;
}

/** Observations of one account run one after another: three agents that die together report one
 * refusal, one mark and one move. */
const observing = new Map<string, Promise<unknown>>();
function oneAtATime<T>(accountId: string, step: () => Promise<T>): Promise<T> {
  const run = (observing.get(accountId) ?? Promise.resolve()).then(step);
  observing.set(accountId, run.catch(() => undefined));
  return run;
}

/** Mark `accountId` spent on this refusal, unless a refusal already holds. */
async function markSpent(accountId: string, error: Error, source: string): Promise<void> {
  const account = (await readState({ transcripts: [] })).accounts.find((item) => item.id === accountId);
  if (!account || quotaRefusalHolds(account)) return;
  if (await storeQuotaRefusal(accountId, error)) lifecycle('worker.account-spent', { account: accountId.slice(0, 8), source });
}

/** Move the conversation to the next usable account now. It changes the conversation's account
 * only while it is still on the spent one, so a user's choice made since stands. */
async function moveOff(sessionId: string, from: AiHarnessAccount['id'], harness: string | undefined, why: string, effects: AccountMoveEffects, error: Error): Promise<void> {
  // A turn is running on that account: it is refused as the vendor will refuse it, and moves itself.
  if (effects.refuseTurn(sessionId, from, error)) return;
  const state = await readState({ transcripts: [] });
  const session = state.sessions.find((item) => item.id === sessionId);
  const current = state.accounts.find((item) => item.id === from);
  if (!session || !current || session.accountId !== from) return;
  const to = nextUsableFailoverAccount(state, current, (candidate) => turnBackendForAccount(candidate) === 'vendor', new Map([[from, Date.now()]]));
  if (!to) return;
  const started = Date.now();
  session.accountId = to.id;
  await writeState(state);
  await effects.leave(sessionId, from);
  lifecycle('worker.switch', { harness: harness ?? session.nativeHarness ?? 'unknown', from: from.slice(0, 8), to: to.id.slice(0, 8), why: 'quota-exhausted', source: why, recordMs: Date.now() - started });
}

/** Evidence from outside a turn about the account `accountId` of `sessionId`. When it says the
 * account is out of usage: the account is marked spent (once, however many report it), and the
 * conversation is moved off it now -- not at its next turn. Anything else is left to the
 * vendor and to the turn that meets it. Returns what the evidence was. */
export async function observeAccountHealth(
  input: { sessionId: string; accountId: string; evidence: FailureEvidence; source: 'agent' | 'command' | 'out-of-turn'; harness?: string },
  effects: AccountMoveEffects,
): Promise<AccountFailureKind> {
  const kind = classifyEvidence(input.evidence);
  if (kind !== 'quota-exhausted') return kind;
  const error = evidenceError(input.evidence);
  await oneAtATime(input.accountId, async () => {
    await markSpent(input.accountId, error, input.source);
    await moveOff(input.sessionId, input.accountId, input.harness, input.source, effects, error);
  });
  return kind;
}
