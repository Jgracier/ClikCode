/** The global MCP servers for a one-shot CLI harness that declares a per-run MCP
 * flag (catalog `turn.mcpConfigArgv`: Amp's `--mcp-config`). The servers go in a
 * file only this user can read, in a directory of its own, removed once the run
 * is over -- not inline, where any process could read them on the command line.
 * A harness with no per-run mechanism gets none: what each one has is recorded
 * in docs/HARNESS_CAPABILITY_STATUS.md. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AiLocalHarnessDefinition } from '../../definition.js';
import { ampMcpConfig, globalMcpServers } from '../acp-mcp-servers.js';

export interface NativeMcpConfig {
  /** The flag and its file, to go before the turn's own argv; empty for none. */
  argv: string[];
  /** Removes the file. Safe to call more than once. */
  dispose(): Promise<void>;
}

const NONE: NativeMcpConfig = { argv: [], dispose: async () => undefined };

export async function nativeMcpConfig(harness: Pick<AiLocalHarnessDefinition, 'command' | 'turn'>, home?: string): Promise<NativeMcpConfig> {
  const flag = harness.turn?.mcpConfigArgv;
  if (!flag?.length) return NONE;
  // The stored sign-ins stay out: their tokens are never written anywhere new.
  const servers = await globalMcpServers(harness.command, undefined, home, false);
  if (!servers.length) return NONE;
  try {
    const directory = await mkdtemp(join(tmpdir(), 'clikcode-mcp-'));
    const file = join(directory, 'mcp.json');
    await writeFile(file, `${JSON.stringify(ampMcpConfig(servers))}\n`, { encoding: 'utf8', mode: 0o600 });
    return { argv: [...flag, file], dispose: () => rm(directory, { recursive: true, force: true }).catch(() => undefined) };
  } catch {
    // MCP must never be the reason a turn did not run.
    return NONE;
  }
}
