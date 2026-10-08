/** A selected ClikDeploy agent answers in the request that asks it, streamed.
 *
 * The agent runs on the platform (its tools are the platform's, under its own
 * grant); this machine shows the turn exactly as it shows a model turn: the
 * answer as it is written, each tool call as a live row, a held write as a
 * notice, and the served model with the agent's name in the footer. Ctrl+C
 * closes the stream, and closing it aborts the agent's run on the server.
 * The conversation is the agent's DM thread on the platform; this session
 * keeps its id (`gatewayAgentThreadId`) so the next turn, and a resumed
 * session, continue it. */
import type Conf from 'conf';
import { gatewayConnection } from '../agent/models/for-session.js';
import type { HarnessSession, HarnessState } from '../session/model.js';
import type { TurnRunOptions } from './session-turn.js';
import { startTurnCheckpoint, completeTurnCheckpoint } from './turn-journal.js';
import { canonicalRecord } from '../session/canonical.js';
import { transferBudget, transferPrompt } from './transfer.js';
import { recordInvocation, turnSink } from './turn-output.js';
import { emitHarnessOutput } from '../harness/output.js';
import { CLIKCODE_USER_AGENT } from '../version.js';
import type { HarnessActivityEvent } from '../harness/prompter.js';
import type { TurnUsage } from '../harness/protocol/turn-usage.js';
import { toolLabel } from '../harness/protocol/tools.js';
import { eventOutputPreview } from '../agent/security.js';

/** The efforts the server's agents take; anything else (auto, a vendor's own word) is the agent's own. */
const AGENT_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
/** The server says it is alive every 15s while a tool runs; this long with nothing is a dead stream. */
export const AGENT_STREAM_IDLE_MS = 60_000;

/** This session's settings for the agent's turn: they win over the agent's own. */
export function agentTurnSettings(session: Pick<HarnessSession, 'model' | 'effort' | 'permissionMode'>): Record<string, string | null> {
  return {
    model: session.model,
    permissionMode: session.permissionMode ?? 'ask',
    ...(AGENT_EFFORTS.has(session.effort) ? { effort: session.effort } : {}),
  };
}

/** One event of the server's agent turn (ClikDeploy agent-chat-turn.ts AgentChatEvent). */
export type AgentStreamEvent =
  | { type: 'start'; threadId: string; messageId: string; agent: { id: string; handle: string; name: string } }
  | { type: 'step' }
  | { type: 'text'; text: string }
  | { type: 'tool-start'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool-done'; id: string; ok: boolean; output: string; held?: boolean }
  | { type: 'held'; capability: string; message: string }
  | { type: 'usage'; usage: AgentStreamUsage; served: { provider: string; model: string } }
  | { type: 'done'; text: string; usage: AgentStreamUsage; served: { provider: string; model: string } | null; timing?: Record<string, number | null> }
  | { type: 'error'; code: string; message: string };

interface AgentStreamUsage { promptTokens: number; outputTokens: number; cachedInputTokens: number }

/** Split a Server-Sent Events byte stream into its events; comments (keepalives) are skipped. */
export async function* readAgentStream(
  body: ReadableStream<Uint8Array>, idleMs = AGENT_STREAM_IDLE_MS, signal?: AbortSignal,
): AsyncGenerator<AgentStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  // Ctrl+C: the read ends here and the connection closes, which is what aborts the server's run.
  const onAbort = () => void reader.cancel(signal?.reason).catch(() => undefined);
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      let idle: ReturnType<typeof setTimeout> | undefined;
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          idle = setTimeout(() => reject(new Error(`The agent stream went silent for ${Math.round(idleMs / 1000)}s.`)), idleMs);
        }),
      ]).finally(() => clearTimeout(idle));
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
        if (!data) continue;
        try {
          yield JSON.parse(data) as AgentStreamEvent;
        } catch {
          // A frame that is not JSON is not an event this client knows.
        }
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}

/** The agent finding or loading one of its own tools (either transport reports it this way). */
function isToolDiscovery(name: string): boolean {
  return name === 'search_tools' || name === 'load_tools';
}

/** A row for one of the agent's calls: its platform tools read as an MCP server's
 * (`silas › admin_jobs limit=5`); finding its tools reads as what it is. */
export function agentToolLabel(handle: string, name: string, input: Record<string, unknown>): string {
  if (name === 'search_tools') return `Search tools${typeof input.query === 'string' ? ` ${input.query}` : ''}`;
  if (name === 'load_tools') {
    const names = Array.isArray(input.names) ? input.names.filter((n): n is string => typeof n === 'string') : [];
    return `Load tools${names.length ? ` ${names.join(', ')}` : ''}`;
  }
  return toolLabel(`mcp__${handle}__${name}`, input);
}

/** The agent's usage in the shape every harness reports. */
function turnUsage(usage: AgentStreamUsage): TurnUsage {
  return { input: usage.promptTokens, output: usage.outputTokens, cacheRead: usage.cachedInputTokens };
}

