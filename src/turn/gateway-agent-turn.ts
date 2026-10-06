/** A selected ClikDeploy agent runs on the platform's agent reply lane. */
import type Conf from 'conf';
import { gatewayConnection } from '../agent/models/for-session.js';
import type { HarnessSession, HarnessState } from '../session/model.js';
import type { TurnRunOptions } from './session-turn.js';
import { startTurnCheckpoint, completeTurnCheckpoint } from './turn-journal.js';
import { recordInvocation } from './turn-output.js';
import { emitHarnessOutput } from '../harness/output.js';
import { CLIKCODE_USER_AGENT } from '../version.js';

const MAX_WAIT_MS = 10 * 60_000;

async function requestJson(url: string, key: string, init: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${key}`, accept: 'application/json', 'content-type': 'application/json', 'user-agent': CLIKCODE_USER_AGENT },
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : `Gateway agent request failed (${response.status})`);
  return body;
}

export async function runGatewayAgentTurn(input: {
  config: Conf; state: HarnessState; session: HarnessSession; prompt: string; signal?: AbortSignal; run: TurnRunOptions;
}): Promise<void> {
  const { config, state, session, signal, run } = input;
  const agentId = session.gatewayAgentId;
  if (!agentId) throw new Error('No Gateway agent is selected.');
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error('prompt is required');
  if (session.attachments?.length) throw new Error('Gateway agents cannot read local attachments. Send the content as text or choose a Gateway model.');
  const { baseUrl, apiKey } = gatewayConnection(config);
  const endpoint = `${baseUrl}/v1/agents/${encodeURIComponent(agentId)}/chat`;
  const startedAt = Date.now();
  const checkpoint = await startTurnCheckpoint(state, session, prompt, run);
  try {
    const posted = await requestJson(endpoint, apiKey, {
      method: 'POST', signal,
      body: JSON.stringify({ message: prompt, threadId: session.gatewayAgentThreadId ?? null, model: session.model }),
    });
    if (typeof posted.threadId !== 'string' || typeof posted.messageId !== 'string') throw new Error('Gateway agent did not return a conversation and message ID.');
    session.gatewayAgentThreadId = posted.threadId;
    await checkpoint.flush();
    if (typeof posted.refusedReason === 'string') throw new Error(`Gateway agent refused the message: ${posted.refusedReason}`);
    run.prompter?.phase('waiting for agent');
    const deadline = Date.now() + MAX_WAIT_MS;
    let answer = '';
    while (Date.now() < deadline) {
      if (signal?.aborted) throw signal.reason ?? new Error('Gateway agent turn cancelled');
      const url = new URL(endpoint);
      url.searchParams.set('threadId', posted.threadId);
      url.searchParams.set('messageId', posted.messageId);
      const result = await requestJson(url.toString(), apiKey, { method: 'GET', signal });
      if (result.status === 'refused') throw new Error(`Gateway agent refused the message: ${String(result.reason ?? 'unknown reason')}`);
      if (result.status === 'completed') {
        answer = String(result.text ?? '');
        break;
      }
      if (result.status !== 'pending') throw new Error('Gateway agent returned an unknown reply status.');
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => { clearTimeout(timer); reject(signal?.reason ?? new Error('Gateway agent turn cancelled')); };
        const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, 1000);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
    if (!answer) throw new Error('Gateway agent has not answered yet. The request remains in the agent conversation.');
    checkpoint.response(answer, 'append');
    run.prompter?.response(answer, 'append');
    const invocation = recordInvocation(state, {
      sessionId: session.id, accountId: 'gateway', provider: 'gateway', model: session.model, startedAt,
    });
    const text = await completeTurnCheckpoint(session, checkpoint, answer, {});
    if (!run.prompter) emitHarnessOutput({ session, text, invocation, usage: { attributedBy: 'gateway' } });
    await checkpoint.flush();
  } catch (error) {
    await checkpoint.flush();
    throw error;
  }
}
