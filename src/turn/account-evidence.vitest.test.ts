/** What anything the vendor says or does tells about the account: one classification for every
 * source, and what follows from a refusal seen outside a turn. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiHarnessAccount } from '../harness/definition.js';
import type { HarnessSession } from '../session/model.js';
import { readState } from '../session/state/read.js';
import { writeState } from '../session/state/write.js';

const logged = vi.hoisted(() => [] as string[]);
vi.mock('../runtime/lifecycle-log.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../runtime/lifecycle-log.js')>(),
  lifecycle: (name: string) => { logged.push(name); },
}));
const { classifyEvidence, isVendorRefusalSaid, observeAccountHealth, refusalEndingReply } = await import('./account-evidence.js');

const LIMIT = "You've hit your session limit · resets 7:50am (America/Denver)";

describe('classifying evidence', () => {
  it('reads the structured fields without any wording', () => {
    expect(classifyEvidence({ errorKind: 'quota' })).toBe('quota-exhausted');
    expect(classifyEvidence({ statusCode: 402 })).toBe('quota-exhausted');
    expect(classifyEvidence({ rateLimitStatus: 'rejected' })).toBe('quota-exhausted');
    expect(classifyEvidence({ statusCode: 401 })).toBe('authentication-required');
    // A throttle is not a spent account.
    expect(classifyEvidence({ errorKind: 'rate_limit', statusCode: 429 })).toBe('temporarily-throttled');
  });

  it("reads the vendor's words only through the classifier, and only when they are the vendor's", () => {
    // The vendor files a spent plan under its rate-limit kind; its words say which it is.
    expect(classifyEvidence({ errorKind: 'rate_limit', statusCode: 429, vendorError: true, text: LIMIT })).toBe('quota-exhausted');
    expect(classifyEvidence({ vendorError: true, text: "You've hit your usage limit. Try again at 10:35 AM." })).toBe('quota-exhausted');
    // An agent's own report about limits is not the vendor refusing.
    expect(classifyEvidence({ vendorError: false, text: LIMIT })).toBe('other');
    expect(classifyEvidence({ vendorError: false, errorKind: 'rate_limit', text: 'I raised the rate limit' })).toBe('temporarily-throttled');
  });
});

describe('a reply that ends in a refusal', () => {
  it("ends only in the vendor's own form, reset time and all", () => {
    expect(refusalEndingReply(`Only the games agent is still running.${LIMIT}`)).toBe(LIMIT);
    expect(refusalEndingReply(`Done.\n\n${LIMIT}${LIMIT}\n`)).toBeDefined();
    // A model writing about limits, or quoting the refusal before going on, is not refused.
    expect(refusalEndingReply("I raised the rate limit; you've hit your limit of patience, I know.")).toBeUndefined();
    expect(refusalEndingReply(`The log said "${LIMIT}" and then the retry worked.`)).toBeUndefined();
    expect(refusalEndingReply('All done · resets 7:50am (America/Denver)')).toBeUndefined();
  });

  it('is told apart from ordinary speech when it is the whole of what was said', () => {
    expect(isVendorRefusalSaid(LIMIT)).toBe(true);
    expect(isVendorRefusalSaid('The build finished.')).toBe(false);
    expect(isVendorRefusalSaid('I raised the rate limit in the config and the tests pass.')).toBe(false);
    expect(isVendorRefusalSaid("You've hit your session limit.\nHere is the plan for the next step in detail.")).toBe(false);
  });
});

describe('observing the account from outside a turn', () => {
  const account = (id: string, usedPct: number): AiHarnessAccount => ({
    id, provider: 'fake', label: id, status: 'ready', authKind: 'vendor-cli', models: [], credentialRef: 'native:fake',
    usage: { at: new Date().toISOString(), windows: [{ name: 'weekly', usedPct, resetsAt: new Date(Date.now() + 86_400_000).toISOString() }] },
  } as AiHarnessAccount);
  const effects = { leave: vi.fn(async () => undefined), refuseTurn: vi.fn(() => false) };
  const evidence = { vendorError: true, errorKind: 'rate_limit', statusCode: 429, text: LIMIT };

  beforeEach(async () => {
    logged.length = 0;
    effects.leave.mockClear();
    effects.refuseTurn.mockReset().mockReturnValue(false);
    const state = await readState();
    state.accounts = [account('a', 99), account('b', 10)];
    state.sessions = [{ id: 's1', conversationId: 's1', route: 'local', accountId: 'a', provider: 'fake', model: 'm', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', status: 'active' } as HarnessSession];
    await writeState(state);
  });

  const stored = async () => {
    const state = await readState({ transcripts: [] });
    return { a: state.accounts.find((item) => item.id === 'a')!, session: state.sessions.find((item) => item.id === 's1')! };
  };

  it('marks the account spent once however many report it, and moves the conversation now', async () => {
    await Promise.all([1, 2, 3].map(() => observeAccountHealth({ sessionId: 's1', accountId: 'a', evidence, source: 'agent' }, effects)));
    const { a, session } = await stored();
    expect(a.quotaState).toBe('exhausted');
    expect(session.accountId).toBe('b');
    expect(logged.filter((name) => name === 'worker.account-spent')).toHaveLength(1);
    expect(logged.filter((name) => name === 'worker.switch')).toHaveLength(1);
    expect(effects.leave).toHaveBeenCalledTimes(1);
  });

  it('leaves the turn running on that account to its own failover, and moves nothing itself', async () => {
    effects.refuseTurn.mockReturnValue(true);
    await observeAccountHealth({ sessionId: 's1', accountId: 'a', evidence, source: 'agent' }, effects);
    const { a, session } = await stored();
    expect(a.quotaState).toBe('exhausted');
    expect(session.accountId).toBe('a');
    expect(effects.refuseTurn).toHaveBeenCalledWith('s1', 'a', expect.any(Error));
  });

  it("does not move a conversation the user has already put elsewhere", async () => {
    const state = await readState();
    state.sessions[0]!.accountId = 'b';
    await writeState(state);
    await observeAccountHealth({ sessionId: 's1', accountId: 'a', evidence, source: 'agent' }, effects);
    expect((await stored()).session.accountId).toBe('b');
    expect(effects.leave).not.toHaveBeenCalled();
  });

  it('stays put when no other account can take it', async () => {
    const state = await readState();
    state.accounts = state.accounts.filter((item) => item.id === 'a');
    await writeState(state);
    await observeAccountHealth({ sessionId: 's1', accountId: 'a', evidence, source: 'agent' }, effects);
    const { a, session } = await stored();
    expect(a.quotaState).toBe('exhausted');
    expect(session.accountId).toBe('a');
  });

  it('does nothing for a failure that is not the account running out', async () => {
    expect(await observeAccountHealth({ sessionId: 's1', accountId: 'a', evidence: { vendorError: true, errorKind: 'rate_limit', statusCode: 429, text: 'Please slow down' }, source: 'agent' }, effects)).toBe('temporarily-throttled');
    expect((await stored()).a.quotaState).not.toBe('exhausted');
    expect(logged).toEqual([]);
  });
});
