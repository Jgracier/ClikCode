/** `clikcode agent run`: one headless agent turn on the user's own subscription (Claude Code or Codex, the chat route of agentRoute),
 * with only the MCP tools it is given: ClikCode's computer tools in one tab (computer-mcp.ts) and any MCP servers the caller adds. No
 * built-in tools, no session kept. It runs until it ends, until it stalls (no tool call for `stallMs` and none in flight), or until the
 * ceiling `maxMs`; an agent that keeps working is never cut off early. A vendor that refuses the account for usage before any tool call
 * is stored as that account's refusal (as a chat turn stores it) and the run moves to the next account, each tried once. */
import { lifecycle, quiet } from '../../runtime/lifecycle-log.js';
import { scrubSecrets } from '../computer/secret-scrubber.js';
import { ACTIVITY_ENV, MAX_CALLS_ENV, readActivity } from './activity.js';
import { agentRoute } from './route.js';
import type { ChildProcess } from 'node:child_process';
import { killOnExit, stopTree } from '../computer/run-cli.js';

export interface McpServerEntry { command: string; args?: string[]; env?: Record<string, string> }
export interface HeadlessAgentOptions {
  prompt: string;
  /** ClikCode's computer tools in this tab; absent: no computer tools. */ computer?: { tab: string; egress?: string; blockUrls?: string[]; blockMessage?: string };
  /** Other MCP servers, by name; all their tools are allowed. */ servers?: Record<string, McpServerEntry>;
  maxCalls: number; maxMs: number; stallMs: number;
  /** Bind the route to this chat (else the most recent chat on Claude Code or Codex). */ sessionId?: string;
  /** Overrides the agentModel setting under Claude Code. */ model?: string;
  /** Stops the run (Ctrl-C): the agent and its tool servers are stopped as on a timeout, the temporary directory removed. */ signal?: AbortSignal;
  stateDir: string;
}
export interface HeadlessAgentResult {
  text: string; calls: number; timedOut: boolean; stalled?: boolean; error?: string;
  harness?: string; account?: string; model?: string; movedFrom?: string;
}

/** The ClikCode program a spawned MCP server runs (this same installed build). */
const clikcodeEntry = (): string => process.argv[1]!;

