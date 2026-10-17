/** Approvals and questions: queueing a request, presenting the next, answering and withdrawing it, and the question prompt keys. */
import { lifecycle } from '../../runtime/lifecycle-log.js';
import { decisionRow, isApprovalWaitPhase } from '../../harness/protocol/turn-flow.js';
import { ApprovalPreview, ApprovalRequest } from '../render/approval-block.js';
import { APPROVAL_GUARD_MS, approvalKeyAction } from '../render/approval-keys.js';
import { questionKeyAction, questionRows, questionValues, startsTyping, type QuestionPromptState } from '../render/question-block.js';
import type { HarnessQuestionRequest, HarnessQuestionResult } from '../../harness/events/question.js';
import type { TerminalHarnessPrompter } from '../prompter.js';
import { WaitingTurn } from './state.js';

/** An approval answered: the next one waiting comes up, or the band goes
 * back to what the turn was doing. */
export function answerApproval(
  this: TerminalHarnessPrompter,
  pending: NonNullable<TerminalHarnessPrompter['pendingApproval']>, answer: boolean | 'always', settled?: Parameters<typeof decisionRow>[0],
): void {
  lifecycle('window.approval.answer', { answer: answer === 'always' ? 'always' : answer ? 'allow' : 'deny' });
  this.pendingApproval = undefined;
  // The decision stays on the page where it was made: the block is gone,
  // and a call that was denied or approved leaves no other trace.
  this.settleDecision(settled ?? (answer
    ? { kind: 'approved', label: pending.title, ...(answer === 'always' ? { always: true } : {}) }
    : { kind: 'denied', label: pending.title }), pending.callId);
  this.approvalsAnswered += 1;
  pending.resolve(answer);
  if (!this.presentNextApproval()) {
    if (this.turn) this.turn.label = this.approvalRestoreLabel || 'thinking';
    this.approvalRestoreLabel = undefined;
    this.resumeClock();
    this.updateWaiting();
  }
}

/** The draft set aside for "tell it instead", back in the composer. */
export function restoreTellingDraft(this: TerminalHarnessPrompter): void {
  const telling = this.tellingInstead;
  if (!telling) return;
  this.tellingInstead = undefined;
  if (this.turn) {
    this.turn.draft = telling.draft;
    this.turn.cursor = telling.cursor;
  }
}

export function approval(this: TerminalHarnessPrompter, title: string, detail?: string, preview?: ApprovalPreview, rule?: string, signal?: AbortSignal, callId?: string): Promise<boolean | 'always'> {
  lifecycle('window.approval.ask', { title: title.slice(0, 80) });
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise<boolean | 'always'>((resolveApproval) => {
    if (!this.pendingApproval) this.approvalRestoreLabel = isApprovalWaitPhase(this.turn?.label) ? '' : this.turn?.label ?? '';
    const request: ApprovalRequest = {
      title, ...(detail === undefined ? {} : { detail }), ...(preview === undefined ? {} : { preview }),
      ...(rule === undefined ? {} : { rule }), ...(callId === undefined ? {} : { callId }), resolve: resolveApproval,
    };
    this.approvalQueue.push(request);
    // The vendor withdrew it (answered elsewhere, the turn ended): the prompt closes.
    signal?.addEventListener('abort', () => this.withdrawApproval(request), { once: true });
    if (!this.pendingApproval) this.presentNextApproval();
  });
}

/** Closes a prompt nobody answered: on screen it is answered `no` (which
 * brings up the next); queued it is simply dropped. */
export function withdrawApproval(this: TerminalHarnessPrompter, request: ApprovalRequest): void {
  if (this.pendingApproval === request) { this.answerApproval(this.pendingApproval, false, { kind: 'declined', label: request.title }); return; }
  const at = this.approvalQueue.indexOf(request);
  if (at < 0) return;
  this.approvalQueue.splice(at, 1);
  request.resolve(false);
  this.updateWaiting();
}

/** A harness's question, one question at a time in the waiting band: pick
 * an option, tick several, or type. Never answered for the user. */
