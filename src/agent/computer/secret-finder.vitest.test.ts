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

it('hides a labelled key from text the agent reads, and leaves urls, numbers and uuids alone', () => {
  const text = `API Key ${GOOGLE_STYLE}\nlink /url: https://docs.example.com/guide/AbCdEf1234567890AbCdEf1234567890\nProject number 831963658327\nprice_1N8abcDEFghiJKLmno123456\nuuid 3f2a9c1e-7b4d-4e8a-9c21-5d6e7f809a1b`;
  const { text: shown, hidden } = hideKeyLikeText(text);
  // The random-looking price id goes too: nothing is shown on the chance that it is harmless.
  expect(hidden).toBe(2);
  expect(shown).not.toContain(GOOGLE_STYLE);
  expect(shown).toContain('API Key [secret hidden]');
  for (const kept of ['https://docs.example.com/guide/AbCdEf1234567890AbCdEf1234567890', '831963658327', '3f2a9c1e-7b4d-4e8a-9c21-5d6e7f809a1b']) expect(shown).toContain(kept);
});

it('hides a long random-looking token wherever it sits, labelled or not, and keeps refs, words and urls', () => {
  const token = 'Zx9Kp2LmQ7vRt4YhNb6WcDfGjS8aEuI3oPxC1VnMzKq5';
  expect(hideKeyLikeText(`Your new credential is shown once ${token} copy it now`).hidden).toBe(1);
  expect(hideKeyLikeText(`Build ${token} finished`).hidden).toBe(1);
  const plain = ['- button "Create the deployment pipeline" [ref=f262e355]', '- link "Documentation for the integration settings"', '  - /url: https://app.example.com/settings/applications/new'].join('\n');
  expect(hideKeyLikeText(plain)).toEqual({ text: plain, hidden: 0 });
});

it('recognises and hides a prefixed token that has no digit, as Hugging Face tokens can', () => {
  const noDigit = ['hf', 'QjXkVbNzWpLcRmTgHsYdFaUeIoKnBvCxZq'].join('_'); // built here so no token-shaped text sits in the source
  expect(keyShaped(noDigit)).toBe(true);
  expect(decide({ before: none, after: [noDigit], responses: [], hint: true })).toEqual({ kind: 'found', value: noDigit });
  expect(hideKeyLikeText(`Save your token\nCopy ${noDigit}`).hidden).toBe(1);
  // A long CamelCase identifier is not a key.
  expect(keyShaped('ThisIsAVeryLongFunctionNameForTheThing')).toBe(false);
});

it('does not take an unlabelled, unprefixed token from a page that had it from the start', () => {
  const blob = 'QWERTYUIOPASDFGHJKLZXCVBNM0123456789QWERTYUIOPASDFGHJKLZXCVBNM01234'.slice(0, 60);
  expect(decide({ before: none, after: [blob], responses: [], hint: true, existing: true })).toEqual({ kind: 'none' });
  expect(decide({ before: none, after: [blob], responses: [], hint: true, existing: false })).toEqual({ kind: 'found', value: blob });
  expect(decide({ before: none, after: [KEY], responses: [], hint: false, existing: true })).toEqual({ kind: 'found', value: KEY });
});

it('rejects a very long token unless it is a dotted JWT', () => {
  const long = `${'Ab3'.repeat(70)}`;
  expect(keyShaped(long)).toBe(false);
  expect(keyShaped(`eyJ${'a1B'.repeat(20)}.${'c2D'.repeat(20)}.${'e3F'.repeat(20)}`)).toBe(true);
});

it('hides a lower-case UUID secret key, in a snippet and under a "Secret Key:" label', () => {
  const uuid = ['7456ed7e', 'be98', '4e0e', '9fe7', '50d010f9fbb2'].join('-');
  const snippet = hideKeyLikeText(`access-key=ABC\nsecret-key=${uuid}\\\norganization-id=5354e130-df7f-4c1c-8d8f-c74f41131c06`);
  expect(snippet.text).not.toContain(uuid);
  expect(snippet.text).toContain('5354e130-df7f-4c1c-8d8f-c74f41131c06');
  const labelled = hideKeyLikeText(`Secret Key:\n${uuid}\nCopy and store your secret key. It will only be shown once.`);
  expect(labelled.text).not.toContain(uuid);
});

it('hides a value on the line below its label, as a definition list prints it', async () => {
  const { hideKeyLikeText } = await import('./secret-finder.js');
  const page = ['- term [ref=e1]: "Client ID:"', '- definition [ref=e2]: egt41tV8CRc1JqBKcVlt8V8Ck2IQmT9qL78BhfpsoYs', '- term [ref=e3]: "Secret:"', '- definition [ref=e4]: Ebb9Z06K0gR7Xi3zCgyaCOFF8cBHS9vG4RwqMTu5ZNM'].join('\n');
  const { text, hidden } = hideKeyLikeText(page);
  expect(text).not.toContain('Ebb9Z06K0gR7Xi3zCgyaCOFF8cBHS9vG4RwqMTu5ZNM');
  expect(text).not.toContain('egt41tV8CRc1JqBKcVlt8V8Ck2IQmT9qL78BhfpsoYs'); // the id is random-looking too: hidden, and still capturable
  expect(hidden).toBe(2);
});

it('hides a 15-character app secret that sits under or beside its label, and leaves ordinary lines alone', () => {
  const page = ['- generic [ref=e1]: App key', '- textbox [ref=e2]: k3j9d8f7s6a5q4w', '- generic [ref=e3]: App secret', '- textbox [ref=e4]: m1n2b3v4c5x6z7l', '- heading "Settings for deployment2024" [ref=e5]'].join('\n');
  const { text, hidden } = hideKeyLikeText(page);
  expect(text).not.toContain('k3j9d8f7s6a5q4w');
  expect(text).not.toContain('m1n2b3v4c5x6z7l');
  expect(text).toContain('deployment2024');
  expect(hidden).toBe(2);
});

it('takes a short letters-and-digits credential only when it is plainly one', async () => {
  const { shortKeyText } = await import('./secret-capture.js');
  expect(shortKeyText('k3j9d8f7s6a5q4w')).toBe(true);
  expect(shortKeyText('Create new app')).toBe(false);
  expect(shortKeyText('deployment')).toBe(false);
  expect(shortKeyText('1x')).toBe(false);
});
