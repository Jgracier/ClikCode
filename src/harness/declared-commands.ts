/** Commands a harness runs when ClikCode sends them, for a harness that does
 * not list them itself (no ACP `available_commands_update`, no self-report).
 * Each was sent through ClikCode's own turn and answered by the harness, not
 * by its model (2026-11-14: Kiro CLI 2.x over ACP, Aider 0.86.2 `--message`).
 * Left out: what needs the vendor's own screen (pickers, editors, clipboard,
 * voice, quitting) or changes what ClikCode keeps for the chat (clearing or
 * replacing its history, files added for one run only), commands that
 * answered nothing, and Aider's /undo, which only undoes a commit made in the
 * same Aider process (each ClikCode turn is a new one). A harness that lists its own commands needs no entry:
 * what it says is used. Codex (app-server), Amp (`--execute`) and OpenClaw
 * (`agent --local`) take no commands in the way ClikCode runs them -- the
 * model answers the text -- so they have none here; ClikCode's own commands
 * (/compact, /model, …) are their commands. */

import type { HarnessAvailableCommand } from './events/turn-observer.js';

const DECLARED: Readonly<Record<string, readonly HarnessAvailableCommand[]>> = {
  kiro: [
    { name: 'agent', description: 'List Kiro\'s agents, or swap to one', hint: '[agent-name|swap <name>]' },
    { name: 'plan', description: 'Switch to Kiro\'s planning agent' },
    { name: 'guide', description: 'Switch to Kiro\'s guide agent, for questions about Kiro' },
    { name: 'context', description: 'Show how much of the context window is used' },
    { name: 'tools', description: 'Show the tools Kiro can use' },
    { name: 'mcp', description: 'Show the configured MCP servers' },
    { name: 'hooks', description: 'Show the configured hooks' },
    { name: 'usage', description: 'Show Kiro billing and credit usage' },
    { name: 'stats', description: 'Show request ids and timings of recent turns' },
    { name: 'model', description: 'List Kiro\'s models, or choose one', hint: '[model-name]' },
    { name: 'effort', description: 'Set Kiro\'s thinking effort', hint: '[level]' },
    { name: 'compact', description: 'Compact Kiro\'s conversation history' },
    { name: 'help', description: 'Show Kiro\'s commands' },
  ],
  aider: [
    { name: 'ask', description: 'Ask about the code without editing any files', hint: '<question>' },
    { name: 'architect', description: 'Plan with the main model, edit with the editor model', hint: '<request>' },
    { name: 'code', description: 'Ask for changes to the code', hint: '<request>' },
    { name: 'context', description: 'Answer with the surrounding code in view', hint: '<request>' },
    { name: 'run', description: 'Run a shell command and add its output to the chat', hint: '<command>' },
    { name: 'test', description: 'Run a test command; failures go to the model to fix', hint: '<command>' },
    { name: 'lint', description: 'Lint and fix the changed files' },
    { name: 'commit', description: 'Commit edits made outside the chat', hint: '[message]' },
    { name: 'diff', description: 'Show the changes since the last message' },
    { name: 'git', description: 'Run a git command', hint: '<args>' },
    { name: 'web', description: 'Read a web page into the chat', hint: '<url>' },
    { name: 'tokens', description: 'Show how many tokens the chat context uses' },
    { name: 'map', description: 'Print the repository map' },
    { name: 'ls', description: 'List the files Aider knows and which are in the chat' },
    { name: 'settings', description: 'Print Aider\'s current settings' },
    { name: 'help', description: 'Ask a question about Aider', hint: '<question>' },
  ],
};

/** Commands a harness lists but does not run when ClikCode sends them: its
 * model answers the text instead (checked 2026-11-14). Left out of the menu,
 * so choosing one never spends a model turn on a command that did nothing. */
const LISTED_NOT_RUN: Readonly<Record<string, readonly string[]>> = {
  hermes: ['usage'],
  goose: ['prompts'],
};

export function runnableHarnessCommands(command: string | undefined, listed: readonly HarnessAvailableCommand[]): readonly HarnessAvailableCommand[] {
  const skip = command ? LISTED_NOT_RUN[command] : undefined;
  return skip?.length ? listed.filter((item) => !skip.includes(item.name.replace(/^\//, '').toLowerCase())) : listed;
}

export function declaredHarnessCommands(command: string | undefined): readonly HarnessAvailableCommand[] {
  return command ? DECLARED[command] ?? [] : [];
}
