/**
 * `clikcode mcp` -- one MCP server, added once, installed everywhere.
 *
 * Adding a server by hand means repeating it for every harness that has MCP,
 * and again for every isolated account profile. This does that fan-out and
 * reports what happened per harness, because a partial result is the normal
 * case: one vendor may reject a name another accepted.
 */
import chalk from 'chalk';
import { stdout as output } from 'node:process';
import { readState } from '../session/state.js';
import { isJsonDefaultMode } from '../cli/output-mode.js';
import { emitJson } from '../cli/structured-output.js';
import {
  harnessesAcceptingMcp, installMcpServerEverywhere, mcpAddArgv, mcpAddGrammar,
  type McpServerEntry,
} from '../harness/mcp-registry.js';

export async function mcpAdd(name: string, target: string, args: readonly string[]): Promise<void> {
  const entry: McpServerEntry = { name, target, ...(args.length ? { args } : {}) };
  const state = await readState();
  const results = await installMcpServerEverywhere(entry, state.accounts);
  const installed = results.filter((result) => result.ok);
  if (isJsonDefaultMode()) return emitJson({ mcp: 'add', server: entry, results });
  if (!results.length) {
    output.write(`\n${chalk.yellow('No installed harness records an "mcp add" command.')}\n\n`);
    return;
  }
  output.write(`\n${chalk.green('✓')} ${chalk.bold(name)} added to ${installed.length} of ${results.length}\n`);
  for (const result of results) {
    const where = result.account ? `${result.harness} ${chalk.dim(`(${result.account})`)}` : result.harness;
    output.write(result.ok
      ? `  ${chalk.green('✓')} ${where}\n`
      : `  ${chalk.red('✗')} ${where} ${chalk.dim(result.detail ?? '')}\n`);
  }
  output.write('\n');
}

/** Which harnesses this would reach, and how each spells the request. Shown
 * before anything is written, so a fan-out is never a surprise. */
export async function mcpTargets(): Promise<void> {
  const harnesses = await harnessesAcceptingMcp();
  const rows = harnesses.map((harness) => ({
    harness: harness.command,
    argv: (mcpAddArgv(mcpAddGrammar(harness), { name: '<name>', target: '<command-or-url>' }) ?? []).join(' '),
  }));
  if (isJsonDefaultMode()) return emitJson({ mcp: 'targets', harnesses: rows });
  output.write(`\n${chalk.bold('Harnesses that would receive an MCP server')}\n`);
  for (const row of rows) output.write(`  ${row.harness.padEnd(12)}${chalk.dim(row.argv)}\n`);
  if (!rows.length) output.write(`  ${chalk.dim('none installed')}\n`);
  output.write('\n');
}
