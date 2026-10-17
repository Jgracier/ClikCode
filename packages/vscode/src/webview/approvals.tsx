/** Approval and question cards for what the agent asks the user. */
import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { ACTIVITY_PREVIEW_LINES } from '../../../../src/harness/protocol/activity-view';
import { APPROVAL_GUARD_MS, approvalHeading, approvalKeyAction } from '../../../../src/tui/render/approval-keys';
import { type Approval } from '../model';
import type { HarnessQuestion, HarnessQuestionResult } from '../protocol';
import { post } from './bus';
import { relative } from './format';
import { Icon } from './ui';
import { DiffView } from './activity-rows';

/** A pending approval, answered with the terminal's keys and its guard
 * (approval-keys.ts): nothing counts for the first moments, so a word being
 * typed cannot approve a call; y once, a always (only where a rule is
 * offered, and the rule is shown), n, Enter or Esc deny. Or denied with a
 * note (Claude Code's "No, and tell it what to do instead"): the note goes
 * into the running turn as a message. Several waiting: "Approval 1 of 3". */
export function ApprovalCard({ approval, workspace, position, total, onAnswer }: {
  approval: Approval; workspace?: string; position: number; total: number; onAnswer: (value: boolean | 'always', note?: string) => void;
}): JSX.Element {
  const shownAt = useRef(Date.now());
  const [guarded, setGuarded] = useState(true);
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState('');
  const noteInput = useRef<HTMLInputElement>(null);
  useEffect(() => { const timer = setTimeout(() => setGuarded(false), APPROVAL_GUARD_MS); return () => clearTimeout(timer); }, []);
  useEffect(() => { if (noting) noteInput.current?.focus(); }, [noting]);
  const onKey = (event: KeyboardEvent): void => {
    const tag = (event.target as HTMLElement).tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT' || event.ctrlKey || event.metaKey || event.altKey) return;
    const key = event.key === 'Escape' ? '\u001b' : event.key === 'Enter' ? '\r' : event.key === 'Tab' ? '\t' : event.key;
    const action = approvalKeyAction(key, Date.now() - shownAt.current, false, true, Boolean(approval.rule));
    if (action === 'ignore' || action === 'focus') { if (key.length === 1) event.preventDefault(); return; }
    event.preventDefault();
    event.stopPropagation();
    onAnswer(action === 'allow' ? true : action === 'always' ? 'always' : false);
  };
  const answer = (value: boolean | 'always') => (): void => { if (Date.now() - shownAt.current >= APPROVAL_GUARD_MS) onAnswer(value); };
  const denyWithNote = (): void => {
    if (Date.now() - shownAt.current >= APPROVAL_GUARD_MS && note.trim()) onAnswer(false, note.trim());
  };
  // The note's own keys: Enter denies with it, Esc puts the note away (and
  // is not the page's Esc, which would deny without it).
  const onNoteKey = (event: KeyboardEvent): void => {
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      denyWithNote();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setNoting(false);
      requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-approval="${approval.id}"]`)?.focus());
    }
  };
  return (
    <div class={`approval${guarded ? ' guarded' : ''}`} role="alertdialog" aria-label={`Approval: ${approval.title}`} tabIndex={0} onKeyDown={onKey} data-approval={approval.id}>
      <div class="approval-head">
        <Icon name="shield" /><span class="approval-title">{relative(approvalHeading(approval.title, approval.detail), workspace)}</span>
        {total > 1 ? <span class="muted approval-count">Approval {position} of {total}</span> : null}
        {approval.diff?.length ? <button type="button" class="icon-button tiny approval-diff" title="Open in the diff editor" aria-label="Open in the diff editor" onClick={() => post({ type: 'viewDiff', id: approval.id })}><Icon name="diff" /></button> : null}
      </div>
      {/* The change speaks for an edit; a command's words are its detail. */}
      {approval.diff?.length ? <DiffView files={approval.diff} budget={ACTIVITY_PREVIEW_LINES} />
        : approval.detail ? <pre class="approval-detail">{relative(approval.detail, workspace)}</pre> : null}
      <div class="approval-actions">
        <button type="button" class="primary" data-approve="yes" onClick={answer(true)}>Allow <kbd>y</kbd></button>
        {approval.rule ? <button type="button" class="secondary" data-approve="always" title={`Always allow ${approval.rule}`} onClick={answer('always')}>Always <kbd>a</kbd></button> : null}
        <button type="button" class="secondary" data-approve="no" title="Deny (n, Enter or Esc)" onClick={answer(false)}>Deny <kbd>n</kbd></button>
        <button type="button" class="link" data-approve="note" aria-expanded={noting} title="Deny, and tell it what to do instead" onClick={() => setNoting(!noting)}>Deny with a note…</button>
      </div>
      {noting ? (
        <div class="approval-note">
          <input ref={noteInput} type="text" class="approval-note-input" value={note} placeholder="Tell it what to do instead…" aria-label="Tell it what to do instead"
            onInput={(event) => setNote((event.target as HTMLInputElement).value)} onKeyDown={onNoteKey} />
          <button type="button" class="secondary" data-approve="note-send" title="Deny, and send this note into the turn (Enter)" disabled={!note.trim()} onClick={denyWithNote}>Deny <kbd>↵</kbd></button>
        </div>
      ) : null}
      {approval.rule ? <div class="approval-rule muted" title="What Always allow remembers">Always: <code>{approval.rule}</code></div> : null}
    </div>
  );
}

/** A harness's question (Claude Code's AskUserQuestion, a Codex or MCP form,
 * a plan to approve): every question of the request in one card, options as
 * radios or ticks, text where the harness allows it. Nothing is answered for
 * the user: Submit needs an answer to each question that is not optional,
 * counts only after the approval guard, and Dismiss (or Esc) cancels. */
export function QuestionCard({ approval, position, total, onAnswer }: {
  approval: Approval; position: number; total: number; onAnswer: (result: HarnessQuestionResult) => void;
}): JSX.Element {
  const request = approval.question!;
  const shownAt = useRef(Date.now());
  const [guarded, setGuarded] = useState(true);
  const [picks, setPicks] = useState<Record<string, string[]>>({});
  const [typed, setTyped] = useState<Record<string, string>>({});
  useEffect(() => { const timer = setTimeout(() => setGuarded(false), APPROVAL_GUARD_MS); return () => clearTimeout(timer); }, []);
  const valuesOf = (question: HarnessQuestion): string[] => {
    const text = question.secret ? (typed[question.id] ?? '') : (typed[question.id] ?? '').trim();
    const chosen = picks[question.id] ?? [];
    if (question.multiSelect) return text ? [...chosen, text] : chosen;
    return text ? [text] : chosen;
  };
  const complete = request.questions.every((question) => question.optional || valuesOf(question).length > 0);
  const submit = (): void => {
    if (Date.now() - shownAt.current < APPROVAL_GUARD_MS || !complete) return;
    const answers: Record<string, string[]> = {};
    for (const question of request.questions) { const values = valuesOf(question); if (values.length) answers[question.id] = values; }
    onAnswer({ kind: 'answered', answers });
  };
  const pick = (question: HarnessQuestion, label: string, on: boolean): void => {
    setPicks((held) => {
      const chosen = held[question.id] ?? [];
      return { ...held, [question.id]: question.multiSelect ? (on ? [...chosen, label] : chosen.filter((item) => item !== label)) : [label] };
    });
    // A single choice replaces typed text; ticks sit beside it.
    if (!question.multiSelect) setTyped((held) => ({ ...held, [question.id]: '' }));
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); submit(); }
  };
  return (
    <div class={`approval question${guarded ? ' guarded' : ''}`} role="dialog" aria-label={`Question: ${approval.title}`} tabIndex={0} onKeyDown={onKey} data-approval={approval.id}>
      <div class="approval-head">
        <Icon name="question" /><span class="approval-title">{request.title}</span>
        {total > 1 ? <span class="muted approval-count">{position} of {total} waiting</span> : null}
      </div>
      {request.url ? <pre class="approval-detail">{request.url}</pre> : null}
      {request.questions.map((question) => (
        <fieldset class="question-item" key={question.id}>
          {question.header ? <legend class="question-header">{question.header}</legend> : null}
          <div class="question-prompt">{question.prompt}</div>
          {question.options.map((option) => {
            const chosen = (picks[question.id] ?? []).includes(option.label);
            return (
              <label class="question-option" key={option.label}>
                <input type={question.multiSelect ? 'checkbox' : 'radio'} name={`q-${approval.id}-${question.id}`} checked={chosen}
                  onChange={(event) => pick(question, option.label, (event.target as HTMLInputElement).checked)} />
                <span>{option.label}{option.description ? <span class="muted"> — {option.description}</span> : null}</span>
              </label>
            );
          })}
          {question.allowFreeText || question.options.length === 0 ? (
            <input type={question.secret && question.maskInput !== false ? 'password' : 'text'} class="approval-note-input question-text" autocomplete="off"
              aria-label={question.options.length ? `${question.prompt} (other answer)` : question.prompt}
              placeholder={question.options.length ? 'Other…' : 'Type your answer…'} value={typed[question.id] ?? ''}
              onInput={(event) => {
                const text = (event.target as HTMLInputElement).value;
                setTyped((held) => ({ ...held, [question.id]: text }));
                if (text && !question.multiSelect) setPicks((held) => ({ ...held, [question.id]: [] }));
              }}
              onKeyDown={(event) => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); event.stopPropagation(); submit(); } }} />
          ) : null}
        </fieldset>
      ))}
      <div class="approval-actions">
        <button type="button" class="primary" data-question="submit" disabled={!complete} title="Send your answer (Ctrl+Enter)" onClick={submit}>Submit</button>
        <button type="button" class="secondary" data-question="dismiss" title="Dismiss without answering (Esc)" onClick={() => { if (Date.now() - shownAt.current >= APPROVAL_GUARD_MS) onAnswer({ kind: 'cancelled' }); }}>Dismiss</button>
      </div>
    </div>
  );
}
