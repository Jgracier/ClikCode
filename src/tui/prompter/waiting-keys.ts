/** Keys typed while a turn runs: scroll, approval and question answers, stop and take-back, sign-in answers and the waiting composer. */
import { isKeyShaped } from '../../gateway/login/vendor-sign-in.js';
import { backslashNewline } from '../composer-edit.js';
import { approvalKey } from './approvals.js';
import { waitingEnterAction, waitingInputAction } from '../input-decoder.js';
import { SWIPE_ROWS } from '../modes.js';
import type { TerminalHarnessPrompter } from '../prompter.js';

export function onWaitingKey(this: TerminalHarnessPrompter, key: string): void {
  const turn = this.turn;
  if (!turn) return;
  // The terminal can lose cells during a mobile resize or a remote redraw.
  // Rebuild the whole viewport from our retained state, including the live
  // answer and any approval, without changing the turn or the draft.
  if (key === '\u000c') {
    this.requestRedraw('repair');
    this.forgetScreenPosition();
    this.paintWaiting(turn);
    return;
  }
  // A sub-agent open in full view takes every key; none of them reaches the
  // main turn (Esc and Ctrl+C go back to the main chat, they do not stop it).
  if (this.subView) { this.subViewKey(key); return; }
  // Right on an empty composer, on an open sub-agent row: its own screen.
  if (key === '\u001b[C' && !turn.draft && !this.pendingApproval && this.openSubView()) return;
  // Otherwise Right on an empty composer opens the command menu, as it does when no turn runs.
  if (key === '\u001b[C' && !turn.draft && !this.pendingApproval && turn.command && !this.signInInput) {
    turn.draft = '/';
    turn.cursor = 1;
    this.updateWaiting();
    return;
  }
  // Before approvals and before the draft: a turn running is when someone
  // wants to read what went past.
  if (!this.pendingApproval && this.handleScrollKey(key)) return;
  // Escape backs out one level. Scrolled back mid-turn it returns to the
  // live edge. At the edge a waiting message comes back to edit. With
  // none, a prompt that has no answer yet comes back too, and a turn that
  // has started answering stops. Ctrl+C stops either way.
  if (!this.pendingApproval && key === '\u001b' && this.scrolledBack) {
    this.scrollTranscript(-Number.MAX_SAFE_INTEGER);
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
  // Up and Down with nothing typed read the conversation, as they do at
  // the prompt. A phone sends a swipe as arrow keys and nothing else once
  // its keyboard is up, so without this a running turn was the one time
  // the conversation could not be scrolled at all -- recorded: a long turn,
  // the keyboard came up, and every swipe after that did nothing.
  if ((key === '\u001b[A' || key === '\u001b[B') && !turn.draft) {
    if (this.scrollTranscript(key === '\u001b[A' ? SWIPE_ROWS : -SWIPE_ROWS)) return;
    if (key === '\u001b[B') this.noteReadingDirection();
    return;
  }
  // Left with nothing typed steps away from the turn -- to the conversation
  // board -- and leaves it running: the worker owns it, not this window.
  if (key === '\u001b[D' && !turn.draft && turn.leave) {
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
    const restoreDraft = !turn.draft.trim();
    if (turn.early) turn.early.interrupt = { restoreDraft, trigger: 'ctrl-c' };
    turn.cancel?.(restoreDraft, 'ctrl-c');
  } else if (key === '\u001a') {
    this.suspendToShell();
  } else if (key === '\r' && this.signInInput && (!this.signInInput.alongside || isKeyShaped(turn.draft.trim()) || (!turn.draft.trim() && this.signInInput.optional))) {
    // A key pasted beside the vendor's sign-in is the sign-in's; anything
    // else typed there is the user's next message (the branch below).
    const text = turn.draft.trim();
    // A stray Enter answers nothing -- unless the question takes none (a
    // key-first sign-in's Enter for the vendor's own providers).
    if (!text && !this.signInInput.optional) return;
    turn.draft = '';
    turn.cursor = 0;
    this.signInInput.submit(text);
    this.updateWaiting();
  } else if (this.signingIn && !turn.submit && (key === '\r' || this.typedAhead.length)) {
    // Sent under a sign-in: the message stays in the composer, on screen,
    // and only its Enter waits -- for the turn or prompt that comes next,
    // which the draft is handed on to.
    if (key === '\r' && !this.typedAhead.length && !turn.draft.trim()) return;
    this.typedAhead.push(key);
  } else if (key === '\r') {
    const continued = turn.submit ? backslashNewline(turn.draft, turn.cursor) : undefined;
    if (continued) {
      turn.draft = continued.value;
      turn.cursor = continued.cursor;
      this.updateWaiting();
      return;
    }
    if (!turn.submit) return;
    // Enter again, nothing typed, on a message already waiting: it goes
    // into the chat at the next pause. The turn, and any sub-agent it
    // started, keeps running.
    const enter = waitingEnterAction(turn.draft, this.enterAgainReady(), Boolean(turn.sendWaiting) && !turn.cancelled);
    if (enter === 'send-waiting') {
      turn.sendWaiting!();
      return;
    }
    if (enter !== 'deliver') return;
    const text = turn.draft.trim();
    turn.draft = '';
    turn.cursor = 0;
    this.submitWaiting(text);
  } else if (turn.submit || turn.early || this.signInInput || this.signingIn) {
    // A sign-in's wait keeps what is typed under it too: the composer that
    // opens after it starts with that text (stopWaiting hands it on), where
    // dropping it lost the start of a message typed as a sign-in finished.
    this.editTurnDraft(turn, key);
  }
}
