/** Starting or switching the conversation a session is attached to. */

import type Conf from 'conf';
import { getApiKeyForUrl, getApiUrl } from '../../gateway/credentials.js';
import { gatewayLogin } from '../../commands/gateway.js';
import type { HarnessPrompter } from '../../harness/prompter.js';
import { readState } from '../../session/state/read.js';
import { writeState } from '../../session/state/write.js';
import { synchronizeNativeTranscript } from '../../turn/handoff.js';
import { TerminalHarnessPrompter } from '../prompter.js';
import { moveToProvider, refuseWhileTurnRuns } from '../../commands/ai/conversations.js';
import { leaveProvider } from '../../session/native-thread.js';
import { applyClikCodeAgentSessionPolicy } from '../../commands/ai/sessions.js';
import { chooseOption } from './choose.js';

/** False when the user closed the sign-in choice: nothing moves. */
async function ensureGatewayLogin(config: Conf, rl: HarnessPrompter): Promise<boolean> {
  const apiUrl = getApiUrl(config);
  if (getApiKeyForUrl(config, apiUrl)) return true;
  const provider = await chooseOption(rl, 'Sign in to ClikDeploy Gateway', [
    { label: 'Continue with Google', value: 'google' as const },
    { label: 'Continue with GitHub', value: 'github' as const },
  ]);
  if (!provider) return false;
  if (rl instanceof TerminalHarnessPrompter) await rl.suspend();
  try {
    await gatewayLogin(config, { google: provider === 'google', github: provider === 'github', embedded: true });
  } finally {
    if (rl instanceof TerminalHarnessPrompter) rl.resume();
  }
  if (!getApiKeyForUrl(config, apiUrl)) throw new Error('ClikDeploy OAuth completed without storing a ClikDeploy Gateway credential.');
  return true;
}

/** Moving a conversation onto one of the routes that run ClikCode's own
 * agent, in place, as any provider switch. Only the Gateway needs a sign-in
 * first -- ClikCode Local has no service to reach. */
async function moveToAgentRoute(
  config: Conf, rl: HarnessPrompter, id: string, route: 'gateway' | 'clikcode-local',
): Promise<string> {
  if (route === 'gateway' && !await ensureGatewayLogin(config, rl)) return id;
  const state = await readState({ transcripts: [id] });
  const current = state.sessions.find((item) => item.id === id);
  if (!current) throw new Error(`AI session "${id}" was not found`);
  if (current.route === route) return id;
  await refuseWhileTurnRuns(id);
  await synchronizeNativeTranscript(state, current);
  leaveProvider(current);
  applyClikCodeAgentSessionPolicy(current, route);
  await writeState(state);
  return id;
}

export async function selectProviderConversation(config: Conf, rl: HarnessPrompter, id: string, selected: string): Promise<string> {
  if (selected === '__gateway__') return moveToAgentRoute(config, rl, id, 'gateway');
  if (selected === '__clikcode_local__') return moveToAgentRoute(config, rl, id, 'clikcode-local');
  await moveToProvider(id, selected, { prompter: rl });
  return id;
}
