import { describe, expect, it } from 'vitest';
import { phoneForPage, VOIP_REFUSED } from './computer-web.js';

const page = (text: string) => ({ evaluate: async <T>() => text as unknown as T });

describe('the sign-up phone and a site that refuses VoIP numbers', () => {
  it('types the Twilio number until the page refuses it, then the user\'s own mobile', async () => {
    expect(await phoneForPage(page('Enter your phone number to receive a code'), '+17192497747', '+15555550100')).toBe('+17192497747');
    for (const refusal of ['VoIP numbers are not supported', 'Please use a real mobile number', 'This phone number is not supported', 'We cannot accept this number', 'Virtual numbers can not be used for verification', 'Landline numbers cannot receive SMS']) {
      expect(await phoneForPage(page(refusal), '+17192497747', '+15555550100')).toBe('+15555550100');
    }
  });
  it('keeps the profile phone when no personal mobile is saved, and reads ordinary pages as no refusal', async () => {
    expect(await phoneForPage(page('VoIP numbers are not supported'), '+17192497747', undefined)).toBe('+17192497747');
    for (const ordinary of ['Phone number (optional)', 'We will text you a 6-digit code', 'Mobile number']) expect(VOIP_REFUSED.test(ordinary)).toBe(false);
  });
});
