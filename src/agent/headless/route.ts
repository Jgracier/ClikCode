/** Which signed-in harness account a headless agent runs on: the user's own chat route (harness, account), moving to another signed-in
 * account of the same vendor on a usage limit the way a chat turn does. Never Gateway credit, never an inherited API key. */
import type { AiHarnessAccount } from '../../harness/definition.js';
import type { HarnessSession, HarnessState } from '../../session/model.js';
import { accountCanTakeTurn } from '../../harness/accounts/usage-reading.js';
import { quotaScopeForModel } from '../../harness/accounts/quota-scope.js';
import { matchesVendorTurn, nextUsableFailoverAccount } from '../../turn/account-routing.js';

/** A saved, usable native Claude or Codex profile (Claude first): what a short single-purpose turn (a captcha vote) runs on. */
export function headlessAccount(accounts: readonly AiHarnessAccount[]): AiHarnessAccount | undefined {
  const usable = accounts.filter((account) => accountCanTakeTurn(account) && account.authKind === 'vendor-cli');
  return usable.find((account) => account.provider === 'anthropic' && account.nativeProfile?.env === 'CLAUDE_CONFIG_DIR')
    ?? usable.find((account) => account.provider === 'openai' && account.nativeProfile?.env === 'CODEX_HOME');
}

/** The harnesses a headless agent can run on, by the command that runs them. */
export const HEADLESS_HARNESSES = { claude: 'claude', codex: 'codex' } as const;
export type HeadlessHarness = keyof typeof HEADLESS_HARNESSES;

/** What the user is chatting on -- the harness, the signed-in account and the model -- which is what a headless agent runs on: the same
 * subscription doing the same kind of work. When that account has no usage left the route moves the way a chat turn does
 * (nextUsableFailoverAccount: another signed-in account of the same vendor, most room first). `sessionId` binds the route to one chat;
 * `attempted`: accounts this run already tried, and when. `claudeModel`: the model under Claude Code (the computer setting agentModel);
 * Codex runs on the chat's own model. An error says why no account can run it. */
export function agentRoute(state: { sessions: readonly HarnessSession[]; accounts: readonly AiHarnessAccount[] }, options: { now?: number; sessionId?: string; attempted?: ReadonlyMap<string, number>; preferredHarness?: HeadlessHarness; claudeModel: string }): { harness: HeadlessHarness; account: AiHarnessAccount; model?: string; movedFrom?: string } | { error: string } {
  const now = options.now ?? Date.now();
  const attempted = options.attempted ?? new Map<string, number>();
  const { sessionId } = options;
  const chats = [...state.sessions].filter(session => session.route === 'local' && session.nativeHarness && session.accountId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  if (!chats.length) return { error: 'No chat with a signed-in harness was found to run the agent on.' };
  // A bound interactive chat must keep its route. An unbound background agent can prefer a configured subscription harness and
  // fail over to another supported harness; a newer Cursor/Copilot chat must not strand background work.
  const headlessChats = chats.filter(session => (session.nativeHarness as string) in HEADLESS_HARNESSES);
  const orderedHeadlessChats = options.preferredHarness
    ? [...headlessChats.filter(session => session.nativeHarness === options.preferredHarness), ...headlessChats.filter(session => session.nativeHarness !== options.preferredHarness)]
    : headlessChats;
  const chat = sessionId ? chats.find(session => session.id === sessionId) : orderedHeadlessChats[0];
  if (sessionId && !chat) return { error: `The chat this agent is bound to (${sessionId}) is missing or has no signed-in local harness; no other chat will be used.` };
  if (chat && !(chat.nativeHarness as string in HEADLESS_HARNESSES)) return { error: `The bound chat runs on ${chat.nativeHarness}; headless agents run on Claude Code or Codex.` };
  if (!chat) return { error: chats.length ? `The recent chats run on ${chats[0]!.nativeHarness}; headless agents run on Claude Code or Codex.` : 'No chat with a signed-in harness was found to run the agent on.' };

  const candidates = sessionId ? [chat] : orderedHeadlessChats;
  let lastFailure = '';
  for (const candidateChat of candidates) {
    const harness = candidateChat.nativeHarness as HeadlessHarness;
    const account = state.accounts.find(item => item.id === candidateChat.accountId);
    if (!account?.nativeProfile || account.authKind !== 'vendor-cli') { lastFailure = `The ${harness} account is not signed in through a native subscription profile.`; continue; }
    // On Claude Code the model is the setting, not the chat's: a chat on the largest model would spend the subscription on browser steps.
    const picked = harness === 'claude' ? options.claudeModel : candidateChat.model;
    const model = picked ? { model: picked } : {};
    // Check the exact model's quota, then use ClikCode's same-vendor subscription failover before trying another harness.
    if (accountCanTakeTurn(account, now, quotaScopeForModel(account, picked ?? undefined)) && !attempted.has(account.id)) return { harness, account, ...model };
    const next = nextUsableFailoverAccount(state as unknown as HarnessState, account,
      candidate => matchesVendorTurn(candidate) && candidate.authKind === 'vendor-cli' && candidate.nativeProfile !== undefined, new Map([...attempted, [account.id, now]]), now, picked ?? undefined);
    if (next) return { harness, account: next, ...model, movedFrom: account.label };
    lastFailure = `The ${harness} account (${account.label}) has no usage left now, and no other signed-in ${harness} account can take ${picked ?? 'the work'}.`;
    if (sessionId) return { error: `The current chat's ${harness} account (${account.label}) has no usage left now, and no other signed-in ${harness} account can take the work.` };
  }
  return { error: lastFailure || 'No signed-in Claude Code or Codex subscription account can take the work.' };
}
