/** How a running conversation reads in the conversation list: the dot, the
 * pace of its turn, and the sub-agents it has running.
 *
 * The look follows Claude Code's own session list -- sections with their size
 * beside them, a dot per running session, and a pace that turns from flowing
 * to slowing to stuck as a turn goes quiet -- with conversations where it has
 * background jobs. The thresholds are Claude Code's: three minutes, fifteen. */

import chalk from 'chalk';
import { waitingSpinnerGlyph } from '../render/waiting.js';
import type { PickerOption } from '../../harness/prompter.js';
import type { HarnessSession } from '../../session/model.js';

export type TurnPace = 'flowing' | 'slowing' | 'stuck';

const SLOWING_AFTER_MS = 3 * 60_000;
const STUCK_AFTER_MS = 15 * 60_000;

/** How long since the running turn last did anything -- streamed a word or
 * started a call. A long turn that is still moving is flowing; one that has
 * said nothing for fifteen minutes is stuck, however young it is. */
export function turnPace(lastActivityAt: string, now: number): TurnPace {
  const quiet = now - Date.parse(lastActivityAt);
  if (!(quiet >= SLOWING_AFTER_MS)) return 'flowing';
  return quiet < STUCK_AFTER_MS ? 'slowing' : 'stuck';
}

/** `45s`, `4m`, `2h 5m` -- compact, because it shares a row. */
export function shortDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

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