export function askQuestions(this: TerminalHarnessPrompter, request: HarnessQuestionRequest, signal?: AbortSignal): Promise<HarnessQuestionResult> {
  lifecycle('window.question.ask', { title: request.title.slice(0, 80), questions: request.questions.length });
  if (signal?.aborted || !request.questions.length) return Promise.resolve({ kind: 'cancelled' });
  return new Promise<HarnessQuestionResult>((resolveResult) => {
    const collected: Record<string, string[]> = {};
    let open: ApprovalRequest | undefined;
    let ended = false;
    const end = (result: HarnessQuestionResult): void => {
      if (ended) return;
      ended = true;
      resolveResult(result);
    };
    const ask = (index: number): void => {
      const question = request.questions[index]!;
      const state: QuestionPromptState = {
        request, question, position: index + 1, total: request.questions.length,
        highlight: 0, picked: new Set(), typing: false, collected,
      };
      let handled = false;
      const item: ApprovalRequest = {
        title: question.header ?? request.title,
        // Turn end, withdrawn: the prompt is answered "no", which here is a
        // cancel -- unless the user already answered this one (`done`).
        resolve: () => { if (!handled) end({ kind: 'cancelled' }); },
        question: {
          state,
          done: (values) => {
            handled = true;
            if (values === undefined) return end({ kind: 'cancelled' });
            if (values.length) collected[question.id] = values;
            if (index + 1 < request.questions.length) {
              // The next question of this request comes up before anything else queued.
              ask(index + 1);
              this.approvalQueue.unshift(open!);
            } else end({ kind: 'answered', answers: { ...collected } });
          },
        },
      };
      open = item;
      if (index === 0) {
        if (!this.pendingApproval) this.approvalRestoreLabel = this.turn?.label ?? '';
        this.approvalQueue.push(item);
      }
    };
    ask(0);
    signal?.addEventListener('abort', () => {
      end({ kind: 'cancelled' });
      if (open) this.withdrawApproval(open);
    }, { once: true });
    if (!this.pendingApproval) this.presentNextApproval();
  });
}

/** The question on screen takes a key. */
export function questionKey(this: TerminalHarnessPrompter, turn: WaitingTurn, pending: NonNullable<TerminalHarnessPrompter['pendingApproval']>, key: string): void {
  const state = pending.question!.state;
  const action = questionKeyAction(key, state, Date.now() - pending.shownAt, pending.needsFocus, pending.focused);
  const rows = questionRows(state.question);
  const finish = (values: string[] | undefined): void => {
    pending.question!.done(values);
    const { question } = state;
    const label = question.header ?? question.prompt;
    this.answerApproval(pending, values !== undefined, values === undefined ? { kind: 'declined', label }
      : { kind: 'answered', label, ...(values.length && !question.secret ? { values } : {}) });
  };
  const typeIn = (): void => {
    state.typing = true;
    this.tellingInstead ??= { draft: turn.draft, cursor: turn.cursor };
    turn.draft = '';
    turn.cursor = 0;
    this.updateWaiting();
  };
  switch (action.type) {
    case 'ignore': return;
    case 'focus':
      pending.focused = true;
      if (startsTyping(state.question)) typeIn(); else this.updateWaiting();
      return;
    case 'cancel': return finish(undefined);
    case 'back':
      state.typing = false;
      this.restoreTellingDraft();
      this.updateWaiting();
      return;
    case 'move': state.highlight = action.to; this.updateWaiting(); return;
    case 'toggle':
      state.highlight = action.index;
      if (!state.picked.delete(action.index)) state.picked.add(action.index);
      this.updateWaiting();
      return;
    case 'choose': {
      state.highlight = action.index;
      const row = rows[action.index];
      if (!row) return;
      if (row.kind === 'other') return typeIn();
      if (row.kind === 'skip') return finish([]);
      return finish(questionValues(state, row));
    }
    case 'submit': {
      if (state.typing) {
        const text = state.question.secret ? turn.draft : turn.draft.trim();
        if (!text) {
          if (state.question.multiSelect && state.picked.size) return finish(questionValues(state, undefined));
          if (state.question.optional) return finish([]);
          return;
        }
        return finish(questionValues(state, undefined, text));
      }
      return finish(questionValues(state, undefined));
    }
    case 'type': this.editTurnDraft(turn, key); return;
  }
}

/** Returns false when nothing was waiting, so the caller knows to restore
 * the turn's own label instead of leaving a stale prompt on screen. */
