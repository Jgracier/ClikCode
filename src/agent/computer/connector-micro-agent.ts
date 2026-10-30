/** One bounded agent micro-task for a screen no rule knows: a headless agent (the `claude` command, as ClikCode's workers use it) with the
 * browser_use and account_use tools ONLY, served by `clikcode connectors agent-mcp`, which counts every call and refuses past the budget.
 * The prompt is the screen as the runner saw it plus one goal. On success the agent has captured the key (unseen) and saved a recipe, so
 * the next vendor on that host needs no agent. */
import { quiet } from '../../runtime/lifecycle-log.js';
import { scrubSecrets } from './secret-scrubber.js';
import type { DriveOutcome, HumanStep, StopInfo } from './connector-runner.js';

export const MICRO_GOAL = 'get an API key (or finish the OAuth consent) for this vendor, then save a recipe';
export const microTab = (id: string): string => `agent-${id.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`;

export function microPrompt(id: string, stop: StopInfo, maxCalls: number): string {
  const controls = stop.controls.slice(0, 20).map(c => scrubSecrets(c).slice(0, 60)).join(' | ');
  return [
    `You are finishing ClikDeploy connector onboarding for the vendor "${id}". A rule-based runner stopped on a screen it does not know.`,
    `Goal: ${MICRO_GOAL}.`,
    `You may use the browser_use and account_use tools ONLY, at most ${maxCalls} calls in total (the tool refuses after that). The tab is fixed for you.`,
    '',
    `The screen it stopped on: ${stop.url || '(address unknown)'}`,
    `Why it stopped: ${scrubSecrets(stop.message).slice(0, 300)}`,
    `Page text: ${scrubSecrets(stop.pageText).slice(0, 1500)}`,
    controls ? `Things on the page you can press: ${controls}` : '',
    '',
    'Rules:',
    `1. Start with browser_use action open on the address above (or the vendor's developer page), then observe.`,
    `2. To get a key: reach the key page, set the options, then browser_use action capture_secret with target = the final Create button, secret_name "${id}/key", vendor "${id}" and send_to [{ "to": "clikdeploy-connection", "with": { "integration": "${id}" } }]. Never print, type or repeat a key.`,
    '3. When it worked, save what you did with browser_use action recipe, recipe_op save (host, login_route, steps, key_page, capture_hint) so the next run needs no agent.',
    '4. Never solve a captcha, give card details, buy a plan, or enter a phone or authenticator code. If a screen needs one of those, stop.',
    '5. Your last line must be exactly one of:',
    '   RESULT: captured',
    '   RESULT: wall <captcha|sms|card|paid-plan|sales|app-review|oauth-app|free-mail|work-email|no-api|dead-host> <one sentence>',
    '   RESULT: gave-up <one sentence>',
  ].filter(l => l !== '').join('\n');
}

export type MicroResult = { kind: 'captured' } | { kind: 'wall'; wall: string; why: string } | { kind: 'gave-up'; why: string };

