/** Texted one-time codes read from a Mac's Messages database. */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { codeFromRows, messagesQuery, setSmsSource, smsProblem, smsSource, waitForTextedCode } from './sms-code.js';

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
