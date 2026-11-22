/** Texted one-time codes read from a Mac's Messages database. */
import { describe, expect, it, onTestFinished } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { askTwilio, codeFromRows, codesFromRows, messagesQuery, setSmsSource, setTwilioSms, smsProblem, smsSource, textedCode, twilioSms, waitForTextedCode } from './sms-code.js';

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
    const found = await waitForTextedCode(dir, { since: 1_000_000, sleep: async () => undefined, ask: async (_t, since) => { asks++; expect(since).toBe(995); return { rows: asks < 3 ? '' : row(1001, '22395', 'Code: 7731') }; } });
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
    // Every number of the account is read: the sign-up number and the ones in other countries.
    const toNumbers: string[] = [];
    const both = await askTwilio(dir, { number: '+17192497747', account: AC, others: ['+18734578891'] }, now - 60, undefined, (async (url: string) => { toNumbers.push(new URL(url).searchParams.get('To')!); return new Response(JSON.stringify({ messages: [] }), { status: 200 }); }) as unknown as typeof fetch, { sid: 'SKtest', key: 'secret' });
    expect('error' in both).toBe(false);
    expect(toNumbers).toEqual(['+17192497747', '+18734578891']);
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
    const neither = await waitForTextedCode(dir, { since: Date.now(), seconds: 5, sleep: () => new Promise(r => setTimeout(r, 100)), ask: async () => ({ error: 'The Mac is asleep' }), askTwilio: async () => ({ error: 'Twilio said 401' }) });
    expect(neither).toMatchObject({ error: expect.stringMatching(/Twilio said 401|Mac is asleep/) });
  }, 15_000);
});

it('does not wait for a hung Mac when Twilio already has the code', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clikcode-sms-'));
  onTestFinished(() => fs.rm(dir, { recursive: true, force: true }));
  await setSmsSource(dir, 'user@mac');
  await setTwilioSms(dir, { number: '+17192497747', account: 'AC' + 'a'.repeat(32) });
  let macSignal: AbortSignal | undefined;
  const at = Math.floor(Date.now() / 1000);
  const result = await waitForTextedCode(dir, { since: Date.now(), ask: async (_target, _since, signal) => { macSignal = signal; return new Promise(() => undefined); }, askTwilio: async () => ({ rows: `${at}\u001f22395\u001fYour code is 482913` }) });
  expect(result).toMatchObject({ code: '482913' });
  expect(macSignal?.aborted).toBe(true);
}, 1000);

it('keeps polling Twilio while the Mac request remains hung', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clikcode-sms-'));
  onTestFinished(() => fs.rm(dir, { recursive: true, force: true }));
  await setSmsSource(dir, 'user@mac');
  await setTwilioSms(dir, { number: '+17192497747', account: 'AC' + 'a'.repeat(32) });
  let calls = 0;
  const at = Math.floor(Date.now() / 1000);
  const result = await waitForTextedCode(dir, { since: Date.now(), sleep: async () => undefined, ask: async () => new Promise(() => undefined), askTwilio: async () => ({ rows: ++calls < 3 ? '' : `${at}\u001f22395\u001fYour code is 482913` }) });
  expect(result).toMatchObject({ code: '482913' });
  expect(calls).toBe(3);
}, 1000);

