/** Starting or switching the conversation a session is attached to. */

import type Conf from 'conf';
import { getApiKeyForUrl, getApiUrl } from '../../gateway/credentials.js';
import { gatewayLogin } from '../../commands/gateway.js';
import type { HarnessPrompter } from '../../harness/prompter.js';
import { readState } from '../../session/state/read.js';
import { writeState } from '../../session/state/write.js';
import { synchronizeNativeTranscript } from '../../turn/handoff.js';
import { TerminalHarnessPrompter } from '../prompter.js';
import { moveToProvider, turnIsRunning } from '../../commands/ai/conversations.js';
import { leaveProvider, parkNativeThread } from '../../session/native-thread.js';
import { applyClikCodeAgentSessionPolicy } from '../../commands/ai/sessions.js';
import { chooseOption } from './choose.js';

/** `cancelled`: the user closed the sign-in choice, nothing moves. `local`: they chose a model on this computer, which needs no
 * sign-in; the caller opens the hosted AI list. Only offered where the user picked the provider by hand (`offerLocal`): a
 * model on this computer is hosted AI under the Gateway, and a signed-out or offline user must still be able to reach it. */
async function ensureGatewayLogin(config: Conf, rl: HarnessPrompter, offerLocal: boolean): Promise<'signed-in' | 'local' | 'cancelled'> {
  const apiUrl = getApiUrl(config);
  if (getApiKeyForUrl(config, apiUrl)) return 'signed-in';
  const provider = await chooseOption(rl, 'Sign in to ClikDeploy Gateway', [
    { label: 'Continue with Google', value: 'google' as const },
    { label: 'Continue with GitHub', value: 'github' as const },
    ...(offerLocal ? [{ label: 'Use a model on this computer', detail: 'Free, works offline, no sign-in', value: 'local' as const }] : []),
  ]);
  if (!provider) return 'cancelled';
  if (provider === 'local') return 'local';
  if (rl instanceof TerminalHarnessPrompter) await rl.suspend();
  try {
    await gatewayLogin(config, { google: provider === 'google', github: provider === 'github', embedded: true });
  } finally {
    if (rl instanceof TerminalHarnessPrompter) rl.resume();
  }
  if (!getApiKeyForUrl(config, apiUrl)) throw new Error('ClikDeploy OAuth completed without storing a ClikDeploy Gateway credential.');
  return 'signed-in';
}

/** Moving a conversation onto one of the routes that run ClikCode's own
 * agent, in place, as any provider switch. Only the Gateway needs a sign-in
 * first -- ClikCode Local has no service to reach. */
async function moveToAgentRoute(
  config: Conf, rl: HarnessPrompter, id: string, route: 'gateway' | 'clikcode-local', offerLocal = false,
): Promise<string> {
  if (route === 'gateway') {
    const entry = await ensureGatewayLogin(config, rl, offerLocal);
    if (entry === 'cancelled') return id;
    if (entry === 'local') {
      // Loaded when needed: the hosted AI picker imports this module for its own route move.
      await (await import('./model.js')).interactiveHostedPicker(rl, id);
      return id;
    }
  }
  await putOnAgentRoute(id, route);
  return id;
}

/** The move itself, with no sign-in and no question: the chat runs ClikCode's own agent on `route` from now on, history and all. For
 * what has already been asked and confirmed -- a model downloaded for it. The call already started finishes on the route it
 * started on; the next model step reads this route (turn/live-settings.ts) and moves. */
export async function putOnAgentRoute(id: string, route: 'gateway' | 'clikcode-local'): Promise<void> {
  const state = await readState({ transcripts: [id] });
  const current = state.sessions.find((item) => item.id === id);
  if (!current) throw new Error(`AI session "${id}" was not found`);
  if (current.route === route) return;
  const running = await turnIsRunning(id);
  if (!running) {
    await synchronizeNativeTranscript(state, current);
    leaveProvider(current);
  } else parkNativeThread(current);
  applyClikCodeAgentSessionPolicy(current, route, state);
  await writeState(state);
}

export async function selectProviderConversation(config: Conf, rl: HarnessPrompter, id: string, selected: string, options: { offerLocal?: boolean } = {}): Promise<string> {
  if (selected === '__gateway__') return moveToAgentRoute(config, rl, id, 'gateway', options.offerLocal === true);
  if (selected === '__clikcode_local__') return moveToAgentRoute(config, rl, id, 'clikcode-local');
  await moveToProvider(id, selected, { prompter: rl });
  return id;
}
