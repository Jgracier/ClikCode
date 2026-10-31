/** The status and waiting rows, and when a frame is painted: coalesced repaints, the waiting-band repaint and the resting repaint. */
import chalk from 'chalk';
import { isKeyShaped } from '../../gateway/login/vendor-sign-in.js';
import { commandPaletteMatches } from '../command-palette.js';
import { terminalCellWidth, visiblePathTail, visibleSlice } from '../render/width.js';
import { compactPath, sessionProviderLabel } from '../../harness/protocol/labels.js';
import { sessionModelLabel } from '../../harness/output.js';
import { isGatewayService } from '../../session/route.js';
import { harnessSupportsEffort, localHarnessForCommand } from '../../runtime/lazy-bridge.js';
import { nativeModelLabel } from '../../harness/accounts/model-catalog.js';
import { localModelLabel } from '../../local-models/catalog.js';
import { turnElapsedMs, waitingSpinnerGlyph } from '../../harness/protocol/activity-view.js';
import { answerWriting, turnStatus, waitingOnCommands } from '../../harness/protocol/turn-flow.js';
import { paintStatus } from '../render/status-line.js';
import { PAINT_COALESCE_MS } from '../../harness/protocol/timings.js';
import { formatElapsed } from '../../harness/protocol/format.js';
import { keyHint, keyHintFor } from '../../harness/protocol/wording.js';
import type { TerminalHarnessPrompter } from '../prompter.js';
import { WaitingTurn } from './state.js';

/** The line under the composer, fitted to `width`: a narrow screen
 * shortens the directory from the left (`…/clikcode`) before anything. */
export function statusText(this: TerminalHarnessPrompter, width: number): string {
  const session = this.currentSession;
  if (!session) return '';
  const path = compactPath(session.workspace ?? process.cwd());
  const provider = sessionProviderLabel(session);
  const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
  // What the harness reported running beats what it was asked to run: a
  // session with no explicit choice knows nothing until the vendor
  // answers, and a vendor that substituted a model said so on its own
  // stream. Never a synthetic label: there is no model named "automatic",
  // and none named "default" either -- that placeholder was just the same
  // lie under a quieter name. A session's model is resolved to something
  // the harness really publishes when the harness is chosen and when the
  // session opens (resolveNativeModel), so an empty one here means the
  // harness publishes nothing at all. Showing no model is honest; showing
  // a fabricated one is not.
  const rawModel = harness?.modelArgvPrefix ? session.reported?.model ?? session.model ?? undefined : undefined;
  // A Gateway conversation shows the model that answered, as a vendor's
  // report of its own model is shown: the one chosen, or for Automatic the
  // Gateway's pick, named once its first frame says which. ClikCode Local's
  // model is its engine's catalog entry, named by label.
  const model = session.route === 'clikcode-local' ? localModelLabel(session.model)
    : isGatewayService(session) ? sessionModelLabel(session, session.reported?.model ?? session.model) : nativeModelLabel(harness?.command, rawModel);
  const effort = harness && harnessSupportsEffort(harness) ? session.effort : undefined;
  // The title is not on this line: it sits on the rule under the composer,
  // so a long one never truncates the provider, model or directory.
  const lead = [this.remoteMachineName, provider, [model, effort].filter(Boolean).join(' ')].filter(Boolean).join('  •  ');
  const context = visiblePathTail(path, Math.max(12, width - terminalCellWidth(lead) - 5));
  return visibleSlice([lead, context].filter(Boolean).join('  •  '), width);
}

/** `⠋  Reading prompter.ts · 1m 12s`: what the turn is doing and how long
 * it has taken -- the style of a native CLI's own status row -- driven by
 * what actually arrives: the open call names the verb, the clock stops for
 * an approval. The spinner turns yellow once the turn has gone quiet.
 *
 * No token meter: the spinner, one word and the clock, then the key that
 * acts on the wait -- `esc stop`, or a sign-in's `esc cancel`. */
export function waitingLine(this: TerminalHarnessPrompter, turn: WaitingTurn, width: number): string {
  const now = Date.now();
  const elapsed = formatElapsed(turnElapsedMs(turn.clock, now));
  // What it says and how it looks, by the shared rules (turn-flow.ts):
  // waiting on the user, the open call, the reasoning's heading, or the
  // phase the turn reported. The clock stays on this line. The call's row
  // does not keep a second one.
  const tool = this.toolStatus();
  const status = turnStatus({
    phase: turn.label,
    ...(!turn.cancelled && tool ? { toolPhase: tool.phase } : {}),
    ...(this.thought && !turn.cancelled ? { thought: this.thought.text } : {}),
    asking: Boolean(this.pendingApproval),
    writing: answerWriting({ writingAt: turn.writingAt, callAt: turn.callAt }),
    // Only background commands running: say what is waited on, not 'thinking'.
    ...(!turn.cancelled && !tool && !this.thought && waitingOnCommands(this.backgroundWork?.commands) ? { waitingOn: waitingOnCommands(this.backgroundWork?.commands)! } : {}),
  });
  // An approval or a sign-in: the wait is on the user.
  const asking = this.waitingOnUser();
  // What the agent is doing is essential and stays at full contrast; the
  // clock is dimmed. Waiting on the user stops the clock, so it is not shown.
  const rest = asking ? '' : ` · ${elapsed}`;
  // One spinner, one motion, for every harness and every tool, the label
  // shimmering with it. An approval is the turn waiting on the user, not
  // working: a still dot, and no clock (it is stopped).
  const glyph = asking ? '●' : waitingSpinnerGlyph(this.reducedMotion ? 0 : this.waitingFrame);
  // A Stop in flight says so -- but never over a question that is still open.
  const label = turn.stopLabel && !asking ? turn.stopLabel : status.label;
  const painted = paintStatus({
    glyph, label, tone: status.tone,
    frame: this.waitingFrame, shimmer: !this.reducedMotion && !turn.cancelled && this.waitingTickFast && status.tone !== 'asking',
  });
  const line = `${painted.spinner}${asking ? ' ' : '  '}${painted.label}${chalk.dim(rest)}`;
  // A sign-in's wait: Esc cancels it. Otherwise Esc stops the turn, while it would.
  const cancels = this.signingIn && !turn.cancelled;
  const hint = ` · ${cancels ? keyHintFor('esc', 'cancel') : keyHint('escStop')}`;
  return (cancels || this.escStops()) && terminalCellWidth(line) + terminalCellWidth(hint) <= width ? `${line}${chalk.dim(hint)}` : line;
}

