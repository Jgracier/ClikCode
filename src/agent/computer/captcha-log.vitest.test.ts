/** The record of which human checks were met and how they ended. */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { captchaTally, familyOf, recordCaptcha, stepOf } from './captcha-log.js';

describe('the captcha log', () => {
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
    expect(stepOf('GeeTest slide: the gap is 120px in, dragging 120px')).toBe('slide');
    expect(stepOf('something else')).toBeUndefined();
    expect(familyOf('recaptcha', ['pictures'])).toBe('recaptcha');
    expect(familyOf(undefined, ['board'])).toBe('geetest');
    expect(familyOf(undefined, [])).toBe('unknown');
  });
});
