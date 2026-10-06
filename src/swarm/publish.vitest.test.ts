import { describe, expect, it } from 'vitest';
import { allLocalHarnesses } from '../runtime/lazy-bridge.js';
import { mcpAddArgv, mcpAddGrammar } from '../harness/mcp-registry.js';
import {
  SWARM_CLERK_ENV,
  SWARM_MCP_NAME,
  swarmAcpMcpServers,
  swarmCodexConfig,
  swarmProvisionEntry,
  swarmRidesTurn,
  swarmTurnArgv,
} from './publish.js';
import { SWARM_POLICY } from './policy.js';

describe('swarm distribution across hosts', () => {
  const harnesses = allLocalHarnesses();
  const claude = harnesses.find((h) => h.command === 'claude')!;
  const codex = harnesses.find((h) => h.command === 'codex')!;
  const amp = harnesses.find((h) => h.command === 'amp')!;
  const pi = harnesses.find((h) => h.command === 'pi')!;
  const antigravity = harnesses.find((h) => h.command === 'antigravity')!;
  const command = harnesses.find((h) => h.command === 'command')!;
  const openclaw = harnesses.find((h) => h.command === 'openclaw')!;

  it('generates ACP servers scoped to the session id', () => {
    const servers = swarmAcpMcpServers('session-123');
    expect(servers.length).toBe(1);
    expect(servers[0].name).toBe(SWARM_MCP_NAME);
    expect(servers[0].env).toContainEqual({ name: 'CLIKCODE_SESSION_ID', value: 'session-123' });
  });

  it('generates Codex app-server config scoped to the session id', () => {
    const config = swarmCodexConfig('session-456');
    const key = `mcp_servers.${SWARM_MCP_NAME}`;
    expect(config).toHaveProperty(key);
    const entry = config[key] as { command: string; args: string[]; env: Record<string, string> };
    expect(entry.env.CLIKCODE_SESSION_ID).toBe('session-456');
  });

  it('determines whether swarm rides the session/turn vs needs vendor mcp provisioning', () => {
    // Rides session or turn directly:
    expect(swarmRidesTurn(claude)).toBe(true);
    expect(swarmRidesTurn(codex)).toBe(true);
    expect(swarmRidesTurn(amp)).toBe(true);
    expect(swarmRidesTurn(pi)).toBe(true);

    // Needs vendor provisioning because harness has mcp add but no per-turn channel:
    expect(swarmRidesTurn(antigravity)).toBe(false);
    expect(swarmRidesTurn(command)).toBe(false);
    expect(swarmRidesTurn(openclaw)).toBe(false);
  });

  it('produces turn argv for Amp with inline mcp configuration', async () => {
    const argv = await swarmTurnArgv(amp.turn, 'session-amp');
    expect(argv.length).toBe(2);
    expect(argv[0]).toBe('--mcp-config');
    const parsed = JSON.parse(argv[1]) as Record<string, { env: Record<string, string> }>;
    expect(parsed[SWARM_MCP_NAME].env.CLIKCODE_SESSION_ID).toBe('session-amp');
  });

  it('produces turn argv for Pi with the extension file', async () => {
    const argv = await swarmTurnArgv(pi.turn, 'session-pi');
    expect(argv.length).toBe(2);
    expect(argv[0]).toBe('-e');
    expect(argv[1]).toContain('pi-swarm-extension.js');
  });

  it('provides a provision entry for harnesses that use vendor mcp add', () => {
    const entry = swarmProvisionEntry();
    expect(entry).toBeDefined();
    expect(entry!.name).toBe(SWARM_MCP_NAME);
    expect(entry!.args).toContain('swarm-mcp');
  });

  it('supports OpenClaw mcp add and remove grammar', () => {
    const grammar = mcpAddGrammar(openclaw);
    expect(grammar).toBeDefined();
    expect(grammar?.shape).toBe('named-flags');

    const entry = swarmProvisionEntry()!;
    const argv = mcpAddArgv(grammar, entry);
    expect(argv).toBeDefined();
    expect(argv).toContain('add');
    expect(argv).toContain('--no-probe');
    expect(argv).toContain(SWARM_MCP_NAME);
    expect(argv).toContain('--command');
  });

  it('defines SWARM_CLERK_ENV for preventing nested swarms', () => {
    expect(SWARM_CLERK_ENV).toBe('CLIKCODE_SWARM_CLERK');
  });

  it('does not limit parallel workers in default swarm policy', () => {
    expect(SWARM_POLICY.maxParallel).toBeUndefined();
    expect(SWARM_POLICY.maxWorkers).toBeUndefined();
  });
});
