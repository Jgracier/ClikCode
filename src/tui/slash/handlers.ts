/**
 * What each slash command does, with no terminal involved.
 *
 * Every command has a headless body here that returns text, so the same
 * `/usage` or `/export` works typed into the chat, piped through the control
 * API, or run as an argv subcommand. The implementations the longer ones
 * need live beside this file, one concern each.
 */

import { isClikCodeAgent } from '../../session/route.js';
import type { HarnessSession } from '../../session/model.js';
import { localHarnessForProvider } from '../../runtime/lazy-bridge.js';
import { readState } from '../../session/state/read.js';
import { emitHarnessOutput } from '../../harness/output.js';
import { routeSlashInput, unknownSlashMessage, type SlashHandlerKey, type SlashRoute } from './registry.js';
import { impliedHarnessCommand } from './infer-provider.js';
import type { AiLocalHarnessDefinition } from '../../harness/definition.js';
import { customCommandPrompt } from '../../session/custom-commands.js';
import { moveToProvider } from '../../commands/ai/conversations.js';
import { aiHarnessSelect } from '../../commands/ai/harness.js';
import { customCommandsFor, sessionHarness, slashRouteContextFor } from './context.js';
import { nativeManagerListing } from './native-manager.js';
import { isShellCommandLine, SHELL_HEADLESS_TIMEOUT_MS, shellMessageContent } from '../../commands/ai/shell-run.js';
import { conversationHandlers, lastAnswer } from './handlers/conversation.js';
import { modelHandlers } from './handlers/model.js';
import { settingsHandlers } from './handlers/settings.js';
import { accountsHandlers } from './handlers/accounts.js';
import { agentsHandlers } from './handlers/agents.js';
import { runShellLine } from './handlers/shell.js';
import { INTERACTIVE_ONLY, sendSessionTurn, type HeadlessSlashHandler } from './handlers/shared.js';

export { lastAnswer, runShellLine };

/** Headless half of the slash registry. Typed by SlashHandlerKey, so a
 * registry entry without a handler here (or a handler without an entry) does
 * not compile; slash-registry.vitest.test.ts asserts the same at runtime. */
const HEADLESS_SLASH_HANDLERS: Record<SlashHandlerKey, HeadlessSlashHandler> = {
  ...conversationHandlers,
  ...modelHandlers,
  ...settingsHandlers,
  ...accountsHandlers,
  ...agentsHandlers,
  init: (context) => HEADLESS_SLASH_HANDLERS.review(context),
  options: INTERACTIVE_ONLY('options'),
  provider: INTERACTIVE_ONLY('provider'),
  resume: INTERACTIVE_ONLY('resume'),
};

export async function aiSessionCommand(id: string, input: string, options: { inferred?: boolean; signal?: AbortSignal } = {}): Promise<string> {
  // Every command acts on this chat; any other chat is named by the index
  // (/resume, /sessions) and read on its own when shown.
  const state = await readState({ transcripts: [id] });
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  const text = input.trim();
  if (!text.replace(/^\/+/, '')) throw new Error('slash command is required');
  // A `!` line is a shell command, not a slash command: run it headlessly and
  // record it as a transcript message the same way the interactive loop does,
  // so piped/argv callers can ask for real machine state too.
  if (isShellCommandLine(text)) {
    const command = text.slice(1).trim();
    if (!command) throw new Error('Type `!<command>` to run it, e.g. `!git status`.');
    const note = await runShellLine(id, command, options.signal, { timeoutMs: SHELL_HEADLESS_TIMEOUT_MS });
    emitHarnessOutput({ panel: 'shell', text: shellMessageContent(note) });
    return id;
  }
  const harness = sessionHarness(session);
  const route = routeSlashInput(text.startsWith('/') ? text : `/${text}`, slashRouteContextFor(session, harness));
  if (route.kind === 'command') {
    const availability = route.entry.availability(session, harness, route.args);
    // Same as the interactive session: a command that names its provider --
    // `/model claude-opus-5` when only one account publishes that model --
    // selects it and runs, instead of refusing. Once only: a selection that
    // still leaves the command unavailable is a real refusal.
    if (!availability.available && availability.needs === 'provider' && !options.inferred) {
      const implied = impliedHarnessCommand(route, state.accounts, localHarnessForProvider);
      if (implied) {
        await aiHarnessSelect(implied, id);
        return aiSessionCommand(id, input, { ...options, inferred: true });
      }
    }
    if (!availability.available) throw new Error(availability.reason ?? `/${route.entry.name} is not available here.`);
    const moved = await HEADLESS_SLASH_HANDLERS[route.entry.handlerKey]({ id, state, session, head: route.entry.name, args: route.args, words: [...route.words] });
    return typeof moved === 'string' ? moved : id;
  }
  if (route.kind === 'harness') {
    // `/<harness> [request]`: the conversation moves there, and the request
    // runs there.
    await moveToProvider(id, route.command);
    if (route.args) await sendSessionTurn(id, route.args);
    return id;
  }
  if (route.kind === 'manager') {
    const listing = await nativeManagerListing(state, session, route.name);
    emitHarnessOutput({ panel: route.name, text: `${listing.label}\n\n${listing.text}` });
    return id;
  }
  const turn = slashRouteTurn(route, session, harness);
  if (turn) {
    await sendSessionTurn(id, turn.prompt);
    return id;
  }
  throw new Error('slash command is required');
}

/** The turn a slash line becomes, when it becomes one: a native command the
 * harness runs itself, or a custom command expanded into its prompt (not
 * echoed as if typed). An unknown command is refused here. One decision for
 * the interactive loop and the headless handler, which each run the turn
 * their own way. */
export function slashRouteTurn(
  route: SlashRoute, session: HarnessSession, harness: AiLocalHarnessDefinition | undefined,
): { prompt: string; echo: boolean } | undefined {
  if (route.kind === 'unknown') throw new Error(unknownSlashMessage(route));
  if (route.kind === 'native') {
    if (isClikCodeAgent(session)) throw new Error('Native harness commands apply only to local harnesses.');
    return { prompt: route.prompt, echo: true };
  }
  if (route.kind === 'custom') {
    const command = customCommandsFor(session, harness).find((item) => item.name === route.name);
    if (!command) throw new Error(`custom command /${route.name} is no longer available`);
    return { prompt: customCommandPrompt(command, route.args, harness), echo: false };
  }
  return undefined;
}

