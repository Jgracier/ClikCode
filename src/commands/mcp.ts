/**
 * `clikcode mcp` -- MCP servers recorded for ClikCode's own agent.
 *
 * A server is written to ClikCode's mcp.json, which ClikCode's own agent
 * reads. A vendor harness keeps its own MCP configuration; ClikCode never
 * writes into it.
 */
import { BUILT_IN_MCP_NAME } from '../harness/transport/acp-mcp-servers.js';
import chalk from 'chalk';
import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { isJsonDefaultMode } from '../cli/output-mode.js';
import { emitResult } from '../cli/structured-output.js';
import { isRemoteTarget, recordSharedMcpServer, removeMcpConfigEntry, type McpServerEntry } from '../harness/mcp-registry.js';
import { loadMcpServers, MCP_SERVERS_KEY, mcpConfigFilePath, writeMcpOAuthConfig, type McpOAuthConfig, type McpServerSpec } from '../agent/mcp/config.js';
import { forgetMcpOAuth, mcpOAuthState, signInMcpServer, type McpSignInUi } from '../agent/mcp/oauth.js';
import { mcpServerNeedsSignIn } from '../harness/mcp-sign-in.js';
import { userMcpServers } from '../agent/mcp/manager.js';
import { stateDirectory } from '../session/store/paths.js';
import { hasLocalDisplay, loginUrlNotice, openLoginUrl } from '../gateway/login/url.js';
import type { SignInScreen } from '../gateway/login/vendor-sign-in.js';

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
    : `\n${chalk.green('✓')} ${chalk.bold(name)} recorded for ClikCode's own agent.\n\n`);
}

type McpServerSignIn = 'signed-in' | 'needs-sign-in' | 'open' | 'unknown';

/** Whether each remote server is signed in, needs a sign-in, or asks none:
 * ClikCode's own record first, else the server's answer to an
 * unauthenticated request (cached a day, harness/mcp-sign-in.ts). */
async function mcpSignInStates(stateDir: string, specs: readonly McpServerSpec[]): Promise<Map<string, McpServerSignIn>> {
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
  const { servers } = await userMcpServers(stateDir);
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
  const { servers, problem } = await userMcpServers(stateDir);
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

/** The servers recorded for ClikCode's own agent. */
export async function mcpList(): Promise<void> {
  const stateDir = stateDirectory();
  const { servers, problem } = await loadMcpServers(stateDir);
  const states = await mcpSignInStates(stateDir, servers);
  if (isJsonDefaultMode()) {
    return emitResult({
      mcp: 'list',
      builtIn: [{ name: BUILT_IN_MCP_NAME, target: 'clikcode', args: ['mcp-serve'], tools: ['computer_web', 'computer_desktop', 'store_secret', 'list_secrets', 'delete_secret'] }],
      servers: servers.map((spec) => ({
        name: spec.name,
        ...(spec.transport === 'stdio' ? { target: spec.command, args: spec.args } : { target: spec.url }),
        ...(states.has(spec.name) ? { signIn: states.get(spec.name) } : {}),
      })),
      ...(problem ? { problem } : {}),
    });
  }
  output.write(`\n${chalk.bold('Built in, given to every harness session')} ${chalk.dim('(turn off with `clikcode computer off`)')}\n`);
  output.write(`  ${chalk.bold(BUILT_IN_MCP_NAME.padEnd(24))}${chalk.dim('clikcode mcp-serve: computer_web, computer_desktop, store_secret, list_secrets, delete_secret')}\n`);
  output.write(`\n${chalk.bold("MCP servers recorded for ClikCode's own agent")}\n`);
  for (const spec of servers) {
    const state = states.get(spec.name);
    const label = state ? SIGN_IN_LABEL[state] : '';
    const where = spec.transport === 'stdio' ? [spec.command, ...spec.args].join(' ') : spec.url;
    output.write(`  ${chalk.bold(spec.name.padEnd(24))}${chalk.dim(where)}${label ? `  ${label}` : ''}\n`);
    if (state === 'needs-sign-in') output.write(`  ${''.padEnd(24)}${chalk.dim(`sign in: clikcode mcp login ${spec.name}`)}\n`);
  }
  if (!servers.length) output.write(`  ${chalk.dim('none -- add one with `mcp add <name> <command-or-url>`')}\n`);
  if (problem) output.write(`  ${chalk.yellow(problem)}\n`);
  output.write('\n');
}

/** Forget a server: out of ClikCode's mcp.json, with its tokens and client
 * registration. A harness's own servers are never touched. */
export async function mcpRemove(name: string): Promise<void> {
  const stateDir = stateDirectory();
  const removed = await removeMcpConfigEntry(mcpConfigFilePath(stateDir), MCP_SERVERS_KEY, name);
  const forgotten = await forgetMcpOAuth(stateDir, name).catch(() => false);
  if (isJsonDefaultMode()) emitResult({ mcp: 'remove', name, removed });
  else if (!removed && !forgotten) output.write(`\n${chalk.dim(`${name} is not recorded in ClikCode.`)}\n\n`);
  else output.write(`\n${chalk.green('✓')} ${chalk.bold(name)} ${removed ? 'removed from ClikCode' : 'was not in ClikCode\'s list'}.\n\n`);
  if (!removed && !forgotten) process.exitCode = 1;
}
