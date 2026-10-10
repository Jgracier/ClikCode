/** The stdio side of ClikCode's own MCP servers (`conversations-mcp`,
 * `swarm-mcp`): reading requests and writing answers.
 *
 * The MCP stdio transport is newline-delimited JSON; some clients send
 * Content-Length frames instead. Each message is answered -- and anything
 * sent while it is handled, such as progress -- in the framing it came in,
 * so either kind of client can read what comes back. */

const HEADER = 'content-length:';

export type McpSend = (payload: unknown) => void;

export interface StdioStreams {
  input: NodeJS.ReadableStream;
  output: { write(chunk: string): unknown };
}

/** Serves until the input ends, then resolves once every message read has
 * been handled. `handle` sees one message at a time, in order (a client may
 * pipeline, and answers must not overtake); what it returns, if anything, is
 * written as that message's answer. Unparseable input is skipped. */
export function serveStdioMcp(
  handle: (message: unknown, send: McpSend) => Promise<unknown>,
  streams: StdioStreams = { input: process.stdin, output: process.stdout },
): Promise<void> {
  return new Promise((resolve) => {
    let buffer = Buffer.alloc(0);
    let queue = Promise.resolve();
    const sender = (framed: boolean): McpSend => (payload) => {
      const body = JSON.stringify(payload);
      streams.output.write(framed ? `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}` : `${body}\n`);
    };
    const deliver = (body: string, framed: boolean): void => {
      let message: unknown;
      try { message = JSON.parse(body); } catch { return; }
      const send = sender(framed);
      queue = queue.then(async () => {
        const answer = await handle(message, send);
        if (answer !== undefined) send(answer);
      }).catch(() => undefined);
    };
    const take = (): void => {
      for (;;) {
        const head = buffer.subarray(0, Math.min(buffer.length, HEADER.length)).toString('utf8').toLowerCase();
        // A frame, or what may yet become one: wait for the rest of its header.
        if (head.length > 0 && (head.startsWith(HEADER) || HEADER.startsWith(head))) {
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
    streams.input.on('data', (chunk: Buffer | string) => { buffer = Buffer.concat([buffer, Buffer.from(chunk)]); take(); });
    streams.input.on('end', () => { void queue.then(() => resolve()); });
  });
}

/** The MCP protocol versions these servers speak, newest first: the client's
 * own when it asks for one of these, else the newest. */
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

export interface McpTool {
  name: string;
  description: string;
  inputSchema: unknown;
  annotations?: Record<string, unknown>;
}

export interface McpToolServer {
  name: string;
  instructions?: string;
  /** Asked on every tools/list: the list may depend on the conversation. */
  tools(): readonly McpTool[] | Promise<readonly McpTool[]>;
  /** One call. Undefined for a tool this server does not have. `progress`
   * is there when the client asked for progress on this call. */
  call(name: string, args: Record<string, unknown>, progress: ((message: string) => void) | undefined):
    Promise<{ text: string; isError?: boolean } | undefined>;
}

interface RpcMessage {
  id?: number | string | null;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown>; protocolVersion?: string; _meta?: { progressToken?: unknown } };
}

/** A tools-only MCP server's answers (initialize, ping, tools/list,
 * tools/call, empty resource and prompt lists), for serveStdioMcp. A thrown
 * tool is answered as a failed call the agent can read, not a protocol error. */
export function toolServer(server: McpToolServer): (message: unknown, send: McpSend) => Promise<unknown> {
  return async (raw, send) => {
    const message = raw as RpcMessage;
    if (!message.method || message.id === undefined || message.id === null) return undefined;
    const respond = (result: unknown) => ({ jsonrpc: '2.0', id: message.id, result });
    const error = (code: number, text: string) => ({ jsonrpc: '2.0', id: message.id, error: { code, message: text } });
    switch (message.method) {
      case 'initialize': {
        const asked = message.params?.protocolVersion;
        return respond({
          protocolVersion: asked && SUPPORTED_PROTOCOLS.includes(asked) ? asked : SUPPORTED_PROTOCOLS[0],
          capabilities: { tools: {} },
          serverInfo: { name: server.name, version: '1' },
          ...(server.instructions ? { instructions: server.instructions } : {}),
        });
      }
      case 'ping': return respond({});
      case 'tools/list': return respond({ tools: await server.tools() });
      case 'resources/list': return respond({ resources: [] });
      case 'prompts/list': return respond({ prompts: [] });
      case 'tools/call': {
        const name = message.params?.name ?? '';
        const token = message.params?._meta?.progressToken;
        let step = 0;
        const progress = typeof token === 'string' || typeof token === 'number'
          ? (text: string) => { step += 1; send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: step, message: text } }); }
          : undefined;
        try {
          const result = await server.call(name, message.params?.arguments ?? {}, progress);
          if (!result) return error(-32602, `Unknown tool ${name}`);
          return respond({ content: [{ type: 'text', text: result.text }], ...(result.isError ? { isError: true } : {}) });
        } catch (thrown) {
          return respond({ content: [{ type: 'text', text: `${name} failed: ${thrown instanceof Error ? thrown.message : String(thrown)}` }], isError: true });
        }
      }
      default: return error(-32601, `Method not found: ${message.method}`);
    }
  };
}
