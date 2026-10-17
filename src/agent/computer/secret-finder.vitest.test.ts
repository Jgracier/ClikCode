import { expect, it } from 'vitest';
import { decide, hideKeyLikeText, keyShaped, labelledValues } from './secret-finder.js';

const KEY = 'salad_live_9f8e7d6c5b4a39281706';
const none = new Set<string>();

it('recognises key-shaped text and rejects words, URLs, emails and plain numbers', () => {
  expect(keyShaped(KEY)).toBe(true);
  expect(keyShaped('ghp_16C7e42F292c6912E7710c838347Ae178B4a')).toBe(true);
  for (const text of ['applicationprogramminginterface', 'https://example.com/abc123def456ghi', 'someone.longname1234@example.com', '12345678901234567890', 'short1']) expect(keyShaped(text)).toBe(false);
});

it('takes the key that is new on the page and was returned under a credential field', () => {
  expect(decide({ before: none, after: [KEY], responses: [{ value: KEY, keyName: 'api_key' }], hint: false })).toEqual({ kind: 'found', value: KEY });
});

it('takes a prefixed key that only appeared on the page', () => {
  expect(decide({ before: none, after: [KEY], responses: [], hint: false })).toEqual({ kind: 'found', value: KEY });
});

it('ignores text that was already on the page before the click', () => {
  expect(decide({ before: new Set([KEY]), after: [KEY], responses: [], hint: true })).toEqual({ kind: 'none' });
});

it('does not take a CSRF token that only the response carried', () => {
  expect(decide({ before: none, after: [], responses: [{ value: 'Zx9Qw3Er7Ty1Ui5Op2As4Df6', keyName: 'csrf_token' }], hint: true })).toEqual({ kind: 'none' });
});

it('takes a credential-named response value even when the page does not show it', () => {
  expect(decide({ before: none, after: [], responses: [{ value: 'Zx9Qw3Er7Ty1Ui5Op2As4Df6', keyName: 'secret' }], hint: false })).toEqual({ kind: 'found', value: 'Zx9Qw3Er7Ty1Ui5Op2As4Df6' });
});

it('says ambiguous, not a guess, when two candidates are equally likely', () => {
  expect(decide({ before: none, after: [KEY, 'salad_live_aaaa1111bbbb2222cccc'], responses: [], hint: false })).toEqual({ kind: 'ambiguous' });
});

it('says none when the click produced nothing key-like', () => {
  expect(decide({ before: none, after: ['Welcome', 'Your-dashboard-overview'], responses: [], hint: true })).toEqual({ kind: 'none' });
});

const GOOGLE_STYLE = 'AQ.Zx9Kp2LmQ7vRt4YhNb6WcDfGjS8aEuI3oPxC1VnMzKq5TyBw';

it('picks the key over a resource name that sits next to it on the page', () => {
  const text = `API key documentation . API Key ${GOOGLE_STYLE} Copy key to clipboard Name ClikDeploy Project name projects/831963658327 Project number 831963658327`;
  expect(decide({ before: none, after: [GOOGLE_STYLE, 'projects/831963658327'], responses: [], hint: true, labelled: labelledValues(text) })).toEqual({ kind: 'found', value: GOOGLE_STYLE });
  expect(keyShaped('projects/831963658327')).toBe(false);
});

it('hides a labelled key from text the agent reads, and leaves ids, urls and slugs alone', () => {
  const text = `API Key ${GOOGLE_STYLE}\nlink /url: https://docs.example.com/guide/AbCdEf1234567890AbCdEf1234567890\nProject number 831963658327\nprice_1N8abcDEFghiJKLmno123456\nuuid 3f2a9c1e-7b4d-4e8a-9c21-5d6e7f809a1b`;
  const { text: shown, hidden } = hideKeyLikeText(text);
  expect(hidden).toBe(1);
  expect(shown).not.toContain(GOOGLE_STYLE);
  expect(shown).toContain('API Key [secret hidden]');
  for (const kept of ['https://docs.example.com/guide/AbCdEf1234567890AbCdEf1234567890', '831963658327', 'price_1N8abcDEFghiJKLmno123456', '3f2a9c1e-7b4d-4e8a-9c21-5d6e7f809a1b']) expect(shown).toContain(kept);
});

it('hides a long mixed-case token on a page that invites copying, even unlabelled', () => {
  const token = 'Zx9Kp2LmQ7vRt4YhNb6WcDfGjS8aEuI3oPxC1VnMzKq5';
  expect(hideKeyLikeText(`Your new credential is shown once ${token} copy it now`).hidden).toBe(1);
  expect(hideKeyLikeText(`Build ${token} finished`).hidden).toBe(0);
});
