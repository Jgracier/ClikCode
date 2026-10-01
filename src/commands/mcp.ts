/**
 * `clikcode mcp` -- one MCP server, recorded once.
 *
 * The server is written to ClikCode's mcp.json, which ClikCode's own agent
 * reads. A vendor harness receives it the first time that provider is chosen,
 * and only when that harness does not already have the name.
 */
import chalk from 'chalk';
import { stdout as output } from 'node:process';
import { isJsonDefaultMode } from '../cli/output-mode.js';
import { emitResult } from '../cli/structured-output.js';
import {
  harnessesAcceptingMcp, mcpAddArgv, mcpAddGrammar, recordSharedMcpServer,
  type McpServerEntry,
} from '../harness/mcp-registry.js';

export async function mcpAdd(name: string, target: string, args: readonly string[]): Promise<void> {
  const entry: McpServerEntry = { name, target, ...(args.length ? { args } : {}) };
  await recordSharedMcpServer(entry);
  if (isJsonDefaultMode()) return emitResult({ mcp: 'add', server: entry, recorded: 'clikcode' });
  output.write(`\n${chalk.green('✓')} ${chalk.bold(name)} recorded. A harness gets it the first time you choose that provider, if it is not already there.\n\n`);
}

/** Which harnesses this would reach, and how each spells the request. Shown
 * before anything is written, so a fan-out is never a surprise. */
export async function mcpTargets(): Promise<void> {
  const harnesses = await harnessesAcceptingMcp();
  const rows = harnesses.map((harness) => ({
    harness: harness.command,
    argv: (mcpAddArgv(mcpAddGrammar(harness), { name: '<name>', target: '<command-or-url>' }) ?? []).join(' '),
  }));
  if (isJsonDefaultMode()) return emitResult({ mcp: 'targets', harnesses: rows });
  output.write(`\n${chalk.bold('Harnesses that would receive an MCP server')}\n`);
  for (const row of rows) output.write(`  ${row.harness.padEnd(12)}${chalk.dim(row.argv)}\n`);
  if (!rows.length) output.write(`  ${chalk.dim('none installed')}\n`);
  output.write('\n');
}
