/** How the panel lays out a turn as it unfolds: turn-flow.ts's shared rules
 * (the terminal's too) applied to the chat model, with the few choices only
 * a webview makes -- which colour class a status wears. Pure, and free of
 * anything that styles a terminal, so the page bundles it. */
import { turnStatus, type StatusTone } from '../../../../src/harness/protocol/turn-flow';
import { TOOL_CATEGORY } from '../../../../src/harness/protocol/tool-category';
import type { LiveTurn } from '../model';
import { titleCase } from './format';

export interface WorkingStatus {
  /** As shown: `Reading app.ts…`, `Waiting for you…`. */
  label: string;
  tone: StatusTone;
  /** How far silence has taken the line toward red, 0..1. */
  stall: number;
  /** The colour class: thinking blue, the running call's own colour, the
   * permission colour while asking. */
  toneClass: string;
}

/** The working line, by turn-flow's rule: waiting on the user, else the open
 * call's verb, else the reasoning's heading, else how long the model has
 * thought, in words. */
export function workingStatus(live: LiveTurn | undefined, asking: boolean, now: number): WorkingStatus {
  const status = turnStatus({
    phase: live ? live.phase ?? live.waitingLabel : 'starting',
    ...(live?.toolPhase ? { toolPhase: live.toolPhase } : {}),
    ...(live?.thought ? { thought: live.thought.text } : {}),
    thinkingMs: live ? now - (live.thinkingSince ?? live.startedAt) : 0,
    asking,
    quietMs: live ? now - (live.lastEventAt ?? live.startedAt) : 0,
  });
  const open = live?.openTools[live.openTools.length - 1]?.[1];
  const toneClass = status.tone === 'asking' ? 'tone-permission'
    : status.tone !== 'tool' ? 'tone-cyan'
      : open?.agent ? 'tone-cyan' : open?.category ? `tone-${TOOL_CATEGORY[open.category].colour}` : 'tone-plain';
  return { ...status, label: `${titleCase(status.label.replace(/(…|\.\.\.)$/, '').trim() || 'working')}…`, toneClass };
}