/** Esc would stop the running turn (see onWaitingKey): a conversation's
 * turn, not already stopping, with no approval or sign-in up, nothing
 * waiting for Esc to take back, and the view at the live edge. */
export function escStops(this: TerminalHarnessPrompter): boolean {
  const turn = this.turn;
  return Boolean(turn && (turn.submit || turn.early) && !turn.cancelled && !this.pendingApproval && !this.signingIn
    && !this.scrolledBack && !(turn.takeBack && this.waitingUserMessages().length));
}

export function updateWaiting(this: TerminalHarnessPrompter): void {
  if (!this.turn || this.closed || this.selecting || this.paletteActive) return;
  this.schedulePaint();
}

/** Token deltas, spinner ticks, tool events, phases, and usage refreshes can
 * all arrive in the same few milliseconds. One shared scheduler collapses
 * those signals into a single atomic frame instead of queueing competing
 * terminal writes that briefly expose half-updated cursor/footer state. */
export function schedulePaint(this: TerminalHarnessPrompter, delay = PAINT_COALESCE_MS): void {
  if (this.responsePaintTimer || this.closed || this.suspended || this.selecting || this.paletteActive) return;
  this.responsePaintTimer = setTimeout(() => {
    this.responsePaintTimer = undefined;
    // A resize burst in progress: the settled repaint draws the turn at its final size. A key's echo
    // does not come through here, so typing is never held.
    if (this.resizePaintTimer) return;
    if (!this.closed && !this.selecting && !this.paletteActive) {
      if (this.turn) this.paintWaiting(this.turn);
      else this.repaint();
    }
  }, delay);
  this.responsePaintTimer.unref();
}

/** A coalesced paint still pending, drawn now: a wait about to end draws
 * the lines added to it first, or they are gone with it (a remote chat's
 * busy line ending right after its last step notice). */
export function flushPaint(this: TerminalHarnessPrompter): void {
  if (!this.responsePaintTimer) return;
  clearTimeout(this.responsePaintTimer);
  this.responsePaintTimer = undefined;
  if (this.closed || this.suspended || this.selecting || this.paletteActive || this.resizePaintTimer) return;
  if (this.turn) this.paintWaiting(this.turn);
  else this.repaint();
}

/** The waiting frame, with the slash palette when one is being typed.
 *
 * A hint list, not a picker: during a turn Up/Down scroll the transcript
 * (which is the point -- reading what went past is why they are bound
 * there), so there is no selection to move and Enter runs what was typed.
 * Without this a command was invisible AND unavailable while an answer
 * streamed; `/model` went to the model as the word "/model". */
export function paintWaiting(this: TerminalHarnessPrompter, turn: WaitingTurn): void {
  const asking = this.pendingApproval?.question?.state;
  if (asking?.typing && asking.question.secret && asking.question.maskInput !== false) {
    this.paint('•'.repeat(turn.draft.length), [], 0, '› ', turn.cursor);
    return;
  }
  if (this.signInInput && (!this.signInInput.alongside || isKeyShaped(turn.draft))) {
    this.paint(this.signInInput.secret ? '•'.repeat(turn.draft.length) : turn.draft, [], 0, '› ', turn.cursor);
    return;
  }
  const found = turn.command ? commandPaletteMatches(turn.draft, this.paletteCommands) : [];
  // Commands while nothing has been typed past the name; the argument's
  // own values once it has. A bare hint row is not worth the space mid-turn.
  const matches = !turn.draft.includes(' ') || found[0]?.completes ? found : [];
  if (!matches.length) {
    this.paint(turn.draft, [], 0, '› ', turn.cursor);
    return;
  }
  this.paint(turn.draft, matches, 0, '› ', turn.cursor, {
    capacity: Math.min(matches.length, 8) + 2,
    hint: `${keyHint('apply')} · ${keyHint('stop')}`,
  });
}

/** Repaint with the composer exactly as the last paint left it -- with its
 * palette, or (`keepPalette: false`) without, since paint() reads an absent
 * palette as "there is none".
 *
 *  - KEEP the palette for an incremental repaint of an edit still in
 *    progress -- a resize, a coalesced paint, a scroll, a reading-direction
 *    change. The user is mid-`/command`; taking their palette away as the
 *    terminal reflows would be the bug.
 *  - CLEAR it where the composer is being re-established fresh and a stale
 *    palette would be wrong: a panel opening (paint() draws a panel only
 *    when no palette is up, so they are mutually exclusive), a turn ending,
 *    and resume() after a vendor has had the TTY -- the composer it repaints
 *    is a new one. In all three the palette belongs to a command that has
 *    already run. */
export function repaint(this: TerminalHarnessPrompter, options: { keepPalette: boolean } = { keepPalette: true }): void {
  const { text, options: listed, selected, prompt, cursor, palette } = this.composer;
  this.paint(text, listed, selected, prompt, cursor, options.keepPalette ? palette : undefined);
}
