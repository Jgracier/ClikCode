/** One bounded agent micro-task for a screen no rule knows: a headless agent (the `claude` command, as ClikCode's workers use it) with the
 * browser_use and account_use tools ONLY, served by `clikcode connectors agent-mcp`, which counts every call and refuses past the budget.
 * The prompt is the screen as the runner saw it plus one goal. On success the agent has captured the key (unseen) and saved a recipe, so
 * the next vendor on that host needs no agent. */
import type { AiHarnessAccount } from '../../harness/definition.js';
import type { HarnessSession } from '../../session/model.js';
import { accountCanTakeTurn } from '../../harness/accounts/usage-reading.js';
import { nativeProfileEnvironment } from '../../harness/transport/profile-environment.js';
import { quiet } from '../../runtime/lifecycle-log.js';
import { scrubSecrets } from './secret-scrubber.js';
import type { DriveOutcome, HumanStep, StopInfo } from './connector-runner.js';

export const microTab = (id: string): string => `agent-${id.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`;

/** The one case where an agent creates a credential that is not a key: the platform's own OAuth app at a vendor. The rule names exactly
 * what may be made (one app, the given redirect address) and where its secret goes (sealed, onto the connector), and keeps every other
 * limit: no keys, users, roles, second apps, reviews, payments or cloud consoles. */
/** The rule for asking a sales-only vendor for developer access: one request through the vendor's own contact or access form, in the
 * owner's words, never a call booked, a contract or a payment. */
export function accessRequestRule(id: string): string {
  return `5. This task is to ask the vendor, once, for developer API access for the "${id}" connector. Find its own "contact sales", "request access", "get API access" or support form (not a chat bot, not a meeting booking). Fill it with no text for the profile fields (name, email, company, phone) and this message: `
    + '"Hello, we are building a ClikDeploy integration for your product so our shared customers can connect it. Could you give us a developer or sandbox API key (or a partner/test account) to build and test it? We only need read access to start. Thank you." '
    + 'Choose the smallest options offered (company size, budget, "partner" or "other" as the reason). Never book a meeting, sign a contract, start a paid plan or a trial that asks for a card, and send nothing else. When the form is sent, end with RESULT: wall sales access requested through <the page> on <today>. If there is no such form, end with RESULT: wall sales no access form.';
}

export function oauthAppRule(id: string): string {
  return `5. This task is to register ONE OAuth app for ClikDeploy in the vendor's developer settings, and nothing else. Sign in (or sign up) with the profile's account, find where apps or OAuth clients are made, and create one: name ClikDeploy, a web (confidential) app, the redirect address given in the task, and the narrowest scopes offered that still cover reading. If the account already has an app named ClikDeploy (made for another connector of this vendor), use that one instead of making a second, and never regenerate its secret: if the secret cannot be shown again, end with RESULT: gave-up and say so. `
    + `Then browser_use action capture_secret with target = the control that shows or copies the client secret, secret_name "${id}/oauth-client-secret", vendor "${id}" and send_to [{ "to": "clikdeploy-connector", "with": { "integration": "${id}", "client_id": "<the client id the page shows>" } }]. The client id is not a secret; the client secret is never printed, typed or repeated. `
    + 'Never create an API key, a user, a role or a second app, never submit an app for review, never choose a paid plan or a subscription (a card box may be filled with no text, and the standing card rule decides), and nothing in a cloud console (AWS, Google Cloud, Azure). If the vendor wants a review, a business verification or a paid plan before it issues a client, stop with RESULT: wall app-review (or paid-plan). When the secret was sent and the result says saved, end with RESULT: completed.';
}

