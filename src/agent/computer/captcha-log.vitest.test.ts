/** The record of which human checks were met and how they ended. */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { captchaCost, captchaTally, familyOf, heldOffHosts, recaptchaRefusedRecently, recordCaptcha, recordVotes, saveSamples, shouldHoldOff, stepOf, voterOrder, weakKinds } from './captcha-log.js';

describe('the captcha log', () => {
  it("remembers Google's reCAPTCHA refusal for six hours, on every site", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clikcode-captcha-log-'));
    const now = Date.parse('2026-11-20T12:00:00Z');
    await recordCaptcha(dir, { at: new Date(now - 60_000).toISOString(), host: 'a.example', family: 'recaptcha', outcome: 'still-there', seconds: 90, steps: ['pictures', 'audio'] });
    await recordCaptcha(dir, { at: new Date(now - 60_000).toISOString(), host: 'b.example', family: 'hcaptcha', outcome: 'still-there', seconds: 90, steps: ['refused'] });
    expect(await recaptchaRefusedRecently(dir, now)).toBe(false);
    await recordCaptcha(dir, { at: new Date(now - 2 * 3_600_000).toISOString(), host: 'a.example', family: 'recaptcha', outcome: 'still-there', seconds: 90, steps: ['pictures', 'audio', 'refused'] });
    expect(await recaptchaRefusedRecently(dir, now)).toBe(true);
    expect(await recaptchaRefusedRecently(dir, now + 5 * 3_600_000)).toBe(false);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("judges Google's refusal per way out: home's refusal says nothing of a tunnel's, and old records without an egress are home's", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clikcode-captcha-log-'));
    const now = Date.parse('2026-11-20T12:00:00Z');
    await recordCaptcha(dir, { at: new Date(now - 60_000).toISOString(), host: 'a.example', family: 'recaptcha', outcome: 'still-there', seconds: 90, steps: ['pictures', 'refused'] });
    expect(await recaptchaRefusedRecently(dir, now)).toBe(true);
    expect(await recaptchaRefusedRecently(dir, now, 'home')).toBe(true);
    expect(await recaptchaRefusedRecently(dir, now, 'prod')).toBe(false);
    await recordCaptcha(dir, { at: new Date(now - 60_000).toISOString(), host: 'b.example', family: 'recaptcha', outcome: 'still-there', seconds: 90, steps: ['refused'], egress: 'prod' });
    expect(await recaptchaRefusedRecently(dir, now, 'prod')).toBe(true);
    expect(await recaptchaRefusedRecently(dir, now, 'phone')).toBe(false);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('counts runs and clears per family over the window, most runs first', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clikcode-captcha-log-'));
    const now = Date.parse('2026-11-14T12:00:00Z');
    const at = (daysAgo: number) => new Date(now - daysAgo * 86_400_000).toISOString();
    await recordCaptcha(dir, { at: at(1), host: 'a.example', family: 'recaptcha', outcome: 'cleared', seconds: 0, steps: ['press'] });
    await recordCaptcha(dir, { at: at(2), host: 'b.example', family: 'recaptcha', outcome: 'still-there', seconds: 120, steps: ['pictures', 'audio'] });
    await recordCaptcha(dir, { at: at(3), host: 'c.example', family: 'geetest', outcome: 'cleared', seconds: 6, steps: ['slide'] });
    await recordCaptcha(dir, { at: at(60), host: 'old.example', family: 'hcaptcha', outcome: 'cleared', seconds: 30, steps: ['click'] });
    expect(await captchaTally(dir, 30, now)).toEqual([{ family: 'recaptcha', runs: 2, cleared: 1, seconds: 120 }, { family: 'geetest', runs: 1, cleared: 1, seconds: 6 }]);
    expect(await captchaTally(path.join(dir, 'missing'), 30, now)).toEqual([]);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('names the step and the family from what the solver said it did', () => {
    expect(stepOf('16 squares, "Select all squares with buses" pass 1: asked 16, picked [5]')).toBe('pictures');
    expect(stepOf('audio: typing 3 words')).toBe('audio');
    expect(stepOf('audio: not offered here (Google refused it)')).toBe('refused');
    expect(stepOf('Google refused: try again later (automated queries)')).toBe('refused');
    expect(stepOf('GeeTest slide: the gap is 120px in, dragging 120px')).toBe('slide');
    expect(stepOf('something else')).toBeUndefined();
    expect(familyOf('recaptcha', ['pictures'])).toBe('recaptcha');
    expect(familyOf(undefined, ['board'])).toBe('geetest');
    expect(familyOf(undefined, [])).toBe('unknown');
  });

  it('leaves a site alone for half an hour after it refused three answers in a row', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clikcode-captcha-log-'));
    const now = Date.parse('2026-11-14T12:00:00Z');
    const run = (host: string, outcome: string, minutesAgo: number) => recordCaptcha(dir, { at: new Date(now - minutesAgo * 60_000).toISOString(), host, family: 'hcaptcha', outcome, seconds: 40, steps: ['click'] });
    await run('a.example', 'still-there', 20); await run('a.example', 'still-there', 10);
    expect(await shouldHoldOff(dir, 'a.example', now)).toBe(false);
    await run('a.example', 'still-there', 5);
    expect(await shouldHoldOff(dir, 'a.example', now)).toBe(true);
    // Another site is not affected, a clear ends the streak, and the hold lapses by itself.
    expect(await shouldHoldOff(dir, 'b.example', now)).toBe(false);
    expect(await shouldHoldOff(dir, 'a.example', now + 31 * 60_000)).toBe(false);
    await run('a.example', 'cleared', 1);
    expect(await shouldHoldOff(dir, 'a.example', now)).toBe(false);
  });

  it('names the challenge kinds that never clear, once they have been met three times', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clikcode-captcha-log-'));
    const now = Date.parse('2026-11-14T12:00:00Z');
    const run = (kinds: string[], outcome: string) => recordCaptcha(dir, { at: new Date(now - 3_600_000).toISOString(), host: 'a.example', family: 'hcaptcha', outcome, seconds: 40, steps: ['click'], kinds });
    await run(['drag the segments', 'click the odd one'], 'still-there');
    await run(['drag the segments'], 'still-there');
    expect([...await weakKinds(dir, now)]).toEqual([]);
    await run(['drag the segments', 'click the odd one'], 'still-there');
    await run(['click the odd one'], 'cleared');
    expect([...await weakKinds(dir, now)]).toEqual(['drag the segments']);
  });

  it('adds up what the runs asked of the models, and how much of it went to the subscription', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clikcode-captcha-log-'));
    const now = Date.parse('2026-11-14T12:00:00Z');
    const run = (models: Record<string, number>) => recordCaptcha(dir, { at: new Date(now - 60_000).toISOString(), host: 'a.example', family: 'hcaptcha', outcome: 'cleared', seconds: 30, steps: ['click'], asks: Object.values(models).reduce((a, b) => a + b, 0), models });
    await run({ 'gpt-4.1-mini': 16, 'claude-sonnet-5-5': 17 }); await run({ 'claude-sonnet-5-5': 2, 'subscription-claude': 1 });
    expect(await captchaCost(dir, 30, now)).toEqual({ asks: 36, subscription: 1, models: [{ model: 'claude-sonnet-5-5', asks: 19 }, { model: 'gpt-4.1-mini', asks: 16 }, { model: 'subscription-claude', asks: 1 }] });
    expect(await heldOffHosts(dir, now)).toEqual([]);
  });

  it('orders the voters of a kind of question by how often they sided with an accepted answer, once measured enough', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clikcode-captcha-log-'));
    const votes = (model: string, right: number, wrong: number) => [...Array.from({ length: right }, () => ({ roster: 'tile', model, withWinner: true })), ...Array.from({ length: wrong }, () => ({ roster: 'tile', model, withWinner: false }))];
    await recordVotes(dir, [...votes('fast', 12, 8), ...votes('careful', 19, 1), ...votes('new', 3, 0)]);
    // "new" has too few answers to be placed; the roster's own order still decides where it goes.
    expect(await voterOrder(dir)).toEqual({ tile: ['careful', 'fast'] });
    await recordVotes(dir, votes('new', 17, 0));
    expect((await voterOrder(dir)).tile).toEqual(['new', 'careful', 'fast']);
  });

  it('keeps the hard questions of a run with their pictures and outcome, newest 300', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clikcode-captcha-log-'));
    await saveSamples(dir, 'cleared', 'hcaptcha', [{ roster: 'click', text: 'Click the odd one', images: [{ mimeType: 'image/png', data: Buffer.from('png').toString('base64') }], answers: { 'claude-sonnet-5-5': '{"points":[]}' } }], new Date('2026-11-14T12:00:00Z'));
    const root = path.join(dir, 'computer', 'captcha-samples');
    const [one] = await fs.readdir(root);
    expect((await fs.readFile(path.join(root, one!, 'picture-1.png'))).toString()).toBe('png');
    expect(JSON.parse(await fs.readFile(path.join(root, one!, 'question.json'), 'utf8'))).toMatchObject({ outcome: 'cleared', family: 'hcaptcha', roster: 'click', pictures: ['picture-1.png'] });
  });
});

