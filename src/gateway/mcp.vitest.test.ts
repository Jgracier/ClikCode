import { describe, expect, it, vi } from 'vitest';

vi.mock('../agent/models/for-session.js', () => ({
  gatewayConnection: () => ({ baseUrl: 'https://clikdeploy.com/', apiKey: 'cd_live_key' }),
}));

const { clikDeployMcpServer, CLIKDEPLOY_CORE_TOOLS, CLIKDEPLOY_MCP_TURN_WAIT_MS, routeMcpServers } = await import('./mcp.js');

describe('ClikDeploy’s own MCP server', () => {
  it('comes with a Gateway conversation: search mode, the Gateway key, a CLI-like core, a short turn wait', () => {
    const [server] = routeMcpServers({ route: 'gateway' } as never, {} as never);
    expect(server).toEqual({
      name: 'clikdeploy', transport: 'http', url: 'https://clikdeploy.com/mcp?toolmode=search',
      headers: { authorization: 'Bearer cd_live_key' }, core: CLIKDEPLOY_CORE_TOOLS, turnWaitMs: CLIKDEPLOY_MCP_TURN_WAIT_MS,
    });
    // A coding turn never waits the 30 s connect timeout on it.
    expect(CLIKDEPLOY_MCP_TURN_WAIT_MS).toBeLessThanOrEqual(5000);
    expect(CLIKDEPLOY_CORE_TOOLS).toEqual(expect.arrayContaining(['list_apps', 'get_app_logs', 'deploy_app', 'search_tools', 'call_tool']));
  });

  it('comes with no other route', () => {
    expect(routeMcpServers({ route: 'local' } as never, {} as never)).toEqual([]);
    expect(routeMcpServers({ route: 'clikcode-local' } as never, {} as never)).toEqual([]);
  });

  it('trims a trailing slash from the Gateway address', () => {
    expect(clikDeployMcpServer({ baseUrl: 'https://g.example/', apiKey: 'k' }).url).toBe('https://g.example/mcp?toolmode=search');
  });
});
