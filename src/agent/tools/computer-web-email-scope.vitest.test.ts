import { describe, expect, it } from 'vitest';
import { emailSiteScope } from './computer-web.js';

describe('whose email a code or link read may take', () => {
  it('keeps the page\'s site with a subject: a subject alone fits every vendor\'s mail', () => {
    expect(emailSiteScope({}, 'https://app.acme.com/verify')).toEqual({ site: 'https://app.acme.com/verify' });
    expect(emailSiteScope({ subject: 'verification' } as { from?: string }, 'https://app.acme.com/verify')).toEqual({ site: 'https://app.acme.com/verify' });
  });
  it('drops the site only when the sender is named, or the page is no site', () => {
    expect(emailSiteScope({ from: 'acme.com' }, 'https://app.acme.com/verify')).toEqual({});
    expect(emailSiteScope({}, 'about:blank')).toEqual({});
  });
});
