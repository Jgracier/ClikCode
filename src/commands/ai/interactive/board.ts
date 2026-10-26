/** The conversation board the window opens on Left, and where a turn joined mid-way already is. */
import type { PickerOption } from '../../../harness/prompter.js';
import type { HarnessSession, HarnessState } from '../../../session/model.js';
import { withArgValues } from '../../../tui/slash/arg-values.js';
import { slashPalette } from '../../../tui/slash/registry.js';
import { sessionHarness, slashExtrasFor } from '../../../tui/slash/context.js';
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

/** The same commands and argument completions in a chat and before its first message. */
export function conversationCommands(session: HarnessSession, state: Pick<HarnessState, 'accounts' | 'sessions'>): PickerOption<string>[] {
  const harness = sessionHarness(session);
  return withArgValues(slashPalette(session, harness, { ...slashExtrasFor(session, harness), omit: BOARD_OWNS }), session, harness, state);
}
