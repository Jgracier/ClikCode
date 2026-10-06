/** What every turn driver (vendor-turn, agent-turn, direct-turn) writes the
 * same way: the streamed answer and
 * activity, the vendor's stop reason, and the turn's invocation record. */
import { randomUUID } from 'node:crypto';
import { stdout as output } from 'node:process';
import chalk from 'chalk';
import { isJsonDefaultMode } from '../cli/output-mode.js';
import type { HarnessActivityEvent } from '../harness/prompter.js';
import { renderActivityLine } from '../harness/protocol/activity-line.js';
import { stopReasonNotice, type TurnStopReason, type TurnUsage } from '../harness/protocol/turn-usage.js';
import type { HarnessState } from '../session/model.js';
import type { StreamingTitle } from '../session/title.js';
import type { DurableTurnCheckpoint } from './turn-journal.js';
import type { TurnObserver } from './observer.js';

type Invocation = HarnessState['invocations'][number];

/** One turn in the invocation log, however many attempts it took: who
 * answered, how long it took, and what it used. */
export function recordInvocation(state: HarnessState, turn: {
  sessionId: string; accountId: string; provider: string; model?: string | null;
  startedAt: number; usage?: TurnUsage; contextProfile?: string;
}): Invocation {
  const { usage } = turn;
  const invocation: Invocation = {
    id: randomUUID(), sessionId: turn.sessionId, accountId: turn.accountId, provider: turn.provider,
    ...(turn.model ? { model: turn.model } : {}),
    at: new Date().toISOString(), latencyMs: Date.now() - turn.startedAt,
    ...(usage?.input !== undefined ? { inputTokens: usage.input } : {}),
    ...(usage?.output !== undefined ? { outputTokens: usage.output } : {}),
    ...(usage?.cacheRead !== undefined ? { cacheReadTokens: usage.cacheRead } : {}),
    ...(usage?.totalTokens !== undefined ? { totalTokens: usage.totalTokens } : {}),
    ...(usage?.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
    ...(usage?.credits !== undefined ? { credits: usage.credits } : {}),
    ...(turn.contextProfile ? { contextProfile: turn.contextProfile } : {}),
  };
  state.invocations.push(invocation);
  return invocation;
}

/** An answer the vendor cut short says so, beside the answer. */
export function showStopReason(prompter: TurnObserver | undefined, reason: TurnStopReason | undefined): void {
  const stopped = stopReasonNotice(reason);
  if (stopped && prompter) prompter.activity(chalk.yellow(stopped));
  else if (stopped && !isJsonDefaultMode()) process.stderr.write(`${chalk.yellow(stopped)}\n`);
}

/** An activity row: on the prompter, or as a line on stdout headless. */
export function showActivity(prompter: TurnObserver | undefined, event: HarnessActivityEvent): void {
  if (prompter) prompter.activityEvent(event);
  else if (!isJsonDefaultMode()) for (const activity of renderActivityLine(event)) output.write(`${activity}\n`);
}

/** Where a turn's streamed answer and activity go: the answer through the
 * title filter (`title`, read per delta: a retry replaces the stream), then
 * to the checkpoint and to the screen alike, so what is shown and what is
 * saved cannot differ. `keep` may refuse a delta the filter let through. */
export function turnSink(checkpoint: Pick<DurableTurnCheckpoint, 'response' | 'activity'>, prompter: TurnObserver | undefined, options: {
  title?: () => StreamingTitle | undefined;
  keep?: (visible: string, mode: 'append' | 'replace') => boolean;
} = {}) {
  return {
    response(text: string, mode: 'append' | 'replace' = 'append'): void {
      const titleStream = options.title?.();
      const visible = titleStream ? titleStream.push(text, mode) : text;
      // undefined: the title filter is still holding the head back. '': a
      // replace arrived before that question was settled. Either one used to
      // be written through, and an empty replace clears the answer already
      // on screen -- the reply flashed, then was gone.
      if (!visible || (options.keep && !options.keep(visible, mode))) return;
      checkpoint.response(visible, mode);
      prompter?.response(visible, mode);
    },
    activity(event: HarnessActivityEvent): void {
      checkpoint.activity(event);
      showActivity(prompter, event);
    },
  };
}
