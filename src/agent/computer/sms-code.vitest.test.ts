/** Texted one-time codes read from a Mac's Messages database. */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { askTwilio, codeFromRows, messagesQuery, setSmsSource, setTwilioSms, smsProblem, smsSource, textedCode, twilioSms, waitForTextedCode } from './sms-code.js';

const row = (at: number, from: string, text: string) => `${at}\u001f${from}\u001f${text}`;

describe('reading a texted code', () => {
  it('takes the newest code, optionally from one sender, and ignores texts with none', () => {
    const rows = [row(200, '+15550001111', 'See you at 6?'), row(190, '22395', 'Your Acme verification code is 482913. Do not share it.'), row(180, '+15550002222', 'G-771204 is your Google verification code.')].join('\n');
    expect(codeFromRows(rows)).toEqual({ code: '482913', from: '22395', at: 190 });
    expect(codeFromRows(rows, 'google')?.code).toBe('771204');
    expect(codeFromRows(row(1, 'x', 'Lunch at 12:30 on 11/15?'))).toBeUndefined();
  });

  it('asks the database with no quote that the Mac shell could read as code', () => {
    const query = messagesQuery(1_763_200_000);
    expect(query).not.toMatch(/['"`$;]\s*\S*(?:rm|curl)/);
    expect(query).not.toMatch(/'/);
    expect(query).toContain('m.is_from_me = 0');
    expect(query).toContain('>= 1763200000');
  });

  it('says how to grant access when macOS refuses, and how to set up sign-in when SSH does', () => {
    expect(smsProblem('Error: unable to open database "/Users/a/Library/Messages/chat.db": unable to open database file', 'a@mac')).toMatch(/Full Disk Access/);
    expect(smsProblem('a@mac: Permission denied (publickey).', 'a@mac')).toMatch(/key sign-in/);
  });

  it('keeps the Mac address in the settings, refuses one that is not an address, and waits until a code comes', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clikcode-sms-'));
    expect(await waitForTextedCode(dir, { since: Date.now() })).toMatchObject({ error: expect.stringMatching(/clikcode computer sms/) });
    await expect(setSmsSource(dir, 'a@mac; rm -rf /')).rejects.toThrow(/user@host/);
    await setSmsSource(dir, 'justin@imac');
    expect(await smsSource(dir)).toBe('justin@imac');
    let asks = 0;
    const found = await waitForTextedCode(dir, { since: 1_000_000, sleep: async () => undefined, ask: async (_t, since) => { asks++; expect(since).toBe(980); return { rows: asks < 3 ? '' : row(1001, '22395', 'Code: 7731') }; } });
    expect(found).toEqual({ code: '7731', from: '22395', at: 1001 });
    await setSmsSource(dir, undefined);
    expect(await smsSource(dir)).toBeUndefined();
  });
});

describe('the code in a real vendor text', () => {
  it.each([
    ['Your CallHub-OTP-Verify verification code is: 3250', '3250'],
    ['Your verification PIN is: 5824', '5824'],
    ['Vonage code: 1045. Valid for 3 minutes.', '1045'],
    ['*9644* is your verification code.', '9644'],
    ['Welcome to SMSGlobal, your verification code is 604061. Use this to continue', '604061'],
    ['873179 is your verification code for app.chekhub.com.', '873179'],
    ['Your OTP: 4410', '4410'],
  ])('%s', (text, code) => { expect(textedCode(text)).toBe(code); });

  it('finds no code in a text without one', () => {
    expect(textedCode('Your order has shipped and will arrive Tuesday.')).toBeUndefined();
  });
});

describe('a Twilio number as the sign-up phone', () => {
  const AC = `AC${'0'.repeat(32)}`;
  it('is kept as number and account, and refuses anything else', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clikcode-sms-'));
    await expect(setTwilioSms(dir, { number: '7192497747', account: AC })).rejects.toThrow(/\+<country>/);
    await setTwilioSms(dir, { number: '+17192497747', account: AC });
    expect(await twilioSms(dir)).toEqual({ number: '+17192497747', account: AC });
    await setTwilioSms(dir, undefined);
    expect(await twilioSms(dir)).toBeUndefined();
  });
  it('reads inbound texts after the time asked, newest first, as rows the code reader takes', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clikcode-sms-'));
    const now = Math.floor(Date.now() / 1000);
    let asked = '';
    const fetcher = (async (url: string) => { asked = url; return new Response(JSON.stringify({ messages: [
      { direction: 'outbound-api', from: '+17192497747', body: 'Your code is 999999', date_sent: new Date(now * 1000).toUTCString() },
      { direction: 'inbound', from: '22395', body: 'Your Twilio code is 305614', date_sent: new Date(now * 1000).toUTCString() },
      { direction: 'inbound', from: '12345', body: 'Old code 111111', date_sent: new Date((now - 3600) * 1000).toUTCString() },
    ] }), { status: 200 }); }) as unknown as typeof fetch;
    const got = await askTwilio(dir, { number: '+17192497747', account: AC }, now - 60, undefined, fetcher, { sid: 'SKtest', key: 'secret' });
    if ('error' in got) throw new Error(got.error);
    expect(asked).toContain('To=%2B17192497747');
    expect(codeFromRows(got.rows)).toMatchObject({ code: '305614', from: '22395' });
  });
  it('waits on the Twilio number and the Mac together: a code on either is found, a Mac that cannot be read does not stop it', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clikcode-sms-'));
    await setSmsSource(dir, 'justin@imac');
    await setTwilioSms(dir, { number: '+17192497747', account: AC });
    const at = Math.floor(Date.now() / 1000);
    const viaTwilio = await waitForTextedCode(dir, { since: Date.now(), seconds: 5, sleep: async () => undefined, ask: async () => ({ error: 'The Mac is asleep' }), askTwilio: async () => ({ rows: `${at}\u001f22395\u001fYour code is 482913` }) });
    expect(viaTwilio).toMatchObject({ code: '482913' });
    const viaMac = await waitForTextedCode(dir, { since: Date.now(), seconds: 5, sleep: async () => undefined, ask: async () => ({ rows: `${at}\u001f+1555\u001fcode: 7788` }), askTwilio: async () => ({ rows: '' }) });
    expect(viaMac).toMatchObject({ code: '7788' });
    const neither = await waitForTextedCode(dir, { since: Date.now(), seconds: 5, sleep: async () => undefined, ask: async () => ({ error: 'The Mac is asleep' }), askTwilio: async () => ({ error: 'Twilio said 401' }) });
    expect(neither).toMatchObject({ error: expect.stringMatching(/Twilio said 401|Mac is asleep/) });
  });
});
