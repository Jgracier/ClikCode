/** The conversation board the window opens on Left, and where a turn joined mid-way already is. */
import type { PickerOption } from '../../../harness/prompter.js';
import type { HarnessSession } from '../../../session/model.js';
import { runningActivityLabel } from '../../../turn/checkpoint.js';

/** Kept out of the terminal's list: ← on an empty prompt is the
 * conversation board, so a /resume row only crowded it. Typed, it still
 * opens the board. */
export const BOARD_OWNS: ReadonlySet<string> = new Set(['resume']);
export const DELETED_ELSEWHERE = 'That conversation was deleted · this is a new one';
/** What Left on an empty prompt returns: not a slash line, so it cannot be
 * typed, and it opens the board however the registry changes. */
export const BOARD_LINE = '\u0000board';

/** Where a turn this window joins mid-way already is: when it started and
 * what it is running, from its journal -- only when that journal is the turn
 * being followed. */
export function joinedTurn(session: HarnessSession, runningPrompt: string | undefined): { startedAt?: number; activity?: string } | undefined {
  const pending = session.pendingTurn;
  if (!pending || (runningPrompt !== undefined && pending.prompt.trim() !== runningPrompt.trim())) return undefined;
  const startedAt = Date.parse(pending.startedAt);
  const activity = runningActivityLabel(pending);
  return { ...(Number.isNaN(startedAt) ? {} : { startedAt }), ...(activity ? { activity } : {}) };
}

/** What a `/` offers on the conversation board: the settings a new
 * conversation starts with. */
export const BOARD_COMMANDS: readonly PickerOption<string>[] = [
  { label: '/provider', detail: '· the harness the new conversation runs in', value: '/provider' },
  { label: '/model', detail: '· its model', value: '/model' },
  { label: '/effort', detail: '· its reasoning effort', value: '/effort' },
];