export function presentNextApproval(this: TerminalHarnessPrompter): boolean {
  this.restoreTellingDraft();
  const next = this.approvalQueue.shift();
  if (!next) { this.approvalsAnswered = 0; return false; }
  // Each approval gets its own guard window and its own focus requirement:
  // answering the first of two must not let the same keypress, or the next
  // character of a sentence, answer the second.
  this.pendingApproval = { ...next, shownAt: Date.now(), needsFocus: Boolean(this.turn?.draft), focused: false };
  // A question with nothing to pick is answered in the composer from the start.
  const asked = next.question?.state;
  if (asked && startsTyping(asked.question) && this.turn && !this.pendingApproval.needsFocus) {
    asked.typing = true;
    this.tellingInstead = { draft: this.turn.draft, cursor: this.turn.cursor };
    this.turn.draft = '';
    this.turn.cursor = 0;
  }
  if (this.turn) {
    this.turn.label = next.question ? 'waiting for your answer' : 'waiting for approval';
    // The clock stops while the turn waits on the user, not on the agent.
    this.pauseClock();
  }
  if (this.approvalGuardTimer) clearTimeout(this.approvalGuardTimer);
  // Repaint when the guard lifts so the answer row visibly becomes live.
  this.approvalGuardTimer = setTimeout(() => { this.approvalGuardTimer = undefined; this.updateWaiting(); }, APPROVAL_GUARD_MS);
  this.approvalGuardTimer.unref();
  this.notifyIfAway(next.question ? `Question: ${next.question.state.question.prompt.slice(0, 80)}` : `Approval needed: ${next.title}`);
  this.updateWaiting();
  return true;
}

/** A turn can end while an approval is on screen. Denying outstanding asks
 * is what releases the provider's own awaiting handler; dropping them left
 * it waiting on a promise that could never settle. */
export function settleApprovals(this: TerminalHarnessPrompter): void {
  const outstanding = [this.pendingApproval, ...this.approvalQueue];
  if (this.approvalGuardTimer) clearTimeout(this.approvalGuardTimer);
  this.approvalGuardTimer = undefined;
  this.pendingApproval = undefined;
  this.approvalQueue = [];
  this.approvalRestoreLabel = undefined;
  this.approvalsAnswered = 0;
  this.restoreTellingDraft();
  this.resumeClock();
  for (const item of outstanding) item?.resolve(false);
}

/** A key while an approval (not a question) is on screen: its answer, or --
 * once "tell it instead" was chosen -- the composer typing that text. */
export function approvalKey(
  this: TerminalHarnessPrompter,
  turn: WaitingTurn,
  pending: NonNullable<TerminalHarnessPrompter['pendingApproval']>,
  key: string,
): void {
  // "No, and tell it what to do instead": the composer is where it is
  // typed, on its own -- whatever draft was there waits aside -- and
  // Enter denies the call and sends the text into the turn as a steer.
  const telling = this.tellingInstead;
  if (telling) {
    if (key === '\r') {
      const text = turn.draft.trim();
      if (!text) return;
      this.answerApproval(pending, false, { kind: 'told', text });
      // After the denial is on its way: the answer's own send is queued
      // behind this resolve, and the steer must not overtake it.
      setImmediate(() => this.submitWaiting(text, false));
      return;
    }
    if (key === '\u001b' || key === '\u0003') {
      this.restoreTellingDraft();
      if (key === '\u0003') this.answerApproval(pending, false);
      else this.updateWaiting();
      return;
    }
    this.editTurnDraft(turn, key);
    return;
  }
  // Otherwise the draft is never edited from here: every key is either an
  // answer or dropped, so the composer is exactly as the user left it.
  const action = approvalKeyAction(key, Date.now() - pending.shownAt, pending.needsFocus, pending.focused, Boolean(pending.rule), Boolean(turn.submit));
  if (action === 'focus') {
    pending.focused = true;
    this.updateWaiting();
  } else if (action === 'tell') {
    this.tellingInstead = { draft: turn.draft, cursor: turn.cursor };
    turn.draft = '';
    turn.cursor = 0;
    this.updateWaiting();
  } else if (action === 'allow' || action === 'always' || action === 'deny') {
    this.answerApproval(pending, action === 'deny' ? false : action === 'always' ? 'always' : true);
  }
}
