/** How a running conversation reads in the conversation list: the dot, the
 * pace of its turn, and the sub-agents it has running.
 *
 * The look follows Claude Code's own session list -- sections with their size
 * beside them, a dot per running session, and a pace that turns from flowing
 * to slowing to stuck as a turn goes quiet -- with conversations where it has
 * background jobs. The thresholds are in harness/protocol/turn-pace.ts. */

import chalk from 'chalk';
import { waitingSpinnerGlyph } from '../render/waiting.js';
import { shortDuration } from '../../harness/protocol/format.js';
import { turnPace, type TurnPace } from '../../harness/protocol/turn-pace.js';
import type { PickerOption } from '../../harness/prompter.js';
import type { HarnessSession } from '../../session/model.js';

const PACE_COLOR: Record<TurnPace, (text: string) => string> = {
  flowing: chalk.green, slowing: chalk.yellow, stuck: chalk.red,
};

/** The mark a row starts with: a coloured dot for a turn in flight, a hollow
 * one for a conversation open between turns, and blank space for one to
 * resume, so every title starts in the same column. */
export function activityGlyph(activity: 'working' | 'idle' | undefined, pace?: TurnPace): string {
  if (activity === 'working') return PACE_COLOR[pace ?? 'flowing']('●');
  if (activity === 'idle') return chalk.dim('○');
  return ' ';
}

/** The detail a working conversation leads with: how long, whether it has
 * gone quiet, and how many sub-agents it has out. */
export function workingDetail(pending: NonNullable<HarnessSession['pendingTurn']>, now: number): string {
  const pace = turnPace(pending.updatedAt, now);
  const agents = pending.subagents ?? [];
  const providers = agents.filter((agent) => agent.provider).length;
  const count = agents.length;
  const word = providers && providers === count ? 'provider' : 'subagent';
  return [
    `· working ${shortDuration(now - Date.parse(pending.startedAt))}`,
    ...(pace === 'flowing' ? [] : [PACE_COLOR[pace](pace)]),
    ...(count ? [`${count} ${word}${count === 1 ? '' : 's'} ←`] : []),
  ].join(' · ');
}

/** A conversation's running sub-agents as rows of their own. Each opens the
 * conversation it belongs to: that is where its work is shown. */
export function subagentOptions(
  pending: NonNullable<HarnessSession['pendingTurn']>, conversationValue: string, now: number,
): PickerOption<string>[] {
  return (pending.subagents ?? []).map((agent) => {
    const pace = turnPace(agent.stepAt ?? agent.startedAt, now);
    return {
      label: `${PACE_COLOR[pace]('●')} ${agent.label}`,
      detail: [
        `· ${agent.step ?? 'starting'}`,
        shortDuration(now - Date.parse(agent.startedAt)),
        ...(pace === 'flowing' ? [] : [pace]),
      ].join(' · '),
      value: conversationValue,
    };
  });
}

/** A running turn's spinner in the conversation list: the same two-cell
 * spinner as the waiting line, coloured by how the turn is going. */
export function workingSpinner(frame: number, pace: TurnPace): string {
  return PACE_COLOR[pace](waitingSpinnerGlyph(frame));
}
