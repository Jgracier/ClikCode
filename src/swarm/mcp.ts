/** The `swarm` tool on the ACP session this chat opened. ClikCode answers it
 * in this process. It is one subagent row: the chat shows that provider
 * working, and the tool result is the card. */

import { randomUUID } from 'node:crypto';
import { readState } from '../session/state/read.js';
import { activeSwarmHost } from './store.js';
import { swarmIsOn } from './policy.js';
import { runSwarmDelegation } from './run.js';

interface RpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
}

const TOOL = {
  name: 'swarm',
  description: 'Hand one self-contained task to another signed-in account that has usage left. This chat shows that provider as one subagent: its steps appear under the row, and you get back a short card (summary, paths, blockers), not that account\'s conversation. Use it when the task spans files, is a review, or is an edit worth handing off. A one-file question stays with you; the tool says so.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['prompt'],
    properties: {
      prompt: { type: 'string', description: 'The complete task: what to do, where to look, and what the card should answer.' },
      description: { type: 'string', description: 'A 3-6 word label shown in the host chat, e.g. "Find the refresh handler".' },
    },
  },
};

async function callTool(args: Record<string, unknown> | undefined): Promise<string> {
  const prompt = typeof args?.prompt === 'string' ? args.prompt.trim() : '';
  if (!prompt) return 'A swarm task needs a prompt.';
  const description = typeof args?.description === 'string' ? args.description.trim() : undefined;
  const sessionId = await activeSwarmHost();
  if (!sessionId) return 'No host turn is using the swarm right now. Do this yourself.';
  const state = await readState({ transcripts: [] });
  const host = state.sessions.find((session) => session.id === sessionId);
  if (!host || !swarmIsOn(host)) return 'This conversation has no swarm on. Do this yourself.';
  const result = await runSwarmDelegation({
    host, state, request: { prompt, ...(description ? { description } : {}), callId: `swarm-${randomUUID()}` },
  });
  return result?.output ?? 'Keep this task on the host. It is small enough that another provider would cost more than it saves.';
}

function respond(id: RpcMessage['id'], result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function fail(id: RpcMessage['id'], message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message } });
}

async function dispatch(message: RpcMessage): Promise<string | undefined> {
  if (!message.method || message.id === undefined || message.id === null) return undefined;
  if (message.method === 'initialize') {
    return respond(message.id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'clikcode-swarm', version: '1' },
    });
  }
  if (message.method === 'tools/list') return respond(message.id, { tools: [TOOL] });
  if (message.method === 'tools/call') {
    try {
      const text = message.params?.name === 'swarm'
        ? await callTool(message.params.arguments)
        : `Unknown tool ${message.params?.name ?? ''}`;
      const isError = text.startsWith('No host') || text.startsWith('A swarm task needs');
      return respond(message.id, { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });
    } catch (error) {
      return fail(message.id, error instanceof Error ? error.message : String(error));
    }
  }
  return respond(message.id, {});
}

/** Stdio MCP, framed the way vendor clients send it (Content-Length), and
 * also newline-delimited JSON for a manual check. */
export function serveSwarmMcp(): Promise<void> {
  return new Promise((resolve) => {
    let buffer = '';
    const write = (payload: string): void => {
      const body = Buffer.from(payload, 'utf8');
      process.stdout.write(`Content-Length: ${body.length}\r\n\r\n${payload}`);
    };
    const take = async (): Promise<void> => {
      for (;;) {
        const headerEnd = buffer.indexOf('\r\n\r\n');
        const lineEnd = buffer.indexOf('\n');
        if (headerEnd >= 0 && (lineEnd < 0 || headerEnd < lineEnd)) {
          const header = buffer.slice(0, headerEnd);
          const match = /Content-Length:\s*(\d+)/i.exec(header);
          if (!match) { buffer = buffer.slice(headerEnd + 4); continue; }
          const length = Number(match[1]);
          const start = headerEnd + 4;
          if (buffer.length < start + length) return;
          const body = buffer.slice(start, start + length);
          buffer = buffer.slice(start + length);
          await deliver(body);
          continue;
        }
        if (lineEnd < 0) return;
        const line = buffer.slice(0, lineEnd).trim();
        buffer = buffer.slice(lineEnd + 1);
        if (!line || line.startsWith('Content-Length')) continue;
        await deliver(line);
      }
    };
    const deliver = async (body: string): Promise<void> => {
      let message: RpcMessage;
      try { message = JSON.parse(body) as RpcMessage; } catch { return; }
      const payload = await dispatch(message);
      if (payload) write(payload);
    };
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => { buffer += chunk; void take(); });
    process.stdin.on('end', () => resolve());
  });
}
