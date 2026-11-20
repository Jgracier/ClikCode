import { describe, expect, it } from 'vitest';

describe('a connector answer too large to read at once', () => {
  const big = { spec: { id: 'adsense', http: { baseUrl: 'https://adsense.googleapis.com/v1.4' }, actions: Array.from({ length: 400 }, (_, i) => ({ event: `adsense.op-${i}`, run: { request: { method: 'GET', path: `/accounts/${i}` } }, description: 'x'.repeat(200) })) } };
  it('comes back as an outline naming every operation, and a part by JSON pointer', async () => {
    const { readable, MAX_TOOL_OUTPUT } = await import('./connector-micro-agent-mcp.js');
    const shown = readable(big);
    expect(shown.length).toBeLessThan(MAX_TOOL_OUTPUT);
    expect(shown).toContain('args.path');
    expect(shown).toContain('12: adsense.op-12 GET /accounts/12');
    expect(JSON.parse(readable(big, '/http'))).toEqual({ baseUrl: 'https://adsense.googleapis.com/v1.4' });
    expect(JSON.parse(readable(big, '/actions/7/run/request'))).toEqual({ method: 'GET', path: '/accounts/7' });
    expect(readable(big, '/nope')).toContain('Nothing at /nope');
    // A small answer is unchanged.
    expect(readable({ spec: { id: 'tiny' } })).toBe('{"spec":{"id":"tiny"}}');
  });
});

describe('the agent MCP server and the egress', () => {
  it('binds its tab to the vendor run\'s egress before the first browser call, once', async () => {
    const { agentMcpHandler } = await import('./connector-micro-agent-mcp.js');
    const bound: string[] = [];
    const ran: string[] = [];
    const tool = { name: 'browser_use', class: 'write', description: '', parameters: {}, label: () => '', run: async (args: { tab: string }) => { ran.push(`${args.tab}@${bound.length}`); return { output: 'ok' }; } };
    const handle = agentMcpHandler({ tab: 'agent-acme', maxCalls: 5, egress: 'prod', stateDir: '/tmp/none', tools: [tool as never], bindEgress: async (_dir, tab, egress) => { bound.push(`${tab}->${egress}`); } });
    for (const id of [1, 2]) await handle({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'browser_use', arguments: { action: 'open', url: 'https://acme.example', tab: 'other' } } });
    expect(bound).toEqual(['agent-acme->prod']);
    expect(ran).toEqual(['agent-acme@1', 'agent-acme@1']);
  });

  it('binds nothing for home', async () => {
    const { agentMcpHandler } = await import('./connector-micro-agent-mcp.js');
    const bound: string[] = [];
    const tool = { name: 'browser_use', class: 'write', description: '', parameters: {}, label: () => '', run: async () => ({ output: 'ok' }) };
    const handle = agentMcpHandler({ tab: 'agent-acme', maxCalls: 5, egress: 'home', stateDir: '/tmp/none', tools: [tool as never], bindEgress: async (_dir, tab, egress) => { bound.push(`${tab}->${egress}`); } });
    await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'browser_use', arguments: {} } });
    expect(bound).toEqual([]);
  });
});
