/** A ClikCode slash command typed while a turn is still streaming.
 *
 * It applies at the earliest moment it can, with nothing announced:
 *
 *  - **now**, if its argument form is a pure state write -- `/model sonnet`,
 *    `/effort high`, `/permissions plan`, `/account work`. These need no
 *    picker and show no panel: their own handlers end in a `settings` payload,
 *    which in the TUI is a status-line render and nothing else, so the change
 *    simply appears where the model and mode are already shown. The running
 *    turn keeps the model and permission mode it was spawned with -- those are
 *    fixed in its argv and environment -- and the next turn uses the new ones.
 *  - **at the turn boundary** for everything else, because a picker or a panel
 *    needs the screen the answer is being written on. That is the next moment
 *    it could run, and it runs there silently: no queued row, no notice.
 *
 * What it must never be is what it was: sent to the harness as the literal
 * word "/model".
 *
 * What counts as a command is decided by routeSlashInput and not by the
 * composer, because only it can tell `/model` from `/etc/hosts explain this`
 * -- that needs the session, the harness and the filesystem. A line it calls
 * conversation is queued as conversation, exactly as before.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readState } from '../../session/state/read.js';
import { writeState } from '../../session/state/write.js';
import { enqueueSessionTurn } from '../../turn/checkpoint.js';
import type { LiveTurnInputResult } from '../../turn/live-input.js';
import { expandHomePath } from '../../session/attachments.js';
import { routeSlashInput, slashRouteAppliesDuringTurn, type SlashRouteContext } from './registry.js';
import { aiSessionCommand } from './handlers.js';
import { sessionHarness, slashRouteContextFor } from './context.js';

/** Whether this line is ClikCode's own command, or words for the model.
 *
 * 'native' is a line the harness itself answers as a prompt, and 'prompt' is
 * plain conversation (a real path, or something that only looked like a
 * command). Everything else -- a registry command, a vendor manager, a custom
 * command, a harness handoff, even an unknown head whose did-you-mean is worth
 * seeing rather than sending to a model -- is ClikCode's to run. */
export function slashLineIsCommand(line: string, context: SlashRouteContext): boolean {
  const route = routeSlashInput(line, context);
  return route.kind !== 'prompt' && route.kind !== 'native';
}

/** Hand a command line to the interactive loop, which runs it on its next
 * pass. Used for a command that cannot run where it was typed: mid-turn
 * (the screen belongs to the answer) or before the provider it needs was
 * chosen (the picker has to happen first). */
export async function enqueueCommandLine(sessionId: string, line: string): Promise<void> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === sessionId);
  if (!session) throw new Error(`AI session "${sessionId}" was not found`);
  const submission = { id: randomUUID(), text: line, submittedAt: new Date().toISOString(), kind: 'command' as const };
  enqueueSessionTurn(session, submission, submission.submittedAt);
  await writeState(state);
}

export async function commandDuringTurn(sessionId: string, line: string): Promise<LiveTurnInputResult> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === sessionId);
  if (!session) throw new Error(`AI session "${sessionId}" was not found`);
  const route = routeSlashInput(line, slashRouteContextFor(
    session, sessionHarness(session), (path) => existsSync(expandHomePath(path)),
  ));
  const submission = { id: randomUUID(), text: line, submittedAt: new Date().toISOString() };
  if (slashRouteAppliesDuringTurn(route)) {
    // Straight through to the same handler the composer would reach between
    // turns. It reads state itself, so nothing here writes first.
    await aiSessionCommand(sessionId, line);
    return { disposition: 'command', submission };
  }
  const isCommand = route.kind !== 'prompt' && route.kind !== 'native';
  const queued = { ...submission, ...(isCommand ? { kind: 'command' as const } : {}) };
  enqueueSessionTurn(session, queued, queued.submittedAt);
  await writeState(state);
  return { disposition: isCommand ? 'command' : 'queued', submission: queued };
}
