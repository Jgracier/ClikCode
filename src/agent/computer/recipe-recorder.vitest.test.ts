import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { beginJournal, noteStep, recordVerified, recordableStep, safeText } from './recipe-recorder.js';
import { fillPlaceholders, getRecipe, listRecipes, replayRecipe, saveRecipe, type RecipeStep } from './signup-recipes.js';

const tmp = async <T>(fn: (dir: string) => Promise<T>): Promise<T> => { const dir = await mkdtemp(join(tmpdir(), 'clikcode-recorder-')); try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); } };
let n = 0;
const fresh = (url = 'https://app.example.com/') => { const key = `k${++n}`; beginJournal(key, url); return key; };

describe('what is kept of a step', () => {
  it('names controls by text, drops typed text, keeps choices', () => {
    expect(recordableStep({ do: 'click', target: 'e5' }, 'Create API key')).toEqual({ do: 'click', target: 'Create API key' });
    expect(recordableStep({ do: 'click', target: 'Sign in' })).toEqual({ do: 'click', target: 'Sign in' });
    expect(recordableStep({ do: 'fill', target: 'e7', text: 'Acme Corp, 555-0100' }, 'Company')).toEqual({ do: 'fill', target: 'Company' });
    expect(recordableStep({ do: 'choose', target: 'Country', text: 'Canada' })).toEqual({ do: 'choose', target: 'Country', text: 'Canada' });
    expect(recordableStep({ do: 'press', key: 'Enter' })).toEqual({ do: 'press', key: 'Enter' });
    expect(recordableStep({ do: 'scroll' })).toBe('skip');
    expect(recordableStep({ do: 'wait' })).toBe('skip');
  });
  it('a ref with no readable name, or a control named after an id or key, cannot be kept', () => {
    expect(recordableStep({ do: 'click', target: 'e5' })).toBe('spoiled');
    expect(recordableStep({ do: 'click', target: 'Delete project 83196365832' })).toBe('spoiled');
    expect(recordableStep({ do: 'click', target: ['sk', 'live', '4eC39HqLyjWDarjtT1zdp7dc'].join('_') })).toBe('spoiled');
  });
  it('an email in a control name becomes the profile placeholder', () => {
    expect(safeText('Chose me@example.com account')).toBe('Chose {{sso_email}} account');
    expect(fillPlaceholders('{{sso_email}}', { sso_email: 'me@example.com' })).toBe('me@example.com');
    expect(fillPlaceholders('{{sso_email}}', {})).toBe('{{sso_email}}');
  });
});

