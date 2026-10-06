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
import { listSharedMcpServers, removeSharedMcpServer, type ProvisionedCopy } from '../harness/provision.js';
import { readState } from '../session/state/read.js';
import type { AiHarnessAccount } from '../harness/definition.js';

/** `claude` or `claude (work)`: the harness, and the account profile when it is one. */
function copyLabel(copy: ProvisionedCopy, accounts: readonly AiHarnessAccount[]): string {
  const account = copy.accountId ? accounts.find((item) => item.id === copy.accountId) : undefined;
  return account ? `${copy.harness} (${account.label})` : copy.harness;
}

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

/** ClikCode's servers, and which harnesses ClikCode has given each. */
export async function mcpList(): Promise<void> {
  const { servers, problem } = await listSharedMcpServers();
  const { accounts } = await readState({ transcripts: [] });
  if (isJsonDefaultMode()) {
    return emitResult({
      mcp: 'list',
      servers: servers.map(({ copies, headers: _headers, env: _env, ...server }) => ({ ...server, copies: copies.map((copy) => copyLabel(copy, accounts)) })),
      ...(problem ? { problem } : {}),
    });
  }
  output.write(`\n${chalk.bold('MCP servers recorded in ClikCode')}\n`);
  for (const server of servers) {
    output.write(`  ${chalk.bold(server.name.padEnd(24))}${chalk.dim([server.target, ...server.args ?? []].join(' '))}\n`);
    if (server.copies.length) output.write(`  ${''.padEnd(24)}${chalk.dim(`given to ${server.copies.map((copy) => copyLabel(copy, accounts)).join(', ')}`)}\n`);
  }
  if (!servers.length) output.write(`  ${chalk.dim('none -- add one with `mcp add <name> <command-or-url>`')}\n`);
  if (problem) output.write(`  ${chalk.yellow(problem)}\n`);
  output.write('\n');
}

/** Forget a server: out of ClikCode's mcp.json, and ClikCode's own copies
 * out of every vendor it gave them to. A copy the user put there stays. */
export async function mcpRemove(name: string): Promise<void> {
  const { accounts } = await readState({ transcripts: [] });
  const result = await removeSharedMcpServer(name, { accounts });
  const found = result.unrecorded || result.takenBack.length > 0 || result.failed.length > 0;
  if (isJsonDefaultMode()) {
    emitResult({
      mcp: 'remove', name, removed: result.unrecorded,
      takenBack: result.takenBack.map((copy) => copyLabel(copy, accounts)),
      failed: result.failed.map((copy) => ({ harness: copyLabel(copy, accounts), ...(copy.detail ? { detail: copy.detail } : {}) })),
    });
  } else {
    if (!found) output.write(`\n${chalk.dim(`${name} is not recorded in ClikCode.`)}\n\n`);
    else {
      output.write(`\n${chalk.green('✓')} ${chalk.bold(name)} ${result.unrecorded ? 'removed from ClikCode' : 'was not in ClikCode\'s list'}.\n`);
      if (result.takenBack.length) output.write(`  ${chalk.dim(`Taken back out of ${result.takenBack.map((copy) => copyLabel(copy, accounts)).join(', ')}.`)}\n`);
      for (const copy of result.failed) output.write(`  ${chalk.yellow(`Still in ${copyLabel(copy, accounts)}${copy.detail ? `: ${copy.detail}` : ''}`)}\n`);
      output.write('\n');
    }
  }
  if (!found || result.failed.length) process.exitCode = 1;
}
