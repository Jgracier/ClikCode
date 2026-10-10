/** The `swarm` tool on the ACP session this chat opened. ClikCode answers it
 * in this process. It is one subagent row: the chat shows that provider
 * working, and the tool result is the card. */

import { randomUUID } from 'node:crypto';
import { serveStdioMcp, toolServer } from '../harness/mcp-stdio-server.js';
import { readState } from '../session/state/read.js';
import { currentConversationSession } from '../worker/current-session.js';
import { swarmIsOn } from './policy.js';
import { runSwarmDelegation, swarmModelList } from './run.js';
import { SWARM_CLERK_ENV } from './publish.js';

/** A clerk step the host shows while the tool is still open. The card is the
 * tool result, so a finished row is not progress. */
export function swarmProgressLabel(event: { kind: string; label: string }): string | undefined {
  if (event.kind === 'tool-done' || event.kind === 'tool-error') return undefined;
  const label = event.label.trim();
  return label || undefined;
}

const TOOL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['prompt'],
  properties: {
    prompt: { type: 'string', description: 'The complete task: what to do, where to look, and what the card should answer.' },
    description: { type: 'string', description: 'A 3-6 word label shown in the host chat, e.g. "Find the refresh handler".' },
    model: { type: 'string', description: 'A model id from the list on this tool. Pass "list" to see every model. Omit it to use the account with the most usage left.' },
  },
};

async function toolSpec(): Promise<{ name: string; description: string; inputSchema: typeof TOOL_SCHEMA } | undefined> {
  if (process.env[SWARM_CLERK_ENV]) return undefined;
  let description = 'Hand one self-contained task to a model that has usage left. This chat shows it as one subagent: its steps appear under the row, and you get back a short card, not that model\'s conversation.';
  const sessionId = currentConversationSession();
  if (sessionId) {
    const state = await readState({ transcripts: [] });
    const host = state.sessions.find((session) => session.id === sessionId);
    if (host && !swarmIsOn(host)) return undefined;
    if (host && swarmIsOn(host)) description = await swarmModelList(host, state).catch(() => description);
  }
  return { name: 'swarm', description, inputSchema: TOOL_SCHEMA };
}

async function callTool(args: Record<string, unknown> | undefined, onStep?: (label: string) => void): Promise<string> {
  if (process.env[SWARM_CLERK_ENV]) return 'A swarm clerk cannot start another swarm.';
  const prompt = typeof args?.prompt === 'string' ? args.prompt.trim() : '';
  const description = typeof args?.description === 'string' ? args.description.trim() : undefined;
  const model = typeof args?.model === 'string' && args.model.trim() ? args.model.trim() : undefined;
  if (!prompt && model?.toLowerCase() !== 'list') return 'A swarm task needs a prompt.';
  const sessionId = currentConversationSession();
  if (!sessionId) return 'No ClikCode conversation is running this tool. Do this yourself.';
  const state = await readState({ transcripts: [] });
  const host = state.sessions.find((session) => session.id === sessionId);
  if (!host || !swarmIsOn(host)) return 'This conversation has no swarm on. Do this yourself.';
  const result = await runSwarmDelegation({
    host, state, request: { prompt, ...(description ? { description } : {}), ...(model ? { model } : {}), callId: `swarm-${randomUUID()}` },
    onActivity: (event) => {
      const label = swarmProgressLabel(event);
      if (label) onStep?.(label);
    },
  });
  return result?.output ?? 'No other account with usage is available to take this task right now.';
}

/** Stdio MCP, answered (progress included) in whichever framing the client used. */
export function serveSwarmMcp(): Promise<void> {
  return serveStdioMcp(toolServer({
    name: 'clikcode-swarm',
    tools: async () => { const spec = await toolSpec(); return spec ? [spec] : []; },
    call: async (name, args, progress) => {
      if (name !== 'swarm') return undefined;
      const text = await callTool(args, progress);
      const isError = text.startsWith('No ClikCode conversation') || text.startsWith('A swarm task needs') || text.startsWith('Choose a model') || text.startsWith('No account with usage') || text.startsWith('No other account with usage') || text.startsWith('Path lease');
      return { text, ...(isError ? { isError: true } : {}) };
    },
  }));
}
