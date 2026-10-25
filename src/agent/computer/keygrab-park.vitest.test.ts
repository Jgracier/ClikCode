import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backoffUntil, clearParked, listParked, loadParked, markerFor, recordBackoff, saveParked, type ParkedRecord } from './keygrab-park.js';
import { beginJournal, exportJournal, importJournal, noteStep, recordVerified } from './recipe-recorder.js';
import { getRecipe } from './signup-recipes.js';

let dir = '';
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kg-park-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });
const rec = (id: string, over: Partial<ParkedRecord> = {}): ParkedRecord => ({ id, marker: markerFor(id), parkedAt: new Date().toISOString(), url: 'https://app.snyk.io/', vendorUrl: 'https://probely.com', trail: [], controls: [], visited: [], menus: [], why: 'x', ...over });

describe('parked keygrab records', () => {
  it('saves, loads, lists and clears a record', async () => {
    await saveParked(dir, rec('probely'));
    await saveParked(dir, rec('here-tracking', { parkedAt: new Date(Date.now() + 1000).toISOString() }));
    expect((await loadParked(dir, 'probely'))?.vendorUrl).toBe('https://probely.com');
    expect((await listParked(dir)).map(r => r.id)).toEqual(['probely', 'here-tracking']);
    await clearParked(dir, 'probely');
    expect(await loadParked(dir, 'probely')).toBeUndefined();
  });
});

describe('6 hour back-off', () => {
  it('holds for six hours from the captcha and then ends', async () => {
    const t0 = new Date('2026-10-25T12:00:00Z');
    const until = await recordBackoff(dir, 'musixmatch', t0);
    expect(until.toISOString()).toBe('2026-10-25T18:00:00.000Z');
    expect((await backoffUntil(dir, 'musixmatch', new Date('2026-10-25T17:59:00Z')))?.toISOString()).toBe(until.toISOString());
    expect(await backoffUntil(dir, 'musixmatch', new Date('2026-10-25T18:00:01Z'))).toBeUndefined();
    expect(await backoffUntil(dir, 'probely', t0)).toBeUndefined();
  });
});

describe('a parked journal makes a resumed capture save the recipe', () => {
  it('exports the journal in one process and records the recipe from the imported copy', async () => {
    const key = `${dir}#connectors`;
    beginJournal(key, 'https://probely.com/');
    noteStep(key, 'https://probely.com/', { do: 'click', target: 'Log in' });
    const data = exportJournal(key)!;
    beginJournal(key, 'https://elsewhere.example/'); // the next vendor replaces the live one
    importJournal(key, data);
    noteStep(key, 'https://app.snyk.io/', { do: 'click', target: 'API token' });
    const saved = await recordVerified(dir, key, { kind: 'capture', url: 'https://app.snyk.io/settings/token' });
    expect(saved?.host).toBe('probely.com');
    expect(saved?.steps.map(s => s.target)).toEqual(['Log in', 'API token']);
    expect(await getRecipe(dir, 'probely.com', saved!.loginRoute)).toBeTruthy();
  });
});
