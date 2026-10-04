/** `clikcode conversations-mcp`: the conversation tools as a stdio MCP
 * server, for vendor agents. ClikCode installs it into each harness the way
 * it installs every other MCP server (harness/provision.ts), so Claude Code,
 * Codex, Gemini and the rest can see the user's other conversations too.
 * Read-only: it reads the index and transcripts and never writes.
 *
 * The conversation the vendor is running is left out by default. The vendor
 * is spawned by that conversation's worker (`clikcode session-worker <id>`)
 * and spawns this server, so the id is found in the process ancestry when
 * CLIKCODE_SESSION_ID did not survive the vendor's environment filtering. */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { CONVERSATIONS_MCP_NAME } from './mcp-entry.js';
import { CONVERSATION_TOOLS, CONVERSATION_TOOLS_NOTE, conversationTool, type ConversationToolContext } from './tools.js';

interface RpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown>; protocolVersion?: string };
}

const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

/** The session id a `session-worker <id>` argv names. */
export function workerSessionFromArgv(argv: readonly string[]): string | undefined {
  const at = argv.indexOf('session-worker');
  const id = at >= 0 ? argv[at + 1] : undefined;
  return id && !id.startsWith('-') ? id : undefined;
}

function parentAndArgv(pid: number): { ppid: number; argv: string[] } | undefined {
  try {
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      // The command name is in parentheses and may hold spaces: fields
      // after the last `)` are fixed. State, then the parent pid.
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
      return Number.isFinite(ppid) ? { ppid, argv } : undefined;
    }
    if (process.platform === 'win32') return undefined;
    const line = execFileSync('ps', ['-o', 'ppid=,command=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 }).trim();
    const match = /^(\d+)\s+(.*)$/.exec(line);
    return match ? { ppid: Number(match[1]), argv: match[2]!.split(/\s+/) } : undefined;
  } catch {
    return undefined;
  }
}

/** The ClikCode conversation this server was started for, if any. */
export function currentConversationSession(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const named = env.CLIKCODE_SESSION_ID?.trim();
  if (named) return named;
  let pid = process.ppid;
  for (let hop = 0; hop < 12 && pid > 1; hop += 1) {
    const found = parentAndArgv(pid);
    if (!found) return undefined;
    const id = workerSessionFromArgv(found.argv);
    if (id) return id;
    pid = found.ppid;
  }
  return undefined;
}

export async function answerMcp(message: RpcMessage, context: ConversationToolContext): Promise<unknown | undefined> {
  if (!message.method || message.id === undefined || message.id === null) return undefined;
  const respond = (result: unknown) => ({ jsonrpc: '2.0', id: message.id, result });
  if (message.method === 'initialize') {
    const asked = message.params?.protocolVersion;
    return respond({
      protocolVersion: asked && SUPPORTED_PROTOCOLS.includes(asked) ? asked : SUPPORTED_PROTOCOLS[0],
      capabilities: { tools: {} },
      serverInfo: { name: CONVERSATIONS_MCP_NAME, version: '1' },
      instructions: CONVERSATION_TOOLS_NOTE,
    });
  }
  if (message.method === 'ping') return respond({});
  if (message.method === 'tools/list') {
    return respond({
      tools: CONVERSATION_TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema, annotations: { readOnlyHint: true } })),
    });
  }
  if (message.method === 'tools/call') {
    const tool = conversationTool(message.params?.name ?? '');
    if (!tool) return { jsonrpc: '2.0', id: message.id, error: { code: -32602, message: `Unknown tool ${message.params?.name ?? ''}` } };
    try {
      const result = await tool.run(message.params?.arguments ?? {}, context);
      return respond({ content: [{ type: 'text', text: result.text }], ...(result.isError ? { isError: true } : {}) });
    } catch (error) {
      return respond({ content: [{ type: 'text', text: `${tool.name} failed: ${error instanceof Error ? error.message : String(error)}` }], isError: true });
    }
  }
  if (message.method === 'resources/list') return respond({ resources: [] });
  if (message.method === 'prompts/list') return respond({ prompts: [] });
  return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } };
}

/** Stdio MCP. Each answer goes back in the framing its request came in:
 * newline-delimited JSON (the MCP stdio transport), or Content-Length
 * frames, which some clients send. */
export function serveConversationsMcp(): Promise<void> {
  const context: ConversationToolContext = {};
  const current = currentConversationSession();
  if (current) context.currentSessionId = current;
  return new Promise((resolve) => {
    let buffer = Buffer.alloc(0);
    let queue = Promise.resolve();
    const write = (payload: unknown, framed: boolean): void => {
      const body = JSON.stringify(payload);
      process.stdout.write(framed ? `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}` : `${body}\n`);
    };
    const deliver = (body: string, framed: boolean): void => {
      let message: RpcMessage;
      try { message = JSON.parse(body) as RpcMessage; } catch { return; }
      // In order: a client may pipeline, and answers must not overtake.
      queue = queue.then(async () => {
        const answer = await answerMcp(message, context);
        if (answer) write(answer, framed);
      }).catch(() => undefined);
    };
    const take = (): void => {
      for (;;) {
        const head = buffer.subarray(0, Math.min(buffer.length, 15)).toString('utf8').toLowerCase();
        if (head.startsWith('content-length:') || (buffer.length < 15 && 'content-length:'.startsWith(head) && head.length > 0)) {
          const headerEnd = buffer.indexOf('\r\n\r\n');
          if (headerEnd < 0) return;
          const length = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, headerEnd).toString('utf8'))?.[1]);
          if (!Number.isFinite(length)) { buffer = buffer.subarray(headerEnd + 4); continue; }
          if (buffer.length < headerEnd + 4 + length) return;
          const body = buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString('utf8');
          buffer = buffer.subarray(headerEnd + 4 + length);
          deliver(body, true);
          continue;
        }
        const lineEnd = buffer.indexOf('\n');
        if (lineEnd < 0) return;
        const line = buffer.subarray(0, lineEnd).toString('utf8').trim();
        buffer = buffer.subarray(lineEnd + 1);
        if (line) deliver(line, false);
      }
    };
    process.stdin.on('data', (chunk: Buffer) => { buffer = Buffer.concat([buffer, chunk]); take(); });
    process.stdin.on('end', () => { void queue.then(() => resolve()); });
  });
}