describe('automatic recipes', () => {
  it('a capture saves the steps, key page without query, hint and route, with no value in the file', () => tmp(async dir => {
    const key = fresh();
    noteStep(key, 'https://app.example.com/', { do: 'click', target: 'e3' }, 'Continue with Google');
    noteStep(key, 'https://accounts.google.com/chooser', { do: 'click', target: 'e1' }, 'Me me@example.com');
    noteStep(key, 'https://app.example.com/home', { do: 'fill', target: 'Company', text: 'Acme Secretive Inc' });
    noteStep(key, 'https://app.example.com/keys', { do: 'click', target: 'Create key' });
    const saved = await recordVerified(dir, key, { kind: 'capture', url: 'https://app.example.com/settings/keys?token=abc#x', hint: 'Click "Create key", then capture_secret.' }, new Date('2026-03-01'));
    expect(saved?.loginRoute).toBe('google');
    expect(saved?.keyPage).toBe('https://app.example.com/settings/keys');
    expect(saved?.steps).toEqual([{ do: 'click', target: 'Continue with Google' }, { do: 'click', target: 'Me {{sso_email}}' }, { do: 'fill', target: 'Company' }, { do: 'click', target: 'Create key' }]);
    const raw = await readFile(join(dir, 'computer', 'recipes', 'app.example.com.json'), 'utf8');
    expect(raw).not.toContain('Acme Secretive');
    expect(raw).not.toContain('me@example.com');
    expect(raw).not.toContain('token=abc');
  }));

  it('keeps only the newest verified recipe per host and route', () => tmp(async dir => {
    const a = fresh(); noteStep(a, 'https://app.example.com/', { do: 'click', target: 'Old path' });
    await recordVerified(dir, a, { kind: 'capture', url: 'https://app.example.com/keys' }, new Date('2026-01-01'));
    const b = fresh(); noteStep(b, 'https://app.example.com/', { do: 'click', target: 'New path' });
    await recordVerified(dir, b, { kind: 'capture', url: 'https://app.example.com/keys' }, new Date('2026-02-01'));
    const all = await listRecipes(dir);
    expect(all).toHaveLength(1);
    expect(all[0]!.steps).toEqual([{ do: 'click', target: 'New path' }]);
    // Another route is a different recipe.
    const c = fresh(); noteStep(c, 'https://github.com/login', { do: 'click', target: 'Continue with GitHub' });
    await recordVerified(dir, c, { kind: 'capture', url: 'https://app.example.com/keys' });
    expect((await listRecipes(dir)).map(r => r.loginRoute).sort()).toEqual(['email', 'github']);
  }));

  it('a login saves a recipe, but never replaces a richer capture recipe', () => tmp(async dir => {
    const a = fresh(); noteStep(a, 'https://app.example.com/', { do: 'click', target: 'Sign in' });
    const login = await recordVerified(dir, a, { kind: 'login' });
    expect(login?.steps).toEqual([{ do: 'click', target: 'Sign in' }]);
    expect(login?.captureHint).toBeUndefined();
    noteStep(a, 'https://app.example.com/keys', { do: 'click', target: 'Create key' });
    const capture = await recordVerified(dir, a, { kind: 'capture', url: 'https://app.example.com/keys', hint: 'Click "Create key".' });
    expect(capture?.captureHint).toContain('Sign in first with the login action');
    const b = fresh(); noteStep(b, 'https://app.example.com/', { do: 'click', target: 'Log in' });
    expect(await recordVerified(dir, b, { kind: 'login' })).toBeUndefined();
    expect((await getRecipe(dir, 'app.example.com'))?.keyPage).toBe('https://app.example.com/keys');
  }));

  it('saves nothing for a login with no steps, a spoiled journal, or a tab that never opened a site', () => tmp(async dir => {
    const none = fresh();
    expect(await recordVerified(dir, none, { kind: 'login' })).toBeUndefined();
    const spoiled = fresh();
    noteStep(spoiled, 'https://app.example.com/', { do: 'click', target: 'e9' });
    noteStep(spoiled, 'https://app.example.com/', { do: 'click', target: 'Create key' });
    expect(await recordVerified(dir, spoiled, { kind: 'capture', url: 'https://app.example.com/keys' })).toBeUndefined();
    expect(await recordVerified(dir, 'never-opened', { kind: 'capture', url: 'https://app.example.com/keys' })).toBeUndefined();
    expect(await listRecipes(dir)).toEqual([]);
  }));

  it('a capture with no clicks still saves the key page and hint (empty steps replay as a note)', () => tmp(async dir => {
    const key = fresh();
    const saved = await recordVerified(dir, key, { kind: 'capture', url: 'https://app.example.com/keys', hint: 'capture_secret reads the key.' });
    expect(saved?.steps).toEqual([]);
    const out = await replayRecipe(saved!, async steps => ({ output: `ran ${steps.length}` }), async () => '');
    expect(out.completed).toBe(true);
    expect(out.output).toContain('Key page: https://app.example.com/keys');
  }));

  it('replays a saved recipe with the profile email put back in', () => tmp(async dir => {
    const key = fresh();
    noteStep(key, 'https://accounts.google.com/chooser', { do: 'click', target: 'e1' }, 'me@example.com');
    noteStep(key, 'https://app.example.com/keys', { do: 'click', target: 'Create key' });
    const saved = (await recordVerified(dir, key, { kind: 'capture', url: 'https://app.example.com/keys' }))!;
    expect(saved.steps[0]!.target).toBe('{{sso_email}}');
    let seen: RecipeStep[] = [];
    const replay = { ...saved, steps: saved.steps.map(s => ({ ...s, target: fillPlaceholders(s.target, { sso_email: 'me@example.com' }) })) };
    const out = await replayRecipe(replay, async steps => { seen = steps; return { output: 'ok' }; }, async () => 'Create key');
    expect(out.completed).toBe(true);
    expect(seen.map(s => s.target)).toEqual(['me@example.com', 'Create key']);
    // And a saved recipe is still accepted by the agent-facing save with placeholders.
    await expect(saveRecipe(dir, { host: 'x.com', loginRoute: 'google', steps: saved.steps })).resolves.toBeTruthy();
  }));
});

describe('compactSteps', () => {
  const click = (target: string) => ({ do: 'click' as const, target });
  it('keeps only the last lap of a journey that went round in circles', async () => {
    const { compactSteps } = await import('./recipe-recorder.js');
    const steps = [click('Add API key'), { do: 'fill' as const, target: 'Name' }, click('Generate key'), click('Select a team'), click('Add API key'), { do: 'fill' as const, target: 'Name' }, click('Generate key'), click('Select a team'), click('Global (account)'), click('Add'), click('Generate key')];
    expect(compactSteps(steps).map(s => s.target)).toEqual(['Add API key', 'Name', 'Generate key', 'Select a team', 'Global (account)', 'Add', 'Generate key']);
  });
  it('never cuts a lone repeated press', async () => {
    const { compactSteps } = await import('./recipe-recorder.js');
    const steps = [click('Next'), { do: 'fill' as const, target: 'Name' }, click('Next')];
    expect(compactSteps(steps)).toEqual(steps);
  });
});
