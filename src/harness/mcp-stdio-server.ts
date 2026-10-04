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
