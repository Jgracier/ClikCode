import { describe, expect, it } from 'vitest';
import { APPROVAL_GUARD_MS } from './approval-keys.js';
import { questionBlockRows, questionKeyAction, questionRows, questionValues, type QuestionPromptState } from './question-block.js';

const state = (over: Partial<QuestionPromptState['question']> = {}, extra: Partial<QuestionPromptState> = {}): QuestionPromptState => ({
  request: { title: 'Codex asks', questions: [] },
  question: { id: 'q', prompt: 'Which database?', options: [{ label: 'Postgres', description: 'sql' }, { label: 'MySQL' }], ...over },
  position: 1, total: 1, highlight: 0, picked: new Set(), typing: false, collected: {}, ...extra,
});
const late = APPROVAL_GUARD_MS + 1;

describe('a question\'s keys', () => {
  it('ignores every key while guarded, as an approval does, so a word being typed answers nothing', () => {
    expect(questionKeyAction('\r', state(), 10, false, true)).toEqual({ type: 'ignore' });
    expect(questionKeyAction('1', state(), 10, false, true)).toEqual({ type: 'ignore' });
    expect(questionKeyAction('\u0003', state(), late, false, true)).toEqual({ type: 'cancel' });
  });

  it('needs Tab first when a draft was being typed', () => {
    expect(questionKeyAction('\r', state(), late, true, false)).toEqual({ type: 'ignore' });
    expect(questionKeyAction('\t', state(), late, true, false)).toEqual({ type: 'focus' });
  });

  it('moves, picks by number, chooses with Enter and cancels with Esc', () => {
    expect(questionKeyAction('\u001b[B', state(), late, false, true)).toEqual({ type: 'move', to: 1 });
    expect(questionKeyAction('\u001b[A', state(), late, false, true)).toEqual({ type: 'move', to: 0 });
    expect(questionKeyAction('2', state(), late, false, true)).toEqual({ type: 'choose', index: 1 });
    expect(questionKeyAction('9', state(), late, false, true)).toEqual({ type: 'ignore' });
    expect(questionKeyAction('\r', state(), late, false, true)).toEqual({ type: 'choose', index: 0 });
    expect(questionKeyAction('\u001b', state(), late, false, true)).toEqual({ type: 'cancel' });
  });

  it('ticks several, and Enter finishes only once something is ticked', () => {
    const multi = state({ multiSelect: true });
    expect(questionKeyAction(' ', multi, late, false, true)).toEqual({ type: 'toggle', index: 0 });
    expect(questionKeyAction('\r', multi, late, false, true)).toEqual({ type: 'toggle', index: 0 });
    expect(questionKeyAction('\r', { ...multi, picked: new Set([1]) }, late, false, true)).toEqual({ type: 'submit' });
  });

  it('types into the composer for Other, and Esc goes back to the list (cancels a text-only question)', () => {
    const other = state({ allowFreeText: true });
    expect(questionRows(other.question).map((r) => r.kind)).toEqual(['option', 'option', 'other']);
    const typing = { ...other, typing: true };
    expect(questionKeyAction('x', typing, late, false, true)).toEqual({ type: 'type' });
    expect(questionKeyAction('\r', typing, late, false, true)).toEqual({ type: 'submit' });
    expect(questionKeyAction('\u001b', typing, late, false, true)).toEqual({ type: 'back' });
    const text = state({ options: [], allowFreeText: true }, { typing: true });
    expect(questionKeyAction('\u001b', text, late, false, true)).toEqual({ type: 'cancel' });
  });

  it('offers Skip only for an optional question', () => {
    expect(questionRows(state({ optional: true }).question).map((r) => r.kind)).toEqual(['option', 'option', 'skip']);
    expect(questionRows(state().question).map((r) => r.kind)).toEqual(['option', 'option']);
  });
});

describe('a question\'s values', () => {
  it('is the option picked, the options ticked plus typed text, or the text', () => {
    const rows = questionRows(state().question);
    expect(questionValues(state(), rows[1])).toEqual(['MySQL']);
    expect(questionValues(state({ multiSelect: true }, { picked: new Set([1, 0]) }), undefined, 'Redis')).toEqual(['Postgres', 'MySQL', 'Redis']);
    expect(questionValues(state(), undefined, 'SQLite')).toEqual(['SQLite']);
  });
});

describe('a question\'s rows', () => {
  it('shows the prompt, every option with its detail, and the keys', () => {
    const rows = questionBlockRows(state(), 80, 20, { guarded: false, needsFocus: false, focused: true }).join('\n');
    expect(rows).toContain('Which database?');
    expect(rows).toContain('Postgres');
    expect(rows).toContain('sql');
    expect(rows).toContain('[enter] choose');
  });
});
