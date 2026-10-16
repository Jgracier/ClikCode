import { describe, expect, it } from 'vitest';
import { acpMcpServer } from './acp-mcp-servers.js';

describe('acpMcpServer', () => {
  it('spells a local server with env pairs', () => {
    expect(acpMcpServer({ name: 'a', transport: 'stdio', command: 'npx', args: ['-y', 'x'], env: { K: 'v' } }, {}))
      .toEqual({ name: 'a', command: 'npx', args: ['-y', 'x'], env: [{ name: 'K', value: 'v' }] });
  });
  it('sends a remote server only to a harness that takes its transport', () => {
    const spec = { name: 'r', transport: 'http', url: 'https://x/mcp', headers: { A: 'b' } } as const;
    expect(acpMcpServer(spec, {})).toBeUndefined();
    expect(acpMcpServer(spec, { mcpCapabilities: { http: true } }))
      .toEqual({ type: 'http', name: 'r', url: 'https://x/mcp', headers: [{ name: 'A', value: 'b' }] });
  });
});
