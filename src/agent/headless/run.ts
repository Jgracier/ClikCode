/** `clikcode agent run`: one headless agent turn on the user's own subscription (Claude Code or Codex, the chat route of agentRoute),
 * with only the MCP tools it is given: ClikCode's computer tools in one tab (computer-mcp.ts) and any MCP servers the caller adds. No
 * built-in tools, no session kept. It runs until it ends, until it stalls (no tool call for `stallMs` and none in flight), or until the
 * ceiling `maxMs`; an agent that keeps working is never cut off early. A vendor that refuses the account for usage before any tool call
 * is stored as that account's refusal (as a chat turn stores it) and the run moves to the next account, each tried once. */
import { lifecycle, quiet } from '../../runtime/lifecycle-log.js';
import { scrubSecrets } from '../computer/secret-scrubber.js';
import { ACTIVITY_ENV, MAX_CALLS_ENV, readActivity } from './activity.js';
import { agentRoute } from './route.js';

export interface McpServerEntry { command: string; args?: string[]; env?: Record<string, string> }
export interface HeadlessAgentOptions {
  prompt: string;
  /** ClikCode's computer tools in this tab; absent: no computer tools. */ computer?: { tab: string; egress?: string; blockUrls?: string[]; blockMessage?: string };
  /** Other MCP servers, by name; all their tools are allowed. */ servers?: Record<string, McpServerEntry>;
  maxCalls: number; maxMs: number; stallMs: number;
  /** Bind the route to this chat (else the most recent chat on Claude Code or Codex). */ sessionId?: string;
  /** Overrides the agentModel setting under Claude Code. */ model?: string;
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
    const route = agentRoute(await readState({ transcripts: [] }), { sessionId: options.sessionId, attempted, claudeModel });
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
      const names = Object.keys(servers);
      const config = join(dir, 'mcp.json');
      await writeFile(config, JSON.stringify({ mcpServers: servers }));
      const final = join(dir, 'final.txt');
      const args = useCodex
        ? ['exec', ...(model ? ['-m', model] : []), '--ephemeral', '--ignore-user-config', '--skip-git-repo-check', '-C', dir, '-s', 'read-only',
          '-c', 'approval_policy="never"', '-c', 'features.shell_tool=false', '-c', 'web_search="disabled"',
          ...names.flatMap(name => ['-c', `mcp_servers.${name}.command=${JSON.stringify(servers[name]!.command)}`, '-c', `mcp_servers.${name}.args=${JSON.stringify(servers[name]!.args ?? [])}`,
            '-c', `mcp_servers.${name}.env=${tomlInline(servers[name]!.env ?? {})}`, '-c', `mcp_servers.${name}.required=true`, '-c', `mcp_servers.${name}.default_tools_approval_mode="approve"`]),
          '-o', final, options.prompt]
        : ['-p', options.prompt, ...(model ? ['--model', model] : []), '--output-format', 'text', '--mcp-config', config, '--strict-mcp-config', '--tools', '', '--allowedTools', ...names.map(name => `mcp__${name}`), '--permission-mode', 'dontAsk', '--no-session-persistence'];
      // A signed-in native account, never a key, token, gateway URL or cloud switch inherited from the parent.
      const env = subscriptionCliEnvironment(account.nativeProfile!);
      const child = spawn(useCodex ? 'codex' : 'claude', args, { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
      let text = '', diagnostics = '', timedOut = false, stalled = false;
      child.stdout!.on('data', c => { text = (text + String(c)).slice(-20_000); });
      child.stderr!.on('data', c => { diagnostics = (diagnostics + String(c)).slice(-4_000); });
      const kill = (): void => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); } };
      const timer = setTimeout(() => { timedOut = true; kill(); }, options.maxMs);
      // Working is a tool call now and then, or one in flight: each moves the stall deadline. Only an agent that stopped calling is cut off.
      let seen = 0, lastCall = Date.now();
      const watch = setInterval(() => {
        void readActivity(activity).then(now => {
          if (now.started + now.finished > seen || now.inFlight) { seen = now.started + now.finished; lastCall = Date.now(); }
          else if (Date.now() - lastCall > options.stallMs && !timedOut) { timedOut = true; stalled = true; kill(); }
        });
      }, 5_000);
      const code = await new Promise<number | null>(resolve => { child.once('close', resolve); child.once('error', () => resolve(-1)); });
      clearTimeout(timer); clearInterval(watch);
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

/** A TOML inline table of strings, for a codex -c override. */
function tomlInline(values: Record<string, string>): string {
  return `{${Object.entries(values).map(([k, v]) => `${JSON.stringify(k)}=${JSON.stringify(v)}`).join(',')}}`;
}
