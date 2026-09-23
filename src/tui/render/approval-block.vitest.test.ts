/** Answering an approval, including "and remember this".
 *
 * The rule that matters most here is the negative one: "always" is offered
 * only when a rule came with the request. A key that looks like it remembers
 * an answer and does not is worse than no key at all.
 */
import { describe, expect, it } from 'vitest';
import { APPROVAL_GUARD_MS, approvalBlockRows, approvalKeyAction } from './approval-block';

const past = APPROVAL_GUARD_MS + 1;
const key = (k: string, hasRule = false) => approvalKeyAction(k, past, false, false, hasRule);

describe('answering an approval', () => {
  it('keeps y and n meaning once-yes and no', () => {
    expect(key('y')).toBe('allow');
    expect(key('Y')).toBe('allow');
    expect(key('n')).toBe('deny');
    expect(key('\r')).toBe('deny');
    expect(key('\u001b')).toBe('deny');
    expect(key('\u0003')).toBe('deny');
  });

  it('accepts a for always ONLY when a rule was offered', () => {
    expect(key('a', true)).toBe('always');
    expect(key('A', true)).toBe('always');
    // Nothing would remember it, so the key does nothing rather than
    // quietly meaning "once" and implying it was remembered.
    expect(key('a', false)).toBe('ignore');
    expect(key('A', false)).toBe('ignore');
  });

  it('ignores every key inside the guard window, a included', () => {
    expect(approvalKeyAction('a', APPROVAL_GUARD_MS - 1, false, false, true)).toBe('ignore');
    expect(approvalKeyAction('y', APPROVAL_GUARD_MS - 1, false, false, true)).toBe('ignore');
  });

  it('still demands focus first when a draft was in the composer', () => {
    // 'a' is as much a letter someone is mid-word on as 'y' is.
    expect(approvalKeyAction('a', past, true, false, true)).toBe('ignore');
    expect(approvalKeyAction('\t', past, true, false, true)).toBe('focus');
    expect(approvalKeyAction('a', past, true, true, true)).toBe('always');
  });

  const state = { guarded: false, needsFocus: false, focused: false, queued: 0 };

  it('offers the always key and names the rule it would remember', () => {
    const rows = approvalBlockRows({ title: 'Approve command', detail: 'npm test', rule: 'Bash(npm test:*)' }, 100, 12, state);
    const answer = rows.at(-1)!;
    expect(answer).toContain('[a] always');
    // "always" has to say what it will remember, or the user is agreeing to
    // something unstated.
    expect(answer).toContain('Bash(npm test:*)');
  });

  it('offers no always key when no rule came with the request', () => {
    const answer = approvalBlockRows({ title: 'Approve command', detail: 'npm test' }, 100, 12, state).at(-1)!;
    expect(answer).not.toContain('[a]');
    expect(answer).toContain('Allow once?');
  });

  it('drops to short key hints on a narrow terminal without losing the always key', () => {
    const answer = approvalBlockRows({ title: 'Approve', rule: 'Bash(ls:*)' }, 40, 12, state).at(-1)!;
    expect(answer).toContain('[a]');
  });
});