describe('the captcha log on disk', () => {
  it('is rotated past its size limit, keeping only the newest recent lines', async () => {
    const { CAPTCHA_LOG_MAX_BYTES, captchaLogPath } = await import('./captcha-log.js');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clikcode-captcha-log-'));
    const now = Date.parse('2026-11-20T12:00:00Z');
    const file = captchaLogPath(dir);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const old = JSON.stringify({ at: new Date(now - 40 * 86_400_000).toISOString(), host: 'old.example', family: 'recaptcha', outcome: 'none', seconds: 1, steps: ['x'.repeat(200)] });
    await fs.writeFile(file, `${old}\n`.repeat(Math.ceil(CAPTCHA_LOG_MAX_BYTES / old.length) + 5));
    await recordCaptcha(dir, { at: new Date(now).toISOString(), host: 'new.example', family: 'turnstile', outcome: 'cleared', seconds: 2, steps: ['press'] }, now);
    const after = await fs.readFile(file, 'utf8');
    expect(after.length).toBeLessThan(CAPTCHA_LOG_MAX_BYTES);
    expect(after).toContain('new.example');
    expect(after).not.toContain('old.example');
  });

  it('is read from disk once while it is unchanged', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clikcode-captcha-log-'));
    const now = Date.parse('2026-11-20T12:00:00Z');
    await recordCaptcha(dir, { at: new Date(now).toISOString(), host: 'a.example', family: 'recaptcha', outcome: 'still-there', seconds: 9, steps: ['pictures', 'refused'] });
    const { vi } = await import('vitest');
    const read = vi.spyOn(fs, 'readFile');
    try {
      await shouldHoldOff(dir, 'a.example', now);
      await weakKinds(dir, now);
      await recaptchaRefusedRecently(dir, now);
      expect(read.mock.calls.filter(call => String(call[0]).endsWith('captcha-log.jsonl')).length).toBe(1);
    } finally { read.mockRestore(); }
  });
});