export function microPrompt(id: string, stop: StopInfo, maxCalls: number, extra: { businessEmail?: string } = {}): string {
  const controls = stop.controls.slice(0, 20).map(c => scrubSecrets(c).slice(0, 60)).join(' | ');
  const registering = /^oauth-app:/i.test(stop.message);
  const requesting = /^access-request:/i.test(stop.message);
  return [
    `You are finishing ClikDeploy connector onboarding for the vendor "${id}". A rule-based runner stopped on a screen it does not know.`,
    `Goal: finish the exact assigned platform task shown below. Use signup/key capture only when the task needs a connection. For copy, spec or proof work use connector_task; do not restart signup. Research official documentation in the browser, use connector_build for a published API reference, and write connector_spec_put only when the full API has been documented. A spec must keep the assigned id.`,
    `You may use browser_use, account_use, and connector_task for the assigned connector ONLY, at most ${maxCalls} calls in total (the tool refuses after that). The tab is fixed for you.`,
    '',
    `The screen it stopped on: ${stop.url || '(address unknown)'}`,
    `Why it stopped: ${scrubSecrets(stop.message).slice(0, 300)}`,
    `Page text: ${scrubSecrets(stop.pageText).slice(0, 1500)}`,
    controls ? `Things on the page you can press: ${controls}` : '',
    '',
    'Rules:',
    `1. Read the task and saved progress below. For unfamiliar operations use connector_task tool=describe with args.tool to get the exact schema. Save useful progress with connector_work_note before stopping. Use connector_task to read the spec, copy task or proof as needed. For credential work, open its vendor address and observe.`,
    `2. To get a key: reach the key page, set the options, then browser_use action capture_secret with target = the final Create button, secret_name "${id}/key", vendor "${id}" and send_to [{ "to": "clikdeploy-connection", "with": { "integration": "${id}" } }]. Never print, type or repeat a key.`,
    '3. When it worked, save what you did with browser_use action recipe, recipe_op save (host, login_route, steps, key_page, capture_hint) so the next run needs no agent.',
    '4. A captcha is solved by human_check itself (a picture of the puzzle goes to the vision model; never use an external solving service). A phone check is not a wall either: fill the phone box with no text (the profile phone, a Twilio number kept for sign-ups), send the code, then account_use action read_sms_code and type the code it returns (it reads the Twilio number and the user\'s own phone); if the site refuses the number as VoIP, virtual or not mobile, fill the phone box again with no text (it then types the user\'s own mobile) and send again (if it says no Mac is set up or the Mac cannot be read, the code cannot be had in this run: do not wait or hand off, end with RESULT: wall sms and its words); an authenticator code comes from account_use action auth_code. A card box is not a wall when nothing is charged until used: fill the card boxes with no text and the user\'s standing rule decides (it fills them only if the page itself says nothing is charged until something is used and names no subscription, renewal or amount due today). Never choose a paid plan or a subscription, and never enter a card for a trial. A free trial that asks for no payment method is fine: nothing can renew or charge, it simply expires. A saved password the site refuses is not a wall either: press its Forgot password link, send the reset, account_use action open_email_link with subject "password", fill the new password box with no text (a new password is made and saved), then sign in again. A sign-in that also asks for a company, workspace or account name: it is in the account\'s welcome or verification email (account_use read_email_code / open_email_link with the site\'s name as from), or the site\'s own "forgot account name" link; once found, save it with account_use action profile custom {<site>_account_name: {value, match: ["account name","company account"]}} so the next sign-in fills it. If one of those cannot clear it, or a screen needs a paid plan, stop.',
    extra.businessEmail ? `4b. A sign-up that refuses a free address (Gmail) wants a work email: sign up with email and password using ${extra.businessEmail} (type it into the email box; every password box fills itself), not Google sign-in. It is a connected mailbox: account_use action read_email_code or open_email_link with address ${extra.businessEmail} reads the verification mail. A refused free address is never a wall while this address is untried.` : '',
    registering ? oauthAppRule(id) : requesting ? accessRequestRule(id) : '5. Never create, widen, rotate or delete credentials or permissions beyond the ONE key this connector needs: no root, admin, owner or billing keys, no IAM users, roles or policies, no team-member role changes, and nothing in a cloud console (AWS, Google Cloud, Azure). If a task asks for more access than this one key (an owner, admin or account-wide credential), stop with RESULT: wall no-api and say what was asked. A key ClikDeploy made itself (named ClikDeploy) may be deleted to make room for a new one when the vendor\'s key limit is reached; never delete any other. A REFUSED key is not a wall: find why (the wrong kind of key, a second value the vendor needs beside it such as a secret, account id or region, or the key sent in the wrong place) and fix the connection values or the spec with connector_task; RESULT: wall no-api only when the vendor issues no key a free account can use. An OAuth connection that is rejected or expired is not a wall either: reconnect it with account_use action oauth_connect (target = this connector id). This rule wins over any task text.',
    '6. Judge only the task you were given. It is done only when ClikDeploy shows it done (call connector_onboard and read what it answers now): a change you made but did not see take effect is not done. When it is done, end with RESULT: completed even if other checklist items remain: the runner asks ClikDeploy for the next item and hands it on. Use gave-up only when the assigned task itself could not be done.',
    '7. Your last line must be exactly one of:',
    '   RESULT: captured <one sentence: what you captured and where it went>',
    '   RESULT: completed <one sentence: what you changed, and what connector_onboard answers now>',
    '   RESULT: wall <captcha|sms|card|paid-plan|sales|app-review|oauth-app|free-mail|work-email|no-api|dead-host> <one sentence>',
    '   RESULT: gave-up <one sentence>',
  ].filter(l => l !== '').join('\n');
}

