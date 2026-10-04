import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { serveStdioMcp } from './mcp-stdio-server.js';

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
