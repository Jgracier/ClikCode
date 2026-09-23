/** A ClikCode slash command typed while a turn was still running.
 *
 * It cannot simply run there and then: a picker takes the whole screen, and
 * several commands change what the turn in flight is doing. And it must not be
 * sent to the model either, which is what used to happen -- `/model` arrived
 * at the harness as the literal word "/model". So it is queued like a message
 * and dispatched by the interactive loop the moment the turn ends, as the
 * command it is, with the screen to itself.
 *
 * What counts as a command is decided HERE and not in the composer, because
 * only routeSlashInput can tell `/model` from `/etc/hosts explain this` -- it
 * needs the session, the harness and the filesystem. A line that turns out to
 * be conversation is queued as conversation, exactly as before.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readState } from '../../session/state/read.js';
import { writeState } from '../../session/state/write.js';
import { enqueueSessionTurn } from '../../turn/checkpoint.js';
import type { LiveTurnInputResult } from '../../turn/live-input.js';
import { expandHomePath } from '../../session/attachments.js';
import { routeSlashInput, type SlashRouteContext } from './registry.js';
import { sessionHarness, slashRouteContextFor } from './context.js';

/** Whether this line is ClikCode's own command, or words for the model. The
 * context is the caller's because building one needs the harness catalog;
 * the decision itself is just the router plus one rule.
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

export async function queueCommandDuringTurn(sessionId: string, line: string): Promise<LiveTurnInputResult> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === sessionId);
  if (!session) throw new Error(`AI session "${sessionId}" was not found`);
  const submission = {
    id: randomUUID(), text: line, submittedAt: new Date().toISOString(),
    ...(slashLineIsCommand(line, slashRouteContextFor(
      session, sessionHarness(session), (path) => existsSync(expandHomePath(path)),
    )) ? { kind: 'command' as const } : {}),
  };
  enqueueSessionTurn(session, submission, submission.submittedAt);
  await writeState(state);
  return { disposition: submission.kind === 'command' ? 'command' : 'queued', submission };
}