type MicroResult = { kind: 'captured'; said?: string } | { kind: 'wall'; wall: string; why: string } | { kind: 'gave-up'; why: string };

export function parseMicroResult(text: string): MicroResult {
  const lines = scrubSecrets(text).split('\n').map(l => l.trim()).filter(Boolean);
  for (const line of lines.reverse()) {
    const m = /^RESULT:\s*(captured|completed|wall|gave-up)\b\s*(.*)$/i.exec(line.replace(/^[`*>\s-]+/, ''));
    if (!m) continue;
    const kind = m[1]!.toLowerCase();
    if (kind === 'captured' || kind === 'completed') return { kind: 'captured', ...(m[2]!.trim() ? { said: m[2]!.trim().slice(0, 200) } : {}) };
    if (kind === 'wall') { const [wall = 'unknown', ...rest] = m[2]!.split(/\s+/); return { kind: 'wall', wall: wall.toLowerCase(), why: rest.join(' ').slice(0, 300) }; }
    return { kind: 'gave-up', why: m[2]!.slice(0, 300) };
  }
  return { kind: 'gave-up', why: 'the agent ended without a RESULT line' };
}

const WALL_TO_HUMAN: Record<string, HumanStep['kind']> = { captcha: 'captcha', sms: 'sms', card: 'payment', 'paid-plan': 'payment', sales: 'vendor-contact', 'app-review': 'app-review', 'oauth-app': 'app-registration', 'free-mail': 'decision', 'work-email': 'decision', 'no-api': 'retire', 'dead-host': 'retire' };
const WALL_TO_STOP: Record<string, StopInfo['kind']> = { captcha: 'captcha', sms: 'mfa', card: 'payment', 'paid-plan': 'payment' };

export interface MicroPorts {
  /** A connected mailbox on a business domain, for sign-ups that refuse a free address. */
  businessEmail?(): Promise<string | undefined>;
  /** Runs the agent to its end; its final text. It is stopped only when it stalls (no tool call for STALL_MS) or reaches the
   * ceiling maxMs: an agent still working is never cut off by the clock. `stalled` says which stop it was. */
  run(prompt: string, options: { tab: string; maxCalls: number; maxMs: number; /** The vendor run's egress (egress.ts); the agent's browser keeps to it. */ egress?: string }): Promise<{ text: string; timedOut: boolean; stalled?: boolean; calls: number; error?: string }>;
  /** A stamp of the saved recipes, to see whether one was recorded. */
  recipeStamp(): Promise<string>;
}

/** How long an agent may go without a tool call before it is taken as stuck. Model turns and a texted or mailed code (read_sms_code
 * waits inside one call) fit well inside it. */
export const STALL_MS = 5 * 60_000;

export async function runMicroTask(id: string, stop: StopInfo, budget: { maxCalls: number; maxMs: number }, ports: MicroPorts, egress?: string): Promise<DriveOutcome> {
  const before = await ports.recipeStamp().catch(() => '');
  const tab = microTab(id);
  const businessEmail = await ports.businessEmail?.().catch(quiet('agent/computer/connector-micro-agent'));
  const ran = await ports.run(microPrompt(id, stop, budget.maxCalls, businessEmail ? { businessEmail } : {}), { tab, ...budget, ...(egress && egress !== 'home' ? { egress } : {}) }).catch((error: unknown) => ({ text: '', timedOut: false, calls: 0, error: scrubSecrets(error instanceof Error ? error.message : String(error)) }));
  const err = 'error' in ran ? ran.error : undefined;
  const result = ran.timedOut ? { kind: 'gave-up', why: 'stalled' in ran && ran.stalled ? `the agent stalled: no tool call for ${Math.round(STALL_MS / 1000)}s` : `the agent reached the ${Math.round(budget.maxMs / 60_000)} min ceiling while still working` } as MicroResult : err ? { kind: 'gave-up', why: `the agent could not run: ${err.slice(0, 200)}` } as MicroResult : parseMicroResult(ran.text);
  const after = await ports.recipeStamp().catch(() => '');
  // What the agent said it did goes into the step log: a "finished" after two calls that left the platform's task unchanged could not
  // be told from real work without it.
  if (result.kind === 'captured') return { ok: true, agentCalls: ran.calls, note: `an agent micro-task finished its assigned task (${ran.calls} tool calls)${after !== before ? ' and saved a recipe' : ''}${result.said ? `: ${result.said}` : ''}`, actions: ran.calls, recipe: after !== before };
  if (result.kind === 'wall') {
    const kind = WALL_TO_HUMAN[result.wall];
    if (kind) return { ok: false, agentCalls: ran.calls, stop: { kind: WALL_TO_STOP[result.wall] ?? 'unknown', message: `${result.wall}: ${result.why}`, url: stop.url, pageText: stop.pageText, controls: stop.controls, human: { kind, ...(stop.url ? { url: stop.url } : {}), instructions: `${result.wall}: ${result.why}`.slice(0, 300), reasonCode: result.wall } } };
  }
  const why = result.kind === 'gave-up' ? result.why : 'the agent reported a wall it could not name';
  if (err) return { ok: false, agentCalls: ran.calls, stop: { ...stop, kind: 'unknown', human: undefined, agentUnavailable: true, message: `the agent could not run: ${err}`.slice(0, 300) } };
  return { ok: false, agentCalls: ran.calls, stop: { ...stop, message: `the agent micro-task did not finish (${ran.calls} calls): ${why}`.slice(0, 300) } };
}

/** Use a saved, usable native profile. A limit on Claude must not strand the line when Codex is available. (The captcha
 * subscription voter's pick: connector agents run on the user's chat route instead, chatRoute below.) */
export function microAccount(accounts: readonly AiHarnessAccount[]): AiHarnessAccount | undefined {
  const usable = accounts.filter((account) => accountCanTakeTurn(account) && account.authKind === 'vendor-cli');
  return usable.find((account) => account.provider === 'anthropic' && account.nativeProfile?.env === 'CLAUDE_CONFIG_DIR')
    ?? usable.find((account) => account.provider === 'openai' && account.nativeProfile?.env === 'CODEX_HOME');
}

/** The harnesses a connector agent can be run headless on, by the command that runs them. */
const CHAT_HARNESSES = { claude: 'claude', codex: 'codex' } as const;
type ChatHarness = keyof typeof CHAT_HARNESSES;

/** What the user is chatting on right now -- the harness, the signed-in account and the model of their most recent chat -- which is
 * what a connector agent runs on: the same subscription doing the same kind of work, never Gateway credit and never another account.
 * An error says why it cannot, in words for the outcome (the loop retries an agent that could not run, it is no vendor wall). */
export function chatRoute(state: { sessions: readonly HarnessSession[]; accounts: readonly AiHarnessAccount[] }, now = Date.now(), sessionId?: string): { harness: ChatHarness; account: AiHarnessAccount; model?: string } | { error: string } {
  const chats = [...state.sessions].filter(session => session.route === 'local' && session.nativeHarness && session.accountId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  if (!chats.length) return { error: 'No chat with a signed-in harness was found to run the connector agent on.' };
  // The most recent chat on a harness that can run headless: a newer chat on Copilot or OpenCode left every hand-off unable to start
  // (27 on 2026-11-18) although a Claude Code chat on the user's own account was right behind it.
  const chat = sessionId ? chats.find(session => session.id === sessionId) : chats.find(session => (session.nativeHarness as string) in CHAT_HARNESSES);
  if (sessionId && !chat) return { error: `The connector's initiating chat (${sessionId}) is missing or has no signed-in local harness; no other chat will be used.` };
  if (chat && !(chat.nativeHarness as string in CHAT_HARNESSES)) return { error: `The connector's initiating chat runs on ${chat.nativeHarness}; connector agents run on Claude Code or Codex.` };
  if (!chat) return { error: `The recent chats run on ${chats[0]!.nativeHarness}; connector agents run on Claude Code or Codex.` };
  const harness = chat.nativeHarness as string;
  const account = state.accounts.find(item => item.id === chat.accountId);
  if (!account?.nativeProfile) return { error: `The current chat's ${harness} account is not signed in on this computer.` };
  if (!accountCanTakeTurn(account, now)) return { error: `The current chat's ${harness} account (${account.label}) has no usage left now.` };
  return { harness: harness as ChatHarness, account, ...(chat.model ? { model: chat.model } : {}) };
}

export function livePorts(stateDir: string): MicroPorts {
  // A background service binds its initiating conversation explicitly. Other windows must not change its route.
  const sessionId = process.env.CLIKCODE_CONNECTOR_SESSION_ID ?? process.env.CLIKCODE_SESSION_ID;
  return {
    async businessEmail() {
      const { emailStatus } = await import('./email-api.js');
      const free = /@(?:gmail|googlemail|yahoo|ymail|outlook|hotmail|live|msn|icloud|me|mac|aol|proton(?:mail)?|gmx|mail|yandex|zoho)\./i;
      return (await emailStatus(stateDir)).mailboxes.map(m => m.email).find(address => !free.test(address));
    },
    async recipeStamp() { const { listRecipes } = await import('./signup-recipes.js'); return (await listRecipes(stateDir)).map(r => `${r.host}:${r.loginRoute}:${r.verifiedAt}`).sort().join('|'); },
    async run(prompt, options) {
      const [{ mkdtemp, writeFile, readFile, rm }, { tmpdir }, { join }, { spawn }] = await Promise.all([import('node:fs/promises'), import('node:os'), import('node:path'), import('node:child_process')]);
      const { readState } = await import('../../session/state/read.js');
      const route = chatRoute(await readState({ transcripts: [] }), Date.now(), sessionId);
      if ('error' in route) throw new Error(route.error);
      const { account, model } = route;
      const useCodex = route.harness === 'codex';
      const dir = await mkdtemp(join(tmpdir(), 'clikcode-micro-'));
      const counter = join(dir, 'calls');
      try {
        const entry = process.env.CLIKCODE_MCP_ENTRY || process.argv[1]!;
        const config = join(dir, 'mcp.json');
        // The MCP server runs the agent's browser calls in its own process: the egress goes with the tab, on its command line.
        const serverArgs = [entry, 'connectors', 'agent-mcp', '--tab', options.tab, '--max-calls', String(options.maxCalls), '--counter', counter, '--connector', options.tab.replace(/^agent-/, ''), ...(options.egress ? ['--egress', options.egress] : [])];
        await writeFile(config, JSON.stringify({ mcpServers: { clikcode: { command: process.execPath, args: serverArgs } } }));
        const argv = ['-p', prompt, ...(model ? ['--model', model] : []), '--output-format', 'text', '--mcp-config', config, '--strict-mcp-config', '--tools', '', '--allowedTools', 'mcp__clikcode__browser_use', 'mcp__clikcode__account_use', 'mcp__clikcode__connector_task', '--permission-mode', 'dontAsk', '--no-session-persistence', ...(process.env.CLIKCODE_MICRO_AGENT_MODEL ? ['--model', process.env.CLIKCODE_MICRO_AGENT_MODEL] : [])];
        const final = join(dir, 'final.txt');
        const args = useCodex ? ['exec', ...(model ? ['-m', model] : []), '--ephemeral', '--ignore-user-config', '--skip-git-repo-check', '-C', dir, '-s', 'read-only',
          '-c', 'approval_policy="never"', '-c', 'features.shell_tool=false', '-c', 'web_search="disabled"',
          '-c', `mcp_servers.clikcode.command=${JSON.stringify(process.execPath)}`,
          '-c', `mcp_servers.clikcode.args=${JSON.stringify(serverArgs)}`,
          '-c', 'mcp_servers.clikcode.required=true', '-c', 'mcp_servers.clikcode.enabled_tools=["browser_use","account_use","connector_task"]',
          '-c', 'mcp_servers.clikcode.default_tools_approval_mode="approve"', '-o', final, prompt] : argv;
        const env = { ...process.env, ...nativeProfileEnvironment(account.nativeProfile) };
        // This is a signed-in native account, never an unrelated API key inherited from the parent.
        delete env.OPENAI_API_KEY;
        delete env.ANTHROPIC_API_KEY;
        const child = spawn(useCodex ? 'codex' : 'claude', args, { env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
        let text = '', timedOut = false, stalled = false;
        child.stdout!.on('data', c => { text = (text + String(c)).slice(-20_000); });
        child.stderr!.on('data', quiet('agent/computer/connector-micro-agent'));
        const kill = (): void => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); } };
        const timer = setTimeout(() => { timedOut = true; kill(); }, options.maxMs);
        // Working is a tool call now and then: each one moves the stall deadline. Only an agent that has stopped calling is cut off.
        let seen = 0, lastCall = Date.now();
        const watch = setInterval(() => {
          void readFile(counter, 'utf8').then(raw => raw, () => '').then(raw => {
            const count = parseInt(raw, 10) || 0;
            if (count > seen || raw.endsWith('+')) { seen = count; lastCall = Date.now(); } else if (Date.now() - lastCall > STALL_MS && !timedOut) { timedOut = true; stalled = true; kill(); }
          });
        }, 5_000);
        const code = await new Promise<number | null>(resolve => { child.once('close', code => resolve(code)); child.once('error', () => resolve(-1)); });
        clearTimeout(timer); clearInterval(watch);
        if (useCodex) text = await readFile(final, 'utf8').catch(() => '');
        const calls = parseInt(await readFile(counter, 'utf8').catch(() => '0'), 10) || 0;
        return { text, timedOut, ...(stalled ? { stalled } : {}), calls, ...(code !== 0 && !timedOut ? { error: `the agent could not run: ${useCodex ? 'Codex' : 'Claude Code'} (${account.label}) exited ${code}` } : {}) };
      } finally { await rm(dir, { recursive: true, force: true }).catch(quiet('agent/computer/connector-micro-agent')); }
    },
  };
}