export async function runHeadlessAgent(options: HeadlessAgentOptions): Promise<HeadlessAgentResult> {
  const [{ mkdtemp, writeFile, readFile, rm }, { tmpdir }, { join }, { spawn }] = await Promise.all([import('node:fs/promises'), import('node:os'), import('node:path'), import('node:child_process')]);
  const { readState } = await import('../../session/state/read.js');
  const { computerTunable } = await import('../computer/settings.js');
  const { subscriptionCliEnvironment } = await import('../../harness/transport/profile-environment.js');
  const { classifyAccountFailure } = await import('../../turn/failover.js');
  const { storeQuotaRefusal } = await import('../../turn/account-outcome.js');
  const claudeModel = options.model ?? await computerTunable(options.stateDir, 'agentModel');
  const attempted = new Map<string, number>();
  for (;;) {
    const preferred = process.env.CLIKCODE_AGENT_PREFERRED_HARNESS;
    const preferredHarness = preferred === 'claude' || preferred === 'codex' ? preferred : undefined;
    const route = agentRoute(await readState({ transcripts: [] }), { sessionId: options.sessionId, attempted, claudeModel, ...(preferredHarness ? { preferredHarness } : {}) });
    if ('error' in route) return { text: '', calls: 0, timedOut: false, error: route.error };
    const { account, model } = route;
    attempted.set(account.id, Date.now());
    lifecycle('headless.agent.route', { harness: route.harness, accountId: account.id, model, session: options.sessionId, ...(route.movedFrom ? { movedFrom: route.movedFrom } : {}) });
    const useCodex = route.harness === 'codex';
    const dir = await mkdtemp(join(tmpdir(), 'clikcode-agent-'));
    const activity = join(dir, 'activity');
    await writeFile(activity, '');
    try {
      const shared = { [ACTIVITY_ENV]: activity, [MAX_CALLS_ENV]: String(options.maxCalls) };
      const servers: Record<string, McpServerEntry> = {};
      if (options.computer) {
        const c = options.computer;
        servers.clikcode = { command: process.execPath, args: [clikcodeEntry(), 'computer', 'mcp', '--tab', c.tab, '--max-calls', String(options.maxCalls), ...(c.egress ? ['--egress', c.egress] : []), ...(c.blockUrls ?? []).flatMap(p => ['--block-url', p]), ...(c.blockMessage ? ['--block-message', c.blockMessage] : [])], env: shared };
      }
      for (const [name, entry] of Object.entries(options.servers ?? {})) {
        if (name === 'clikcode' && options.computer) throw new Error('The MCP server name "clikcode" is ClikCode\'s own computer tools.');
        servers[name] = { ...entry, env: { ...(entry.env ?? {}), ...shared } };
      }
      const config = join(dir, 'mcp.json');
      // The servers' environments (API keys a caller's MCP server needs) stay in files only this user can read, never on argv.
      await writeFile(config, JSON.stringify({ mcpServers: servers }), { mode: 0o600 });
      const final = join(dir, 'final.txt');
      let launch = servers;
      if (useCodex) {
        await writeFile(join(dir, ENV_LAUNCHER), ENV_LAUNCHER_SOURCE, { mode: 0o600 });
        launch = {};
        for (const [name, entry] of Object.entries(servers)) {
          const envFile = join(dir, `env-${name.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
          await writeFile(envFile, JSON.stringify(entry.env ?? {}), { mode: 0o600 });
          launch[name] = { command: process.execPath, args: [join(dir, ENV_LAUNCHER), envFile, entry.command, ...(entry.args ?? [])] };
        }
      }
      const args = agentArgs({ useCodex, ...(model ? { model } : {}), servers: launch, dir, config, final, prompt: options.prompt });
      // A signed-in native account, never a key, token, gateway URL or cloud switch inherited from the parent.
      const env = subscriptionCliEnvironment(account.nativeProfile!);
      if (options.signal?.aborted) return { text: '', calls: 0, timedOut: false, error: 'The agent run was stopped.' };
      const child = spawn(useCodex ? 'codex' : 'claude', args, { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
      let text = '', diagnostics = '';
      child.stdout!.on('data', c => { text = (text + String(c)).slice(-20_000); });
      child.stderr!.on('data', c => { diagnostics = (diagnostics + String(c)).slice(-4_000); });
      const { code, timedOut, stalled, stopped } = await superviseAgent(child, { activity, maxMs: options.maxMs, stallMs: options.stallMs, ...(options.signal ? { signal: options.signal } : {}) });
      if (stopped) return { text: scrubSecrets(text), calls: (await readActivity(activity)).started, timedOut: false, error: 'The agent run was stopped.', harness: route.harness, account: account.label };
      if (useCodex) text = await readFile(final, 'utf8').catch(() => '');
      const calls = (await readActivity(activity)).started;
      if (code !== 0 && !timedOut && calls === 0) {
        // With no tool call made, what the vendor printed is its own refusal, not the agent's prose.
        const said = `${diagnostics}\n${text}`;
        if (classifyAccountFailure(new Error(said), { stderrText: said }) === 'quota-exhausted') {
          await storeQuotaRefusal(account.id, new Error(said)).catch(quiet('agent/headless/run'));
          lifecycle('headless.agent.usage-refused', { harness: route.harness, accountId: account.id });
          continue;
        }
      }
      return {
        text: scrubSecrets(text), calls, timedOut, ...(stalled ? { stalled } : {}),
        ...(code !== 0 && !timedOut ? { error: `the agent could not run: ${useCodex ? 'Codex' : 'Claude Code'} (${account.label}) exited ${code}` } : {}),
        harness: route.harness, account: account.label, ...(model ? { model } : {}), ...(route.movedFrom ? { movedFrom: route.movedFrom } : {}),
      };
    } finally { await rm(dir, { recursive: true, force: true }).catch(quiet('agent/headless/run')); }
  }
}

/** The vendor CLI's command line. Under Claude Code the servers come from the config file; under Codex each server is named in
 * -c overrides with its command and args only (its environment is in a file the launcher reads, ENV_LAUNCHER). With no MCP
 * server at all there are no tools to allow, and no --allowedTools (an empty list would swallow the next flag). */
export function agentArgs(input: { useCodex: boolean; model?: string; servers: Record<string, McpServerEntry>; dir: string; config: string; final: string; prompt: string }): string[] {
  const { useCodex, model, servers, dir, config, final, prompt } = input;
  const names = Object.keys(servers);
  if (useCodex) {
    return ['exec', ...(model ? ['-m', model] : []), '--ephemeral', '--ignore-user-config', '--skip-git-repo-check', '-C', dir, '-s', 'read-only',
      '-c', 'approval_policy="never"', '-c', 'features.shell_tool=false', '-c', 'web_search="disabled"',
      ...names.flatMap(name => ['-c', `mcp_servers.${name}.command=${JSON.stringify(servers[name]!.command)}`, '-c', `mcp_servers.${name}.args=${JSON.stringify(servers[name]!.args ?? [])}`,
        '-c', `mcp_servers.${name}.required=true`, '-c', `mcp_servers.${name}.default_tools_approval_mode="approve"`]),
      '-o', final, prompt];
  }
  return ['-p', prompt, ...(model ? ['--model', model] : []), '--output-format', 'text', '--mcp-config', config, '--strict-mcp-config', '--tools', '',
    ...(names.length ? ['--allowedTools', ...names.map(name => `mcp__${name}`)] : []), '--permission-mode', 'dontAsk', '--no-session-persistence'];
}

/** A Codex MCP server is started through this: it reads the server's environment from a 0600 file and runs the server with it,
 * passing stdio through and forwarding stop signals, so no secret appears in any process's argv. */
export const ENV_LAUNCHER = 'mcp-env-launcher.cjs';
export const ENV_LAUNCHER_SOURCE = `'use strict';
const { spawn } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { constants } = require('node:os');
const [file, command, ...args] = process.argv.slice(2);
const child = spawn(command, args, { stdio: 'inherit', env: { ...process.env, ...JSON.parse(readFileSync(file, 'utf8')) } });
for (const name of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(name, () => { try { child.kill(name); } catch {} });
child.on('error', error => { process.stderr.write(String(error) + '\\n'); process.exit(127); });
child.on('exit', (code, signal) => process.exit(code ?? 128 + (constants.signals[signal] || 1)));
`;

/** How long a stopped agent and its tool servers get between SIGTERM and SIGKILL: enough for `clikcode computer mcp` to close its tab. */
export const AGENT_STOP_GRACE_MS = 10_000;

/** Watches a running agent until it exits: the ceiling `maxMs`, the stall rule (no tool call for `stallMs` and none in flight), and
 * the caller's `signal` (Ctrl-C) each stop it by SIGTERM to its whole process group -- the vendor CLI and the MCP servers it started
 * -- then SIGKILL after `graceMs`. Once it exits, whatever is left in its group gets the same treatment, and ClikCode exiting kills
 * it. Never answers before the agent's own process has exited. */
export async function superviseAgent(child: ChildProcess, options: { activity: string; maxMs: number; stallMs: number; signal?: AbortSignal; graceMs?: number; pollMs?: number }): Promise<{ code: number | null; timedOut: boolean; stalled: boolean; stopped: boolean }> {
  const grace = options.graceMs ?? AGENT_STOP_GRACE_MS;
  const untrack = killOnExit(child);
  let timedOut = false, stalled = false, stopped = false;
  const stop = (): void => stopTree(child, grace);
  const timer = setTimeout(() => { timedOut = true; stop(); }, options.maxMs);
  const onAbort = (): void => { stopped = true; stop(); };
  if (options.signal?.aborted) onAbort(); else options.signal?.addEventListener('abort', onAbort, { once: true });
  // Working is a tool call now and then, or one in flight: each moves the stall deadline. Only an agent that stopped calling is cut off.
  let seen = 0, lastCall = Date.now();
  const watch = setInterval(() => {
    void readActivity(options.activity).then(now => {
      if (now.started + now.finished > seen || now.inFlight) { seen = now.started + now.finished; lastCall = Date.now(); }
      else if (Date.now() - lastCall > options.stallMs && !timedOut && !stopped) { timedOut = true; stalled = true; stop(); }
    });
  }, options.pollMs ?? 5_000);
  try {
    const code = await new Promise<number | null>(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve(child.exitCode); return; }
      child.once('exit', resolve);
      child.once('error', () => resolve(-1));
    });
    // Tool servers the agent left behind get their stop signal and grace too (they close their tabs on SIGTERM).
    if (process.platform !== 'win32' && child.pid !== undefined) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* fail-open-ok: nothing left in the group */ }
      const pid = child.pid;
      setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* fail-open-ok: the group ended on SIGTERM */ } }, grace).unref();
    }
    // Output still in the pipe is read, but a leftover holding it open cannot keep the answer back.
    await new Promise<void>(resolve => { const t = setTimeout(resolve, 1_000); child.once('close', () => { clearTimeout(t); resolve(); }); if (child.stdout?.closed !== false && child.stderr?.closed !== false) { clearTimeout(t); resolve(); } });
    return { code, timedOut, stalled, stopped };
  } finally {
    clearTimeout(timer); clearInterval(watch);
    options.signal?.removeEventListener('abort', onAbort);
    untrack();
  }
}