describe('a texted code is handed out once, and only a new one for this site', () => {
  const setup = async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clikcode-sms-'));
    onTestFinished(() => fs.rm(dir, { recursive: true, force: true }));
    await setSmsSource(dir, 'user@mac');
    return dir;
  };
  it('never returns the same code twice: a resend gets the new one, a second agent does not get the first one', async () => {
    const dir = await setup();
    const at = Math.floor(Date.now() / 1000);
    let rows = row(at, '22395', 'Your Acme code is 111111');
    const ask = async () => ({ rows });
    const first = await waitForTextedCode(dir, { since: Date.now(), sleep: async () => undefined, ask });
    expect(first).toMatchObject({ code: '111111' });
    let polls = 0;
    const second = await waitForTextedCode(dir, { since: Date.now() - 1000, sleep: async () => { if (++polls === 2) rows = `${row(at + 1, '22395', 'Your Acme code is 222222')}\n${rows}`; }, ask });
    expect(second).toMatchObject({ code: '222222' });
  });
  it('does not take a text sent before the request', async () => {
    const dir = await setup();
    const now = Math.floor(Date.now() / 1000);
    const result = await waitForTextedCode(dir, { since: Date.now(), seconds: 5, sleep: async () => { await new Promise(r => setTimeout(r, 200)); }, ask: async () => ({ rows: row(now - 60, '22395', 'Your code is 333333') }) });
    expect(result).toMatchObject({ error: expect.stringMatching(/No new texted code/) });
  }, 10_000);
  it('with a site, takes only a text naming it', async () => {
    const dir = await setup();
    const at = Math.floor(Date.now() / 1000);
    const rows = [row(at + 2, '+15550001111', 'Your Other code is 444444'), row(at + 1, '22395', 'Your Acme verification code is 555555')].join('\n');
    expect(await waitForTextedCode(dir, { since: Date.now(), site: 'https://app.acme.com/signup', sleep: async () => undefined, ask: async () => ({ rows }) })).toMatchObject({ code: '555555' });
    expect(codesFromRows(rows, { site: 'https://app.acme.com/' }).map(c => c.code)).toEqual(['555555']);
    expect(codesFromRows(rows, { from: 'any' }).map(c => c.code)).toEqual(['444444', '555555']);
  });
  it('on the sign-up number, takes a text that does not name the site after the ones that do; on the Mac it never does', async () => {
    const dir = await setup();
    await setTwilioSms(dir, { number: '+17192497747', account: `AC${'0'.repeat(32)}` });
    const at = Math.floor(Date.now() / 1000);
    const unnamed = row(at + 1, '22395', 'Your verification code is 818181');
    const twilio = await waitForTextedCode(dir, { since: Date.now(), site: 'https://app.acme.com/signup', sleep: async () => undefined, ask: async () => ({ rows: '' }), askTwilio: async () => ({ rows: unnamed }) });
    expect(twilio).toMatchObject({ code: '818181' });
    const both = [row(at + 3, '22395', 'Your code is 919191'), row(at + 2, '22395', 'Your Acme code is 727272')].join('\n');
    expect(await waitForTextedCode(dir, { since: Date.now(), site: 'https://app.acme.com/signup', sleep: async () => undefined, ask: async () => ({ rows: '' }), askTwilio: async () => ({ rows: both }) })).toMatchObject({ code: '727272' });
    const macOnly = await setup();
    const mac = await waitForTextedCode(macOnly, { since: Date.now(), seconds: 2, site: 'https://app.acme.com/signup', sleep: () => new Promise(r => setTimeout(r, 100)), ask: async () => ({ rows: row(at + 1, '22395', 'Your bank code is 646464') }) });
    expect(mac).toMatchObject({ error: expect.stringMatching(/No new texted code/) });
  }, 10_000);
  it('asks a source again after an error instead of giving it up for the whole wait', async () => {
    const dir = await setup();
    const at = Math.floor(Date.now() / 1000);
    let asks = 0;
    const result = await waitForTextedCode(dir, { since: Date.now(), sleep: async () => undefined, ask: async () => (++asks < 3 ? { error: 'ssh: connection reset' } : { rows: row(at, '22395', 'Code: 6677') }) });
    expect(result).toMatchObject({ code: '6677' });
    expect(asks).toBe(3);
  });
  it('reports a source error only when every source failed throughout', async () => {
    const dir = await setup();
    await setTwilioSms(dir, { number: '+17192497747', account: `AC${'0'.repeat(32)}` });
    const allFailed = await waitForTextedCode(dir, { since: Date.now(), seconds: 5, sleep: () => new Promise(r => setTimeout(r, 100)), ask: async () => ({ error: 'The Mac is asleep' }), askTwilio: async () => ({ error: 'Twilio said 401' }) });
    expect(allFailed).toMatchObject({ error: expect.stringMatching(/Twilio said 401.*Mac is asleep|Mac is asleep.*Twilio said 401/) });
    const oneAnswered = await waitForTextedCode(dir, { since: Date.now(), seconds: 5, sleep: () => new Promise(r => setTimeout(r, 100)), ask: async () => ({ error: 'The Mac is asleep' }), askTwilio: async () => ({ rows: '' }) });
    expect(oneAnswered).toMatchObject({ error: expect.stringMatching(/No new texted code/) });
  }, 20_000);
});

describe('changing the Twilio setting', () => {
  const AC = `AC${'1'.repeat(32)}`;
  it('keeps the other numbers when the sign-up number is set again, and adds and removes them', async () => {
    const { applyTwilioSetting } = await import('./sms-code.js');
    const withCa = { number: '+17192497747', account: AC, others: ['+18734578891'] };
    expect(applyTwilioSetting(withCa, `+17192490000:${AC}`)).toEqual({ number: '+17192490000', account: AC, others: ['+18734578891'] });
    expect(applyTwilioSetting(withCa, `+17192490000:AC${'2'.repeat(32)}`)).toEqual({ number: '+17192490000', account: `AC${'2'.repeat(32)}` });
    expect(applyTwilioSetting({ number: '+17192497747', account: AC }, 'add:+447700900123')).toEqual({ number: '+17192497747', account: AC, others: ['+447700900123'] });
    expect(applyTwilioSetting(withCa, 'remove:+18734578891')).toEqual({ number: '+17192497747', account: AC });
    expect(applyTwilioSetting(withCa, 'off')).toBeUndefined();
    expect(() => applyTwilioSetting(undefined, 'add:+447700900123')).toThrow(/sign-up number first/);
  });
});
