import { describe, expect, it } from 'vitest';
import { describeLink, pickLink } from './email-links.js';

describe('pickLink', () => {
  const logo = { href: 'https://cloudconvert.com/', text: 'CloudConvert', image: true };
  const verify = { href: 'https://cloudconvert.com/email/verify/9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c', text: 'Verify email', button: true };
  const unsub = { href: 'https://cloudconvert.com/unsubscribe?u=1', text: 'Unsubscribe' };
  const tw = { href: 'https://twitter.com/cloudconvert', text: 'Twitter' };

  it('skips the logo and picks the verification button, whatever the order', () => {
    const pick = pickLink([logo, tw, unsub, verify])!;
    expect(pick.chosen).toBe(verify);
    expect(pick.others).toEqual(['Twitter', 'CloudConvert']);
    expect(pickLink([verify, logo])!.chosen).toBe(verify);
  });
  it('prefers an opaque token url over a plain page when no word helps', () => {
    const plain = { href: 'https://acme.io/docs', text: 'Docs' };
    const token = { href: 'https://acme.io/go?t=Zx81hd92kQpLmn03Vb7Ywe4', text: 'Continue' };
    expect(pickLink([plain, token])!.chosen).toBe(token);
  });
  it('honours the hint and never returns an unsubscribe link', () => {
    expect(pickLink([logo, verify, tw], 'twitter')!.chosen).toBe(tw);
    expect(pickLink([unsub])).toBeUndefined();
  });
  it('describes only host and path', () => {
    expect(describeLink({ href: 'https://a.io/v/abc?token=SECRETSECRET', text: '' })).toBe('a.io/v/abc');
  });
});
