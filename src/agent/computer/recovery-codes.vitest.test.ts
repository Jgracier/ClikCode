import { describe, expect, it } from 'vitest';
import { hideRecoveryCodes, otpauthIn, QR_TARGET, recoveryCodesIn, RECOVERY_TARGET } from './recovery-codes.js';

const snapshot = `- heading "2-Step Login Backup Codes" [level=3] [ref=e1]
- paragraph [ref=e2]: You can generate a new set of 10 codes whenever you want.
- generic [ref=e3]:
  - heading "7448 1814" [level=6] [ref=e4]
  - heading "7368 6336" [level=6] [ref=e5]
  - heading "6617 9253" [level=6] [ref=e6]
  - heading "7989 6690" [level=6] [ref=e7]
- paragraph [ref=e8]: Generated on 11/13/2026
- button "Download" [ref=e9]`;

describe('backup codes', () => {
  it('are replaced by placeholders in the page view, with everything else left as it was', () => {
    const { text, hidden } = hideRecoveryCodes(snapshot);
    expect(hidden).toBe(4);
    expect(text).not.toMatch(/7448|7368|6617|7989/);
    expect(text).toContain('- heading "[secret:ref-');
    expect(text).toContain('Generated on 11/13/2026');
    expect(text).toContain('set of 10 codes');
  });
  it('covers list items and dashed codes', () => {
    const list = `- text: Save your recovery codes\n- list:\n  - listitem: abcd1-efgh2\n  - listitem: ijkl3-mnop4\n  - listitem: qrst5-uvwx6\n  - listitem: yzab7-cdef8`;
    expect(hideRecoveryCodes(list).hidden).toBe(4);
  });
  it('leaves a page alone that only asks for a code or shows numbers', () => {
    const asks = `- heading "Enter a backup code" [level=2]\n- textbox "Backup code"\n- paragraph: Lost your backup codes? Contact support.`;
    expect(hideRecoveryCodes(asks)).toEqual({ text: asks, hidden: 0 });
    const prices = `- heading "Pricing" [level=1]\n- text: 12345678\n- text: 23456789\n- text: 34567890\n- text: 45678901`;
    expect(hideRecoveryCodes(prices).hidden).toBe(0);
  });
  it('are read as one set from the page text for capture', () => {
    expect(recoveryCodesIn('2-Step Login Backup Codes\n7448 1814\n7368 6336\n6617 9253\n7989 6690\nGenerated on 11/13/2026\nDownload')).toEqual(['7448 1814', '7368 6336', '6617 9253', '7989 6690']);
    expect(recoveryCodesIn('Backup codes\n7448 1814')).toEqual([]);
    expect(recoveryCodesIn('Order numbers\n7448 1814\n7368 6336\n6617 9253\n7989 6690')).toEqual([]);
  });
  it('names the capture target', () => {
    expect(RECOVERY_TARGET.test('backup codes')).toBe(true);
    expect(RECOVERY_TARGET.test('the recovery codes')).toBe(true);
    expect(RECOVERY_TARGET.test('Backup codes button')).toBe(false);
  });
});

describe('the setup link behind a QR code', () => {
  it('is found in a chart address, an attribute or a script, however it is encoded', () => {
    expect(otpauthIn('<img src="https://chart.googleapis.com/chart?chs=200x200&amp;cht=qr&amp;chl=otpauth%3A%2F%2Ftotp%2FAcme%3Ame%40x.io%3Fsecret%3DJBSWY3DPEHPK3PXP%26issuer%3DAcme">')).toBe('otpauth://totp/Acme:me@x.io?secret=JBSWY3DPEHPK3PXP&issuer=Acme');
    expect(otpauthIn('<div data-uri="otpauth://totp/Acme:me?secret=JBSWY3DPEHPK3PXP&amp;issuer=Acme"></div>')).toBe('otpauth://totp/Acme:me?secret=JBSWY3DPEHPK3PXP&issuer=Acme');
    expect(otpauthIn('<script>var qr = "otpauth%253A%252F%252Ftotp%252FAcme%253Fsecret%253DJBSWY3DPEHPK3PXP";</script>')).toBe('otpauth://totp/Acme?secret=JBSWY3DPEHPK3PXP');
  });
  it('is absent from a page whose QR is only a picture', () => {
    expect(otpauthIn('<img src="data:image/png;base64,iVBORw0KGgo=" alt="QR code"><p>100% secure</p>')).toBeUndefined();
  });
  it('names the capture target', () => {
    for (const target of ['qr code', 'authenticator qr', 'the setup key', 'otpauth key']) expect(QR_TARGET.test(target), target).toBe(true);
    expect(QR_TARGET.test('API key')).toBe(false);
  });
});