export function parseMicroResult(text: string): MicroResult {
  const lines = scrubSecrets(text).split('\n').map(l => l.trim()).filter(Boolean);
  for (const line of lines.reverse()) {
    const m = /^RESULT:\s*(captured|wall|gave-up)\b\s*(.*)$/i.exec(line.replace(/^[`*>\s-]+/, ''));
    if (!m) continue;
    const kind = m[1]!.toLowerCase();
    if (kind === 'captured') return { kind: 'captured' };
    if (kind === 'wall') { const [wall = 'unknown', ...rest] = m[2]!.split(/\s+/); return { kind: 'wall', wall: wall.toLowerCase(), why: rest.join(' ').slice(0, 300) }; }
    return { kind: 'gave-up', why: m[2]!.slice(0, 300) };
  }
  return { kind: 'gave-up', why: 'the agent ended without a RESULT line' };
}

const WALL_TO_HUMAN: Record<string, HumanStep['kind']> = { captcha: 'captcha', sms: 'sms', card: 'payment', 'paid-plan': 'payment', sales: 'vendor-contact', 'app-review': 'app-review', 'oauth-app': 'app-registration', 'free-mail': 'decision', 'work-email': 'decision', 'no-api': 'retire', 'dead-host': 'retire' };
const WALL_TO_STOP: Record<string, StopInfo['kind']> = { captcha: 'captcha', sms: 'mfa', card: 'payment', 'paid-plan': 'payment' };

export interface MicroPorts {
  /** Runs the agent to its end or the deadline; its final text. */
  run(prompt: string, options: { tab: string; maxCalls: number; maxMs: number }): Promise<{ text: string; timedOut: boolean; calls: number }>;
  /** A stamp of the saved recipes, to see whether one was recorded. */
  recipeStamp(): Promise<string>;
}

export async function runMicroTask(id: string, stop: StopInfo, budget: { maxCalls: number; maxMs: number }, ports: MicroPorts): Promise<DriveOutcome> {
  const before = await ports.recipeStamp().catch(() => '');
  const tab = microTab(id);
  const ran = await ports.run(microPrompt(id, stop, budget.maxCalls), { tab, ...budget }).catch((error: unknown) => ({ text: '', timedOut: false, calls: 0, error: scrubSecrets(error instanceof Error ? error.message : String(error)) }));
  const err = 'error' in ran ? ran.error : undefined;
  const result = ran.timedOut ? { kind: 'gave-up', why: `the agent used its ${Math.round(budget.maxMs / 1000)}s` } as MicroResult : err ? { kind: 'gave-up', why: `the agent could not run: ${err.slice(0, 200)}` } as MicroResult : parseMicroResult(ran.text);
  const after = await ports.recipeStamp().catch(() => '');
  if (result.kind === 'captured') return { ok: true, note: `an agent micro-task got the key unseen (${ran.calls} tool calls)${after !== before ? ' and saved a recipe' : ''}`, actions: ran.calls, recipe: after !== before };
  if (result.kind === 'wall') {
    const kind = WALL_TO_HUMAN[result.wall];
    if (kind) return { ok: false, stop: { kind: WALL_TO_STOP[result.wall] ?? 'unknown', message: `${result.wall}: ${result.why}`, url: stop.url, pageText: stop.pageText, controls: stop.controls, human: { kind, ...(stop.url ? { url: stop.url } : {}), instructions: `${result.wall}: ${result.why}`.slice(0, 300), reasonCode: result.wall } } };
  }
  const why = result.kind === 'gave-up' ? result.why : 'the agent reported a wall it could not name';
  return { ok: false, stop: { ...stop, message: `the agent micro-task did not finish (${ran.calls} calls): ${why}`.slice(0, 300) } };
}

export function livePorts(stateDir: string): MicroPorts {
  return {
    async recipeStamp() { const { listRecipes } = await import('./signup-recipes.js'); return (await listRecipes(stateDir)).map(r => `${r.host}:${r.loginRoute}:${r.verifiedAt}`).sort().join('|'); },
    async run(prompt, options) {
      const [{ mkdtemp, writeFile, readFile, rm }, { tmpdir }, { join }, { spawn }] = await Promise.all([import('node:fs/promises'), import('node:os'), import('node:path'), import('node:child_process')]);
      const dir = await mkdtemp(join(tmpdir(), 'clikcode-micro-'));
      const counter = join(dir, 'calls');
      try {
        const entry = process.env.CLIKCODE_MCP_ENTRY || process.argv[1]!;
        const config = join(dir, 'mcp.json');
        await writeFile(config, JSON.stringify({ mcpServers: { clikcode: { command: process.execPath, args: [entry, 'connectors', 'agent-mcp', '--tab', options.tab, '--max-calls', String(options.maxCalls), '--counter', counter] } } }));
        const argv = ['-p', prompt, '--output-format', 'text', '--mcp-config', config, '--strict-mcp-config', '--tools', '', '--allowedTools', 'mcp__clikcode__browser_use', 'mcp__clikcode__account_use', '--permission-mode', 'dontAsk', '--no-session-persistence', ...(process.env.CLIKCODE_MICRO_AGENT_MODEL ? ['--model', process.env.CLIKCODE_MICRO_AGENT_MODEL] : [])];
        const child = spawn('claude', argv, { stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
        let text = '', timedOut = false;
        child.stdout!.on('data', c => { text = (text + String(c)).slice(-20_000); });
        child.stderr!.on('data', quiet('agent/computer/connector-micro-agent'));
        const kill = (): void => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); } };
        const timer = setTimeout(() => { timedOut = true; kill(); }, options.maxMs);
        await new Promise<void>(resolve => { child.once('close', () => resolve()); child.once('error', () => resolve()); });
        clearTimeout(timer);
        const calls = Number(await readFile(counter, 'utf8').catch(() => '0')) || 0;
        return { text, timedOut, calls };
      } finally { await rm(dir, { recursive: true, force: true }).catch(quiet('agent/computer/connector-micro-agent')); }
    },
  };
}