export async function runGatewayAgentTurn(input: {
  config: Conf; state: HarnessState; session: HarnessSession; prompt: string; signal?: AbortSignal; run: TurnRunOptions;
}): Promise<void> {
  const { config, state, session, signal, run } = input;
  const prompter = run.prompter;
  const agentId = session.gatewayAgentId;
  if (!agentId) throw new Error('No Gateway agent is selected.');
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error('prompt is required');
  if (session.attachments?.length) throw new Error('Gateway agents cannot read local attachments. Send the content as text or choose a Gateway model.');
  const { baseUrl, apiKey } = gatewayConnection(config);
  const endpoint = `${baseUrl}/v1/agents/${encodeURIComponent(agentId)}/chat`;
  const startedAt = Date.now();
  const checkpoint = await startTurnCheckpoint(state, session, prompt, run);
  const sink = turnSink(checkpoint, prompter);
  /** A new thread -- the first message to this agent, or to another one --
   * knows nothing of the conversation so far. It is told it, the way a
   * provider taking a conversation over is (transfer.ts); a thread the agent
   * already holds carries it itself. */
  const messageFor = async (): Promise<string> => {
    if (session.gatewayAgentThreadId) return prompt;
    const record = canonicalRecord({ ...session, pendingTurn: undefined });
    if (!record.turns.length) return prompt;
    const { localHarnessForCommand } = await import('../runtime/lazy-bridge.js');
    return transferPrompt(record, prompt, {
      maxBytes: transferBudget({}), interrupted: false, displayName: (command) => localHarnessForCommand(command)?.displayName,
    });
  };
  let handle = 'agent';
  /** Each call's row, by id: its finish updates the row its start drew. */
  const rows = new Map<string, HarnessActivityEvent>();
  let answer = '';
  let usage: TurnUsage | undefined;
  let served: string | undefined;
  try {
    prompter?.phase('thinking');
    const response = await fetch(endpoint, {
      method: 'POST',
      ...(signal ? { signal } : {}),
      headers: {
        authorization: `Bearer ${apiKey}`, accept: 'text/event-stream', 'content-type': 'application/json', 'user-agent': CLIKCODE_USER_AGENT,
      },
      body: JSON.stringify({ message: await messageFor(), threadId: session.gatewayAgentThreadId ?? null, stream: true, ...agentTurnSettings(session) }),
    });
    if (!response.body || !(response.headers.get('content-type') ?? '').includes('text/event-stream')) {
      const body = await response.json().catch(() => ({})) as { error?: unknown };
      throw new Error(typeof body.error === 'string' ? body.error : `Gateway agent request failed (${response.status})`);
    }
    let finished = false;
    const events = readAgentStream(response.body, AGENT_STREAM_IDLE_MS, signal);
    for await (const event of (async function* () {
      // Ctrl+C aborts the read; the turn ends as cancelled, not as a broken stream.
      try {
        yield* events;
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        throw error;
      }
    })()) {
      switch (event.type) {
        case 'start':
          handle = event.agent.handle;
          session.gatewayAgentThreadId = event.threadId;
          session.gatewayAgentName = event.agent.name;
          await checkpoint.flush();
          prompter?.render(session);
          break;
        case 'step':
          prompter?.phase('thinking');
          break;
        case 'text':
          answer += event.text;
          sink.response(event.text, 'append');
          break;
        case 'tool-start': {
          const row: HarnessActivityEvent = {
            kind: 'tool-start', id: event.id, label: agentToolLabel(handle, event.name, event.input),
            ...(isToolDiscovery(event.name) ? { category: 'search' as const } : {}),
            call: { name: event.name, input: event.input },
          };
          rows.set(event.id, row);
          sink.activity(row);
          break;
        }
        case 'tool-done': {
          const start = rows.get(event.id);
          const output = eventOutputPreview(event.held ? `Held for approval — nothing was changed.\n${event.output}` : event.output);
          sink.activity({
            kind: event.ok ? 'tool-done' : 'tool-error', id: event.id, label: start?.label ?? event.id,
            ...(start?.call ? { call: start.call } : {}), ...(output ?? {}),
          });
          break;
        }
        case 'held':
          // A write the agent's permission mode held for a person: said the moment it is held.
          sink.activity({ kind: 'tool-error', id: `held-${event.capability}`, label: `Held for approval: ${event.capability}`, output: [event.message] });
          break;
        case 'usage':
          usage = turnUsage(event.usage);
          served = event.served.model;
          session.lastUsage = { ...usage, at: new Date().toISOString() };
          session.reported = { ...session.reported, at: new Date().toISOString(), model: served };
          prompter?.setTurnUsage(usage);
          prompter?.render(session);
          break;
        case 'done':
          usage = turnUsage(event.usage);
          if (event.served) served = event.served.model;
          finished = true;
          break;
        case 'error':
          if (event.code === 'cancelled' && signal?.aborted) throw signal.reason ?? new Error('Gateway agent turn cancelled');
          throw new Error(event.message || `Gateway agent refused the message (${event.code})`);
      }
    }
    if (!finished) {
      if (signal?.aborted) throw signal.reason ?? new Error('Gateway agent turn cancelled');
      throw new Error('The agent stream ended before the answer finished.');
    }
    const invocation = recordInvocation(state, {
      sessionId: session.id, accountId: 'gateway', provider: 'gateway', model: served ?? session.model, startedAt,
      ...(usage ? { usage } : {}),
    });
    const text = await completeTurnCheckpoint(session, checkpoint, answer, {});
    if (!prompter) emitHarnessOutput({ session, text, invocation, usage: { attributedBy: 'gateway', ...usage } });
  } finally {
    await checkpoint.flush();
  }
}
