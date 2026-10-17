import { afterEach, expect, it } from 'vitest';
import { forgetSecrets, registerSecret, scrubSecrets } from './secret-scrubber.js';

afterEach(() => forgetSecrets());

it('hides a secret and the forms it could come back in', () => {
  const key = 'sk_live_AbC123+/xyz"q';
  registerSecret(key);
  for (const shown of [key, Buffer.from(key).toString('base64'), encodeURIComponent(key), JSON.stringify(key).slice(1, -1)]) {
    const out = scrubSecrets(`before ${shown} after`);
    expect(out).toBe('before [secret hidden] after');
  }
});

it('leaves text alone when nothing is registered or nothing matches', () => {
  expect(scrubSecrets('plain')).toBe('plain');
  registerSecret('abcdefgh1234');
  expect(scrubSecrets('plain')).toBe('plain');
});

it('does not register trivially short values', () => {
  registerSecret('ab');
  expect(scrubSecrets('ab cd')).toBe('ab cd');
});
