import { expect, it } from 'vitest';
import { decide, keyShaped } from './secret-finder.js';

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
