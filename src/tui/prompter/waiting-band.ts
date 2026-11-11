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
import { inlineHistoryMode } from '../inline.js';

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
    && !this.scrolledBack && !this.waitingPalette(turn).length && !(turn.takeBack && this.waitingUserMessages().length));
}

export function updateWaiting(this: TerminalHarnessPrompter): void {
  if (!this.turn || !this.canPaint()) return;
  this.schedulePaint();
}

/** Token deltas, spinner ticks, tool events, phases, and usage refreshes can
 * all arrive in the same few milliseconds. One shared scheduler collapses
 * those signals into a single atomic frame instead of queueing competing
 * terminal writes that briefly expose half-updated cursor/footer state. */
export function schedulePaint(this: TerminalHarnessPrompter, delay = PAINT_COALESCE_MS): void {
  if (this.responsePaintTimer || !this.canPaint()) return;
  this.responsePaintTimer = setTimeout(() => {
    this.responsePaintTimer = undefined;
    this.paintCurrent();
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
  this.paintCurrent();
}

/** The waiting frame, with the slash palette when one is being typed.
 *
 * A hint list, not a picker: there is no selection to move, and Enter runs
 * what was typed. Without this a command was invisible AND unavailable while
 * an answer streamed; `/model` went to the model as the word "/model". */
export function waitingPalette(this: TerminalHarnessPrompter, turn: WaitingTurn) {
  const draft = this.composer.text;
  const found = turn.command ? commandPaletteMatches(draft, this.paletteCommands) : [];
  // Commands while nothing has been typed past the name; the argument's
  // own values once it has. A bare hint row is not worth the space mid-turn.
  return !draft.includes(' ') || found[0]?.completes ? found : [];
}

/** The composer as a turn shows it: a secret answer (a question's, a sign-in's key) as dots, the palette's hints under a `/`. */
export function paintWaiting(this: TerminalHarnessPrompter, turn: WaitingTurn): void {
  const { text, cursor } = this.composer;
  const asking = this.pendingApproval?.question?.state;
  if (asking?.typing && asking.question.secret && asking.question.maskInput !== false) {
    this.paint('•'.repeat(text.length), [], 0, '› ', cursor);
    return;
  }
  if (this.signInInput && (!this.signInInput.alongside || isKeyShaped(this.composer.expanded()))) {
    this.paint(this.signInInput.secret ? '•'.repeat(text.length) : text, [], 0, '› ', cursor);
    return;
  }
  const matches = this.waitingPalette(turn);
  if (!matches.length) {
    this.paint(text, [], 0, '› ', cursor);
    return;
  }
  this.paint(text, matches, 0, '› ', cursor, {
    capacity: Math.min(matches.length, 8) + 2,
    hint: `${keyHint('apply')} · ${keyHintFor('esc', 'close')} · ${keyHint('stop')}`,
  });
}

/** The chat as it is now, drawn: the one way every path that is not a single edit's echo repaints -- a coalesced paint, a scroll,
 * a selection, a notice expiring, a snapshot, the return from Ctrl+Z or a vendor's login. A turn's band (its draft masked where
 * it is a secret, its palette); the prompt open at rest (its draft, palette and selection); else the draft alone. Nothing is
 * drawn from a copy of what a frame once showed, so nothing stale -- a finished prompt's draft, a secret in plain text -- can come
 * back. Only while the chat has the screen: an open picker draws its own frames. */
export function paintCurrent(this: TerminalHarnessPrompter): void {
  if (!this.canPaint()) return;
  if (this.turn) this.paintWaiting(this.turn);
  else if (this.restingPrompt) this.restingPrompt.draw();
  else this.paint(this.composer.text, [], 0, '› ', this.composer.cursor);
}

/** The screen drawn again by whoever has it (a resize): an open picker's frame as it last drew it, else the chat (paintCurrent). */
export function redrawScreen(this: TerminalHarnessPrompter): void {
  if (this.screenOwner !== 'picker') { this.paintCurrent(); return; }
  const { text, options, selected, prompt, cursor, palette } = this.drawnComposer;
  this.paint(text, options, selected, prompt, cursor, palette);
}

/** The next frame repairs the screen: it is cleared and drawn whole from what this program keeps. Inline, where the conversation
 * is in the terminal's own scrollback, that is the conversation written again (as a new width writes it). */
export function repairNext(this: TerminalHarnessPrompter): void {
  this.requestRedraw('repair');
  this.forgetScreenPosition();
  if (inlineHistoryMode()) this.emitted.requestReseed();
}

/** Ctrl+L: the terminal lost cells (a mobile resize, a remote redraw). The screen is drawn again whole, now -- the turn and the
 * draft untouched. */
export function repairScreen(this: TerminalHarnessPrompter): void {
  this.repairNext();
  this.redrawScreen();
}
