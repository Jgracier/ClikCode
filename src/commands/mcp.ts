/**
 * `clikcode mcp` -- one MCP server, recorded once.
 *
 * The server is written to ClikCode's mcp.json, which ClikCode's own agent
 * reads. A vendor harness receives it the first time that provider is chosen,
 * and only when that harness does not already have the name.
 */
import chalk from 'chalk';
import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { isJsonDefaultMode } from '../cli/output-mode.js';
import { emitResult } from '../cli/structured-output.js';
import {
  harnessesAcceptingMcp, isRemoteTarget, mcpAddArgv, mcpAddGrammar, recordSharedMcpServer,
  type McpServerEntry,
} from '../harness/mcp-registry.js';
import { listSharedMcpServers, removeSharedMcpServer, type ProvisionedCopy } from '../harness/provision.js';
import { readState } from '../session/state/read.js';
import type { AiHarnessAccount } from '../harness/definition.js';
import { loadMcpServers, writeMcpOAuthConfig, type McpOAuthConfig, type McpServerSpec } from '../agent/mcp/config.js';
import { forgetMcpOAuth, mcpOAuthState, signInMcpServer, type McpSignInUi } from '../agent/mcp/oauth.js';
import { mcpServerNeedsSignIn } from '../harness/mcp-sign-in.js';
import { stateDirectory } from '../session/store/paths.js';
import { hasLocalDisplay, loginUrlNotice, openLoginUrl } from '../gateway/login/url.js';
import type { SignInScreen } from '../gateway/login/vendor-sign-in.js';

/** `claude` or `claude (work)`: the harness, and the account profile when it is one. */
function copyLabel(copy: ProvisionedCopy, accounts: readonly AiHarnessAccount[]): string {
  const account = copy.accountId ? accounts.find((item) => item.id === copy.accountId) : undefined;
  return account ? `${copy.harness} (${account.label})` : copy.harness;
}

export interface McpAddOptions { clientId?: string; callbackPort?: string; scope?: string }

export async function mcpAdd(name: string, target: string, args: readonly string[], options: McpAddOptions = {}): Promise<void> {
  const entry: McpServerEntry = { name, target, ...(args.length ? { args } : {}) };
  const port = options.callbackPort === undefined ? undefined : Number(options.callbackPort);
  if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536)) throw new Error(`--callback-port must be a port number, not ${options.callbackPort}`);
  const oauth: McpOAuthConfig = {
    ...(options.clientId?.trim() ? { clientId: options.clientId.trim() } : {}),
    ...(port !== undefined ? { callbackPort: port } : {}),
    ...(options.scope?.trim() ? { scope: options.scope.trim() } : {}),
  };
  const signsIn = Object.keys(oauth).length > 0;
  if (signsIn && !isRemoteTarget(target)) throw new Error('--client-id, --callback-port and --scope apply to a remote (URL) server only');
  await recordSharedMcpServer(entry);
  if (signsIn) await writeMcpOAuthConfig(stateDirectory(), name, oauth);
  if (isJsonDefaultMode()) return emitResult({ mcp: 'add', server: { ...entry, ...(signsIn ? { oauth } : {}) }, recorded: 'clikcode' });
  output.write(signsIn
    ? `\n${chalk.green('✓')} ${chalk.bold(name)} recorded for ClikCode's own agent. Sign in with ${chalk.bold(`clikcode mcp login ${name}`)}.\n\n`
    : `\n${chalk.green('✓')} ${chalk.bold(name)} recorded. A harness gets it the first time you choose that provider, if it is not already there.\n\n`);
}

export type McpServerSignIn = 'signed-in' | 'needs-sign-in' | 'open' | 'unknown';

/** Whether each remote server is signed in, needs a sign-in, or asks none:
 * ClikCode's own record first, else the server's answer to an
 * unauthenticated request (cached a day, harness/mcp-sign-in.ts). */
export async function mcpSignInStates(stateDir: string, specs: readonly McpServerSpec[]): Promise<Map<string, McpServerSignIn>> {
  return new Map(await Promise.all(specs.flatMap((spec) => (spec.transport === 'stdio' ? [] : [(async () => {
    const own = await mcpOAuthState(stateDir, spec);
    if (own !== 'none') return [spec.name, own] as const;
    const answer = await mcpServerNeedsSignIn({ name: spec.name, target: spec.url, headers: spec.headers }, { stateDir });
    return [spec.name, answer === 'sign-in' ? 'needs-sign-in' : answer] as const;
  })()]))));
}

const SIGN_IN_LABEL: Record<McpServerSignIn, string> = {
  'signed-in': chalk.green('signed in'),
  'needs-sign-in': chalk.yellow('needs sign-in'),
  open: '',
  unknown: chalk.dim('not reachable'),
};

/** A sign-in shown on ClikCode's own screen (the conversation's sign-in
 * band, the VS Code panel): its link, and the composer taking a pasted
 * address beside it. */
export function mcpSignInUiFor(screen: SignInScreen): McpSignInUi {
  return { show: (link) => screen.show(link), ask: (prompt) => screen.ask(prompt, false, false, true), signal: screen.signal };
}

