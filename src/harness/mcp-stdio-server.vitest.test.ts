import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { serveStdioMcp, toolServer } from './mcp-stdio-server.js';

function served(handle: Parameters<typeof serveStdioMcp>[0]): { input: PassThrough; written: () => string; done: Promise<void> } {
  const input = new PassThrough();
  let text = '';
  const done = serveStdioMcp(handle, { input, output: { write: (chunk: string) => { text += chunk; } } });
  return { input, written: () => text, done };
}

describe('stdio MCP framing', () => {
  it('answers each message, and what is sent while handling it, in the framing it came in', async () => {
    const { input, written, done } = served(async (message, send) => {
      const { id } = message as { id: number };
      send({ progress: id });
      return { id };
    });
    input.write('{"id":1}\n');
    const body = '{"id":2}';
    const frame = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    // A header split mid-word is still a header.
    input.write(frame.slice(0, 4));
    input.write(frame.slice(4));
    input.write('not json\n{"id":3}\n');
    input.end();
    await done;
    expect(written()).toBe([
      '{"progress":1}\n', '{"id":1}\n',
      'Content-Length: 14\r\n\r\n{"progress":2}', 'Content-Length: 8\r\n\r\n{"id":2}',
      '{"progress":3}\n', '{"id":3}\n',
    ].join(''));
  });

  it('answers in order even when an earlier message takes longer', async () => {
    const { input, written, done } = served(async (message) => {
      const { id } = message as { id: number };
      if (id === 1) await new Promise((resolve) => setTimeout(resolve, 30));
      return { id };
    });
    input.write('{"id":1}\n{"id":2}\n');
    input.end();
    await done;
    expect(written()).toBe('{"id":1}\n{"id":2}\n');
  });
});

describe('a tools-only MCP server', () => {
  const sent: unknown[] = [];
  const answer = toolServer({
    name: 'test-server',
    tools: () => [{ name: 'echo', description: 'echo', inputSchema: { type: 'object' } }],
    call: async (name, args, progress) => {
      if (name === 'boom') throw new Error('it broke');
      if (name !== 'echo') return undefined;
      progress?.('working');
      return { text: String(args.text) };
    },
  });
  const ask = (method: string, params?: object) => answer({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }, (payload) => sent.push(payload));

  it("speaks the client's protocol version when it knows it, else its newest", async () => {
    expect(await ask('initialize', { protocolVersion: '2024-11-05' })).toMatchObject({ result: { protocolVersion: '2024-11-05', serverInfo: { name: 'test-server' } } });
    expect(await ask('initialize', { protocolVersion: '1999-01-01' })).toMatchObject({ result: { protocolVersion: '2025-06-18' } });
  });

  it('lists and calls tools, with progress only when asked, and says what failed', async () => {
    expect(await ask('tools/list')).toMatchObject({ result: { tools: [{ name: 'echo' }] } });
    expect(await ask('tools/call', { name: 'echo', arguments: { text: 'hi' } })).toEqual({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'hi' }] } });
    expect(sent).toEqual([]);
    await ask('tools/call', { name: 'echo', arguments: { text: 'hi' }, _meta: { progressToken: 'p' } });
    expect(sent).toEqual([{ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 'p', progress: 1, message: 'working' } }]);
    expect(await ask('tools/call', { name: 'nope' })).toMatchObject({ error: { code: -32602, message: 'Unknown tool nope' } });
    expect(await ask('tools/call', { name: 'boom' })).toMatchObject({ result: { content: [{ text: 'boom failed: it broke' }], isError: true } });
    expect(await ask('other/thing')).toMatchObject({ error: { code: -32601 } });
    expect(await answer({ jsonrpc: '2.0', method: 'notifications/initialized' }, () => undefined)).toBeUndefined();
  });
});
