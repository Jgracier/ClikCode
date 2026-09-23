/** Starting or switching the conversation a session is attached to. */

import { randomUUID } from 'node:crypto';
import type Conf from 'conf';
import { getApiKeyForUrl, getApiUrl } from '../../gateway/credentials.js';
import { gatewayLogin } from '../../commands/gateway.js';
import type { HarnessPrompter } from '../../harness/prompter.js';
import type { HarnessSession } from '../../session/model.js';
import { readState } from '../../session/state/read.js';
import { writeState } from '../../session/state/write.js';
import { synchronizeNativeTranscript } from '../../turn/runtime.js';
import { TerminalHarnessPrompter } from '../prompter.js';
import { conversationIdFor, hasConversationContent, requiresProviderHandoff } from '../../session/options.js';
import { sessionTranscriptMessages } from '../../turn/checkpoint.js';
import { newProviderConversation } from '../../commands/ai/conversations.js';
import { aiHarnessSelect } from '../../commands/ai/harness.js';
import { applyGatewaySessionPolicy } from '../../commands/ai/sessions.js';
import { chooseOption } from './choose.js';

async function ensureGatewayLogin(config: Conf, rl: HarnessPrompter): Promise<void> {
  const apiUrl = getApiUrl(config);
  if (getApiKeyForUrl(config, apiUrl)) return;
  const provider = await chooseOption(rl, 'Sign in to ClikDeploy Gateway', [
    { label: 'Continue with Google', value: 'google' as const },
    { label: 'Continue with GitHub', value: 'github' as const },
  ]);
  if (!provider) throw new Error('ClikDeploy Gateway sign-in was cancelled.');
  if (rl instanceof TerminalHarnessPrompter) await rl.suspend();
  try {
    await gatewayLogin(config, { google: provider === 'google', github: provider === 'github', embedded: true });
  } finally {
    if (rl instanceof TerminalHarnessPrompter) rl.resume();
  }
  if (!getApiKeyForUrl(config, apiUrl)) throw new Error('ClikDeploy OAuth completed without storing a ClikDeploy Gateway credential.');
}

async function newGatewayConversation(config: Conf, rl: HarnessPrompter, currentId: string): Promise<string> {
  await ensureGatewayLogin(config, rl);
  const state = await readState();
  const current = state.sessions.find((item) => item.id === currentId);
  if (!current) throw new Error(`AI session "${currentId}" was not found`);
  if (current.route === 'gateway') return current.id;
  if (!hasConversationContent(current) && !current.nativeHarness) {
    applyGatewaySessionPolicy(current);
    current.updatedAt = new Date().toISOString();
    await writeState(state);
    return current.id;
  }
  if (await synchronizeNativeTranscript(state, current)) await writeState(state);
  const now = new Date().toISOString();
  const id = randomUUID();
  const session: HarnessSession = {
    id, conversationId: conversationIdFor(current), parentSessionId: current.id,
    handoff: { fromSessionId: current.id, fromHarness: current.nativeHarness ?? current.route, at: now },
    route: 'gateway', accountId: null, provider: 'gateway', model: null,
    effort: 'platform-managed', accountFailover: 'never',
    workspace: current.workspace ?? process.cwd(), name: current.name?.replace(/\s+\(from [^)]+\)$/i, '').trim() || undefined,
    ...(sessionTranscriptMessages(current).length
      ? { messages: sessionTranscriptMessages(current).map((message) => ({ ...message })) }
      : {}),
    createdAt: now, updatedAt: now, status: 'active',
    gatewayConfirmed: true,
  };
  state.sessions.push(session);
  await writeState(state);
  return session.id;
}

export async function selectProviderConversation(config: Conf, rl: HarnessPrompter, id: string, selected: string): Promise<string> {
  if (selected === '__gateway__') return newGatewayConversation(config, rl, id);
  const state = await readState();
  const current = state.sessions.find((item) => item.id === id);
  if (!current) throw new Error(`AI session "${id}" was not found`);
  // In place whenever there is nothing to branch. This required no harness
  // at all as well, so switching an EMPTY chat from one provider to another
  // made a whole new conversation and left the empty one behind in /resume.
  // requiresProviderHandoff is the actual rule -- content, on a different
  // provider -- and aiHarnessSelect enforces the same one.
  if (!requiresProviderHandoff(current, selected)) {
    await aiHarnessSelect(selected, id);
    return id;
  }
  return newProviderConversation(id, selected);
}
