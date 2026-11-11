/** Keys typed while a turn runs: scroll, approval and question answers, stop and take-back, sign-in answers and the waiting composer. */
import { isKeyShaped } from '../../gateway/login/vendor-sign-in.js';
import { backslashNewline } from '../composer-edit.js';
import { approvalKey } from './approvals.js';
import { draftKey } from './composer.js';
import { waitingEnterAction, waitingInputAction } from '../input-decoder.js';
import { SWIPE_ROWS } from '../modes.js';
import type { TerminalHarnessPrompter } from '../prompter.js';
import type { ArrowSource } from '../swipe-arrows.js';

export function onWaitingKey(this: TerminalHarnessPrompter, key: string): void {
  const turn = this.turn;
  if (!turn) return;
  // Up/Down: a swipe or a key press (swipe-arrows.ts). A held arrow goes to the turn it was typed into, or nowhere. A sub-agent's
  // full view is its own screen (its arrows step between siblings) and takes its keys as they come.
  if (!this.subView && this.swipeArrows.route(key, (arrow, source) => { if (this.turn === turn) waitingKey.call(this, turn, arrow, source); })) return;
  waitingKey.call(this, turn, key, 'key');
}

function waitingKey(this: TerminalHarnessPrompter, turn: NonNullable<TerminalHarnessPrompter['turn']>, key: string, source: ArrowSource): void {
  const draft = this.composer;
  // The terminal can lose cells during a mobile resize or a remote redraw.
  if (key === '\u000c') { this.repairScreen(); return; }
  // A sub-agent open in full view takes every key; none of them reaches the
  // main turn (Esc and Ctrl+C go back to the main chat, they do not stop it).
  if (this.subView) { this.subViewKey(key); return; }
  // Right on an empty composer opens a running sub-agent's own screen.
  if (key === '\u001b[C' && !draft.text && !this.pendingApproval && this.openSubView()) return;
  // Otherwise Right on an empty composer opens the command menu, as it does when no turn runs.
  if (key === '\u001b[C' && !draft.text && !this.pendingApproval && turn.command && !this.signInInput) {
    draft.set('/');
    this.echoDraft();
    return;
  }
  // Before approvals and before the draft: a turn running is when someone
  // wants to read what went past.
  // An approval does not stop the reading either: what the call is about is often a few rows up. Scrolling keys never answer
  // it; the 400 ms guard and the answer keys are approvalKey's, below.
  if (this.handleScrollKey(key)) return;
  // A swipe's arrows scroll and do nothing else: not an approval's or a question's choice, not the draft's cursor.
  if (source === 'swipe') {
    this.scrollTranscript(key === '\u001b[A' ? SWIPE_ROWS : -SWIPE_ROWS);
    return;
  }
  // A plain approval (no list, no text being typed to it) has no use for the arrows and Home/End, so they scroll.
  if (this.pendingApproval && !this.pendingApproval.question && !this.tellingInstead) {
    if (key === '\u001b[A' || key === '\u001b[B') {
      this.scrollTranscript(key === '\u001b[A' ? SWIPE_ROWS : -SWIPE_ROWS);
      return;
    }
    if (key === '\u0001' || key === '\u0005') {
      this.scrollTranscript(key === '\u0001' ? Number.MAX_SAFE_INTEGER : -Number.MAX_SAFE_INTEGER);
      return;
    }
  }
  // Escape backs out one level. Scrolled back mid-turn it returns to the
  // live edge -- with an approval or a question waiting too: the arrows
  // read back over one, and the Esc that came back from reading denied it
  // and stopped the turn. At the edge a waiting message comes back to edit.
  // With none, a prompt that has no answer yet comes back too, and a turn
  // that has started answering stops. Ctrl+C stops either way.
  if (key === '\u001b' && this.scrolledBack) {
    this.scrollTranscript(-Number.MAX_SAFE_INTEGER);
    return;
  }
  // The command menu is an overlay: Esc closes it (and the slash line with
  // it) and goes no further. Only with nothing open does Esc reach the turn.
  if (!this.pendingApproval && !this.signInInput && key === '\u001b' && this.waitingPalette(turn).length) {
    draft.clear();
    this.echoDraft();
    return;
  }
  if (this.pendingApproval?.question) {
    this.questionKey(turn, this.pendingApproval, key);
    return;
  }
  // Esc and Ctrl+C on an approval deny it AND stop the turn, at once (no
  // guard window): denying alone let the model go on to its next call.
  let stopWithApproval = false;
  if (this.pendingApproval && (key === '\u001b' || key === '\u0003')) {
    this.restoreTellingDraft();
    // The ones queued behind it are denied with it, not shown one by one.
    for (const queued of this.approvalQueue.splice(0)) queued.resolve(false);
    this.answerApproval(this.pendingApproval, false);
    stopWithApproval = true;
  } else if (this.pendingApproval) {
    approvalKey.call(this, turn, this.pendingApproval, key);
    return;
  }
  // Left with nothing typed steps away from the turn -- to the conversation
  // board -- and leaves it running: the worker owns it, not this window.
  if (key === '\u001b[D' && !draft.text && turn.leave) {
    turn.leave();
    return;
  }
  const action = stopWithApproval ? 'stop' : waitingInputAction(key);
  // A repeated Stop goes through to the worker (it ends a Stop that is not
  // ending the turn); only a wait this window runs itself stops once.
  const stoppedHere = turn.cancelled && !turn.submit && !turn.early;
  if (action === 'take-back') {
    if (this.takeBackWaiting()) return;
    // A download, a shell, or a sign-in is not the conversation: Esc leaves
    // it. A conversation turn with no answer yet comes back to edit; one
    // that has started answering stops.
    if (stoppedHere) return;
    // A sign-in, the turn's or its own: Esc cancels it (its outcome line
    // says so, and the message that opened it comes back).
    if (this.signingIn) {
      turn.cancelled = true;
      this.updateWaiting();
      turn.cancel?.(false, 'sign-in-esc');
      return;
    }
    if (!turn.submit && !turn.early) return;
    // "stopping" is shown when the worker says it accepted the Stop (turnStopping).
    const restoreDraft = !this.turnHasAnswer();
    if (turn.early) turn.early.interrupt = { restoreDraft, trigger: 'esc' };
    turn.cancel?.(restoreDraft, 'esc');
  } else if (action === 'stop') {
    if (stoppedHere) return;
    // A conversation turn shows "stopping" when its worker says so
    // (turnStopping); any other wait (a download, a shell) is this window's own.
    if (!turn.submit && !turn.early) { turn.cancelled = true; turn.stopLabel = 'stopping…'; this.scheduleWaitingTick(); this.updateWaiting(); }
    // A turn that did nothing yet gives its prompt back to edit -- unless
    // something is already typed, which keeps the composer.
    const restoreDraft = !draft.text.trim();
    if (turn.early) turn.early.interrupt = { restoreDraft, trigger: 'ctrl-c' };
    turn.cancel?.(restoreDraft, 'ctrl-c');
  } else if (key === '\u001a') {
    this.suspendToShell();
  } else if (key === '\r' && this.signInInput && (!this.signInInput.alongside || isKeyShaped(draft.expanded().trim()) || (!draft.text.trim() && this.signInInput.optional))) {
    // A key pasted beside the vendor's sign-in is the sign-in's; anything
    // else typed there is the user's next message (the branch below).
    const text = draft.expanded().trim();
    // A stray Enter answers nothing -- unless the question takes none (a
    // key-first sign-in's Enter for the vendor's own providers).
    if (!text && !this.signInInput.optional) return;
    draft.clear();
    this.signInInput.submit(text);
    this.updateWaiting();
  } else if (this.signingIn && !turn.submit && (key === '\r' || this.typedAhead.length)) {
    // Sent under a sign-in: the message stays in the composer, on screen,
    // and only its Enter waits -- for the turn or prompt that comes next.
    if (key === '\r' && !this.typedAhead.length && !draft.text.trim()) return;
    this.typedAhead.push(key);
  } else if (key === '\r') {
    const continued = turn.submit ? backslashNewline(draft.text, draft.cursor) : undefined;
    if (continued) {
      draft.set({ value: continued.value, cursor: continued.cursor, held: draft.held });
      this.echoDraft();
      return;
    }
    if (!turn.submit) return;
    // Enter again, nothing typed, on a message already waiting: it goes
    // into the chat at the next pause. The turn, and any sub-agent it
    // started, keeps running.
    const enter = waitingEnterAction(draft.text, this.enterAgainReady(), Boolean(turn.sendWaiting) && !turn.cancelled);
    if (enter === 'send-waiting') {
      turn.sendWaiting!();
      return;
    }
    if (enter !== 'deliver') return;
    const text = draft.expanded().trim();
    draft.clear();
    this.submitWaiting(text);
  } else if (this.signInInput && !this.signInInput.alongside) {
    // A sign-in's code or key, typed in the composer the draft was set aside from: plain text, a paste as it is.
    this.editTurnDraft(key);
  } else if (turn.submit || turn.early || this.signingIn) {
    // The draft, by the composer's own rules (composer.ts draftKey): the same keys as at rest. A sign-in's wait keeps what is
    // typed under it too: it is the composer's, and still there when the next prompt or turn opens.
    if (draftKey(this, draft, key) === 'edit') this.echoDraft();
  }
}
