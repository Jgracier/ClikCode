/** Import an existing ACP thread through the vendor's own history replay.
 * No new session, prompt, or inference request is issued. */
import type { AiLocalHarnessDefinition } from '../../harness/definition.js';
import { acpProbeArgv, queryAcp } from '../../harness/accounts/acp-query.js';
import type { NativeSessionEnvironment } from './stores.js';
import type { NativeTranscriptMessage } from './transcript.js';

export async function readAcpTranscript(
  harness: AiLocalHarnessDefinition, nativeId: string, workspace: string, environment: NativeSessionEnvironment = {},
): Promise<NativeTranscriptMessage[]> {
  if (!harness.acp) return [];
  const messages: NativeTranscriptMessage[] = [];
  let boundary = true;
  const profileEnv = harness.profileEnv ?? 'HOME';
  const path = environment[profileEnv];
  const account = path ? { nativeProfile: { env: profileEnv, path } } : undefined;
  const result = await queryAcp(harness.acp.binary ?? harness.binary,
    [...harness.acp.argv, ...await acpProbeArgv(harness, account, environment.HOME)], environment,
    async (request, capabilities) => {
      if (!capabilities.loadSession) return false;
      await request('session/load', { sessionId: nativeId, cwd: workspace, mcpServers: [] });
      return true;
    }, undefined, {
      cwd: workspace,
      onNotification: (method, params) => {
        if (method !== 'session/update' || params.sessionId !== nativeId) return;
        const update = params.update;
        const role = update?.sessionUpdate === 'user_message_chunk' ? 'user'
          : update?.sessionUpdate === 'agent_message_chunk' ? 'assistant' : undefined;
        if (!role) { boundary = true; return; }
        if (update.content?.type !== 'text' || typeof update.content.text !== 'string') return;
        const last = messages.at(-1);
        if (!boundary && last?.role === role) last.content += update.content.text;
        else messages.push({ role, content: update.content.text });
        boundary = false;
      },
    });
  // A partial replay from a failed load is never claimed as a full import.
  return result ? messages.filter((message) => message.content.trim()) : [];
}
