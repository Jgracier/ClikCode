/** Commands that hand ClikCode's computer abilities to scripts and other programs as JSON: `clikcode agent run` and, under `computer`,
 * mcp, keygrab, keygrab-resume, keygrab-backoff, page, tab, desk-finished, settings, token and secret-rename. (commands/computer-ops.ts) */
import type { Command } from 'commander';
import { serveThenExit } from './stop-signal.js';

const many = (value: string, all: string[] = []): string[] => [...all, value];

export function registerComputerAbilities(program: Command, computer: Command): void {
  const agent = program.command('agent').description('Headless agents on your own subscription');
  agent.command('run').description('Run one headless agent turn on the account and harness of your chat (Claude Code or Codex; moves to another signed-in account of the same vendor on a usage limit), with only the MCP tools given: ClikCode\'s browser tools in one tab (--tab) and any servers in --mcp-config. Prints JSON {text, calls, timedOut, stalled, error, harness, account, model}')
    .requiredOption('--prompt-file <file>', 'The prompt (- for standard input)')
    .option('--tab <name>', 'Give the agent browser_use and account_use, pinned to this tab')
    .option('--egress <name>', 'With --tab: the way out its pages leave through (computer egress list)')
    .option('--block-url <regex>', 'With --tab: never open an address matching this (repeatable)', many)
    .option('--block-message <text>', 'With --tab: what the agent is told when an address is refused')
    .option('--mcp-config <file>', 'More MCP servers: JSON {"mcpServers": {name: {command, args, env}}}; all their tools are allowed. Each gets CLIKCODE_AGENT_ACTIVITY and CLIKCODE_AGENT_MAX_CALLS to share the call budget')
    .option('--max-calls <n>', 'Tool calls the agent may make in all (default 60)')
    .option('--max-minutes <n>', 'Ceiling on the run (default 20)')
    .option('--stall-minutes <n>', 'Stop an agent that makes no tool call for this long with none in flight (default 5)')
    .option('--session <chat>', 'Run on this chat\'s harness and account (default CLIKCODE_SESSION_ID, else the most recent Claude Code or Codex chat)')
    .option('--model <name>', 'Under Claude Code, instead of the agentModel setting')
    .action(async (flags: import('../commands/computer-ops.js').AgentRunFlags) => (await import('../commands/computer-ops.js')).agentRun(flags));

  computer.command('mcp').description('Serve browser_use and account_use over MCP (stdio), pinned to one tab, under a call budget')
    .requiredOption('--tab <name>', 'The one tab every call runs in')
    .option('--max-calls <n>', 'The call budget (default CLIKCODE_AGENT_MAX_CALLS, else 200)')
    .option('--activity <file>', 'The shared activity file (default CLIKCODE_AGENT_ACTIVITY)')
    .option('--egress <name>', 'The way out the tab leaves through')
    .option('--block-url <regex>', 'Never open an address matching this (repeatable)', many)
    .option('--block-message <text>', 'What a caller is told when an address is refused')
    .action(async (flags: import('../commands/computer-ops.js').ComputerMcpFlags) => {
      const { computerMcp } = await import('../commands/computer-ops.js');
      await serveThenExit(signal => computerMcp(flags, signal));
    });

  const delivery = (command: Command): Command => command
    .option('--send-to <json>', 'Where the captured key goes, as capture_secret takes it: {"to": ..., "with": {...}} or a list (none: only saved)')
    .option('--key-name <text>', 'The name typed into the site\'s key name box (default ClikCode)')
    .option('--secret-name <name>', 'The vault name for the key (default <name>/key)');
  delivery(computer.command('keygrab <name> <url>').description('Get an API key from a site with no model: sign in, find the key page, create a key, capture it unseen, save the steps for next time. Prints JSON: {ok, note, capturedOn} or {ok:false, stop}. A run that cannot finish parks its tab')
    .option('--tab <name>', 'The tab to work in (default keygrab)').option('--egress <name>', 'The way out the tab leaves through')
    .option('--max-minutes <n>', 'Most minutes (default 5)').option('--max-steps <n>', 'Most browser actions')
    .option('--alternate <url>', 'Another start page if the first is no web page (repeatable)', many))
    .action(async (name: string, url: string, flags: import('../commands/computer-ops.js').KeygrabFlags) => (await import('../commands/computer-ops.js')).computerKeygrab(name, url, flags));
  delivery(computer.command('keygrab-resume <name>').description('Carry on with a keygrab that could not finish: reattach to its parked tab, optionally press one thing or go to one address, and continue. Prints JSON')
    .option('--click <text>', 'Press the control with this visible text first').option('--goto <url>', 'Go to this https address first')
    .option('--only', 'Press or go, then show the page and stop').option('--max-steps <n>', 'Most browser actions (default 60)').option('--max-minutes <n>', 'Most minutes (default 4)'))
    .action(async (name: string, flags: import('../commands/computer-ops.js').KeygrabResumeFlags) => (await import('../commands/computer-ops.js')).computerKeygrabResume(name, flags));
  computer.command('keygrab-backoff <name>').description('When a site may be tried again after a captcha keygrab could not clear (JSON {until})')
    .option('--set', 'Start the back-off now').option('--clear', 'End it')
    .action(async (name: string, flags: { set?: boolean; clear?: boolean }) => (await import('../commands/computer-ops.js')).computerKeygrabBackoff(name, flags));

  const page = computer.command('page').description('Render a page in ClikCode\'s browser and report it as JSON (nothing is clicked or typed)');
  const pageOptions = (command: Command): Command => command.option('--tab <name>', 'The tab (default page)').option('--egress <name>', 'The way out the tab leaves through').option('--max-bytes <n>', 'Largest body kept');
  pageOptions(page.command('read <url>').description('Open the address and report {url, ok, status, result, loaded, humanCheck}')
    .option('--eval-file <file>', 'A JavaScript expression (file, or - for standard input) evaluated in the page; its value is result')
    .option('--collect <regex>', 'Keep the bodies of loaded responses whose "<url> <content-type>" matches').option('--timeout <seconds>', 'Page load limit (default 20)')
    .option('--human-check', 'Say whether a human check is in the way'))
    .action(async (url: string, flags: import('../commands/computer-ops.js').PageFlags) => (await import('../commands/computer-ops.js')).computerPageRead(url, flags));
  pageOptions(page.command('fetch <url>').description('Get one address with the browser\'s own request context: {ok, status, contentType, text}'))
    .action(async (url: string, flags: import('../commands/computer-ops.js').PageFlags) => (await import('../commands/computer-ops.js')).computerPageFetch(url, flags));

  const tab = computer.command('tab').description('The browser\'s named tabs');
  tab.command('list').description('Every tab with when it was last used (JSON)').action(async () => (await import('../commands/computer-ops.js')).computerTabList());
  tab.command('close <names...>').description('Close the named tabs, whichever process opened them').action(async (names: string[]) => (await import('../commands/computer-ops.js')).computerTabClose(names));

  computer.command('desk-finished').description('Handoff desk items the user finished that name something to resume (JSON)')
    .option('--take', 'Mark them taken, so the next call does not list them again').option('--remove <resume>', 'Drop the waiting items that name this')
    .action(async (flags: { take?: boolean; remove?: string }) => (await import('../commands/computer-ops.js')).computerDeskFinished(flags));

  computer.command('settings [name] [value]').description('Tunable values (JSON): agentModel, captchaVoterModel, captchaSubscription, captchaVoteLog, keygrabLog. With a value: set it (default: back to the default)')
    .action(async (name?: string, value?: string) => (await import('../commands/computer-ops.js')).computerSettings(name, value));

  const token = computer.command('token').description('A random token kept in the vault for one https site and used without being shown');
  token.command('generate <name>').description('Make one and keep it for --url; prints only its SHA-256')
    .requiredOption('--url <origin>', 'The https origin it is for').option('--prefix <text>', 'Text before the random part').option('--bytes <n>', 'Random bytes (default 32)')
    .action(async (name: string, flags: { url: string; prefix?: string; bytes?: string }) => (await import('../commands/computer-ops.js')).computerSecretGenerate(name, flags));
  token.command('call <name>').description('One HTTPS request to the token\'s own site with it as a Bearer credential; prints {status, contentType, body}')
    .requiredOption('--path <path>', 'The path on that site').option('--method <method>', 'GET, POST, PUT, PATCH or DELETE')
    .option('--header <line>', 'name: value (repeatable)', many).option('--data-file <file>', 'The request body (- for standard input)').option('--timeout <seconds>', 'Default 90')
    .action(async (name: string, flags: { path: string; method?: string; header?: string[]; dataFile?: string; timeout?: string }) => (await import('../commands/computer-ops.js')).computerSecretCall(name, flags));
  computer.command('secret-rename <from> <to>').description('Keep a saved secret under another name (it is never shown)')
    .action(async (from: string, to: string) => (await import('../commands/computer-ops.js')).computerSecretRename(from, to));
}