/** From a shell: the link opened where a browser is local and printed (and
 * copied) either way, and a line read for the pasted address. Ctrl+C cancels. */
function terminalSignInUi(name: string): McpSignInUi & { done(): void } {
  const cancel = new AbortController();
  let opened = false;
  const onSigint = (): void => cancel.abort();
  process.once('SIGINT', onSigint);
  return {
    signal: cancel.signal,
    show: (link) => {
      const local = hasLocalDisplay();
      if (local && !opened) { opened = true; openLoginUrl(link.url); }
      output.write(`${local ? '' : loginUrlNotice(link.url).clipboard}\n${chalk.bold(`Sign in to ${name}`)}\n${link.url}\n${chalk.dim(local ? 'opened in your browser' : 'link copied: open it on this device')}\n`);
    },
    ask: async (prompt, signal) => {
      const reader = createInterface({ input, output });
      reader.on('SIGINT', () => cancel.abort());
      try { return await reader.question(`${prompt}: `, { signal }); } finally { reader.close(); }
    },
    done: () => { process.off('SIGINT', onSigint); },
  };
}

/** The one sign-in, wherever it was asked for. */
export async function loginMcpServer(name: string, ui: McpSignInUi, stateDir: string = stateDirectory()): Promise<void> {
  const { servers } = await loadMcpServers(stateDir);
  const spec = servers.find((server) => server.name === name);
  if (!spec) throw new Error(`${name} is not recorded in ClikCode; add it with \`clikcode mcp add ${name} <url>\``);
  if (spec.transport === 'stdio') throw new Error(`${name} is a local server; there is nothing to sign in to`);
  await signInMcpServer({ stateDir, spec, ui });
}

/** `clikcode mcp login <name>`: only ever run because the user asked. */
export async function mcpLogin(name: string): Promise<void> {
  const ui = terminalSignInUi(name);
  try {
    await loginMcpServer(name, ui);
  } finally { ui.done(); }
  if (isJsonDefaultMode()) return emitResult({ mcp: 'login', name, signedIn: true });
  output.write(`\n${chalk.green('✓')} Signed in to ${chalk.bold(name)}. ClikCode's agent uses it from its next turn.\n\n`);
}

/** `clikcode mcp logout <name>`: ClikCode's tokens for it are forgotten. */
export async function mcpLogout(name: string): Promise<void> {
  const forgotten = await forgetMcpOAuth(stateDirectory(), name);
  if (isJsonDefaultMode()) return emitResult({ mcp: 'logout', name, signedOut: forgotten });
  output.write(forgotten
    ? `\n${chalk.green('✓')} Signed out of ${chalk.bold(name)}.\n\n`
    : `\n${chalk.dim(`ClikCode holds no sign-in for ${name}.`)}\n\n`);
}

/** `/mcp` in a conversation on ClikCode's own agent: each server, and which
 * need a sign-in. */
export async function mcpServersText(stateDir: string = stateDirectory()): Promise<string> {
  const { servers, problem } = await loadMcpServers(stateDir);
  const states = await mcpSignInStates(stateDir, servers);
  const lines = servers.map((spec) => {
    const state = states.get(spec.name);
    const where = spec.transport === 'stdio' ? [spec.command, ...spec.args].join(' ') : spec.url;
    const label = state ? SIGN_IN_LABEL[state] : '';
    return `${chalk.bold(spec.name.padEnd(24))}${chalk.dim(where)}${label ? `  ${label}` : ''}`;
  });
  if (!servers.length) lines.push(chalk.dim('none -- add one with `clikcode mcp add <name> <command-or-url>`'));
  if (problem) lines.push(chalk.yellow(problem));
  if ([...states.values()].includes('needs-sign-in')) lines.push('', chalk.dim('Sign in with /mcp login <name> (or clikcode mcp login <name>); /mcp logout <name> signs out.'));
  return lines.join('\n');
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
  const stateDir = stateDirectory();
  const states = await mcpSignInStates(stateDir, (await loadMcpServers(stateDir)).servers);
  if (isJsonDefaultMode()) {
    return emitResult({
      mcp: 'list',
      servers: servers.map(({ copies, headers: _headers, env: _env, ...server }) => ({
        ...server, copies: copies.map((copy) => copyLabel(copy, accounts)),
        ...(states.has(server.name) ? { signIn: states.get(server.name) } : {}),
      })),
      ...(problem ? { problem } : {}),
    });
  }
  output.write(`\n${chalk.bold('MCP servers recorded in ClikCode')}\n`);
  for (const server of servers) {
    const state = states.get(server.name);
    const label = state ? SIGN_IN_LABEL[state] : '';
    output.write(`  ${chalk.bold(server.name.padEnd(24))}${chalk.dim([server.target, ...server.args ?? []].join(' '))}${label ? `  ${label}` : ''}\n`);
    if (state === 'needs-sign-in') output.write(`  ${''.padEnd(24)}${chalk.dim(`sign in: clikcode mcp login ${server.name}`)}\n`);
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
  // Its tokens and client registration go with it.
  await forgetMcpOAuth(stateDirectory(), name).catch(() => false);
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
