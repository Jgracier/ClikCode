import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compactRecipeSteps, compactSavedRecipes, dryRunRecipe, lintRecipe, type DryRunPort, type DryView } from './recipe-tools.js';
import { getRecipe, saveRecipe, type RecipeStep } from './signup-recipes.js';
import { beginJournal, noteStep, recordVerified } from './recipe-recorder.js';

const click = (target: string): RecipeStep => ({ do: 'click', target });
const fill = (target: string): RecipeStep => ({ do: 'fill', target });
/** The recipe saved for plus.probely.app on 2026-10-25, step for step. */
const PROBELY: RecipeStep[] = [
  click('Add API key'), fill('Name'), click('Generate key'), click('Select a team'),
  click('Add API key'), fill('Name'), click('Generate key'), click('Select a team'), click('Global (account)'), click('Select a role'), click('Developer'), click('Add'), click('Generate key'),
  click('Add API key'), fill('Name'), click('Generate key'), click('Select a team'), click('Global (account)'), click('Global (account)'), click('Select a role'), click('Developer'), click('Add'), click('Generate key'),
  click('Add API key'),
];
const names = (steps: RecipeStep[]): string[] => steps.map(s => `${s.do}:${s.target}`);

describe('lintRecipe', () => {
  it('flags the repeated laps, the toggle, the dangling click and the missing capture of the probely recipe', () => {
    const codes = lintRecipe({ steps: PROBELY }).map(f => f.code);
    expect(codes).toEqual(expect.arrayContaining(['repeated-lap', 'duplicate-click', 'trailing-click', 'no-capture']));
  });
  it('is quiet about a clean recipe and about a lone repeated press', () => {
    expect(lintRecipe({ steps: [click('Add API key'), fill('Name'), click('Create')], keyPage: 'https://a.example/keys' })).toEqual([]);
    expect(lintRecipe({ steps: [click('Next'), fill('Name'), click('Next')], captureHint: 'x' })).toEqual([]);
  });
});

describe('compactRecipeSteps', () => {
  it('keeps the last lap, one selection of a repeated option, and drops the click back to the start', () => {
    const { steps, removed } = compactRecipeSteps(PROBELY);
    expect(names(steps)).toEqual(['click:Add API key', 'fill:Name', 'click:Generate key', 'click:Select a team', 'click:Global (account)', 'click:Select a role', 'click:Developer', 'click:Add', 'click:Generate key']);
    expect(removed).toBe(PROBELY.length - steps.length);
  });
  it('removes a toggled pair that is not a menu option, and keeps an odd one', () => {
    expect(names(compactRecipeSteps([click('Open'), click('Notify me'), click('Notify me'), click('Create')]).steps)).toEqual(['click:Open', 'click:Create']);
    expect(names(compactRecipeSteps([click('Open'), click('Notify me'), click('Notify me'), click('Notify me'), click('Create')]).steps)).toEqual(['click:Open', 'click:Notify me', 'click:Create']);
  });
  it('is idempotent and leaves a clean recipe alone', () => {
    const once = compactRecipeSteps(PROBELY).steps;
    expect(compactRecipeSteps(once)).toEqual({ steps: once, removed: 0 });
  });
});

describe('compactSavedRecipes and the recorder', () => {
  it('keeps the earlier file as .bak and the verification date', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'recipes-'));
    const saved = await saveRecipe(dir, { host: 'plus.probely.app', loginRoute: 'email', steps: PROBELY, keyPage: 'https://plus.probely.app/api-keys/add' }, new Date('2026-10-25T22:54:44Z'));
    const [report] = await compactSavedRecipes(dir, 'plus.probely.app');
    expect(report!.removed).toBe(PROBELY.length - 9);
    const bak = JSON.parse(await readFile(`${report!.backup}`, 'utf8')) as Array<{ steps: unknown[] }>;
    expect(bak[0]!.steps).toHaveLength(PROBELY.length);
    const after = (await getRecipe(dir, 'plus.probely.app'))!;
    expect(after.steps).toHaveLength(9);
    expect(after.verifiedAt).toBe(saved.verifiedAt);
    expect(await compactSavedRecipes(dir, 'plus.probely.app').then(r => r[0]!.removed)).toBe(0);
  });
  it('compacts after a verified capture and keeps the recorded journey in .bak', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'recipes-'));
    const key = `${dir}#t`;
    beginJournal(key, 'https://plus.probely.app/');
    for (const s of PROBELY) noteStep(key, 'https://plus.probely.app/', s);
    const recipe = await recordVerified(dir, key, { kind: 'capture', url: 'https://plus.probely.app/api-keys/add' });
    expect(recipe?.steps).toHaveLength(9);
    expect((await readdir(join(dir, 'computer', 'recipes'))).sort()).toEqual(['plus.probely.app.json', 'plus.probely.app.json.bak']);
  });
});

/** A fake probely key page: Add API key opens the form, the selectors open their options. Records every press. */
function fakeProbely(over: { missing?: string[] } = {}): { port: DryRunPort; pressed: string[]; opened: string[] } {
  let state: 'list' | 'form' | 'team' | 'role' = 'list';
  const pressed: string[] = [], opened: string[] = [];
  const views: Record<typeof state, DryView> = {
    list: { text: 'API keys', controls: [{ name: 'Add API key' }], fields: [] },
    form: { text: 'New key', controls: [{ name: 'Select a team' }, { name: 'Select a role' }, { name: 'Generate key' }], fields: ['Name'] },
    team: { text: 'New key', controls: [{ name: 'Select a team' }, { name: 'Global (account)' }, { name: 'Select a role' }, { name: 'Generate key' }], fields: ['Name'] },
    role: { text: 'New key', controls: [{ name: 'Select a role' }, { name: 'Developer' }, { name: 'Admin' }, { name: 'Add' }, { name: 'Generate key' }], fields: ['Name'] },
  };
  const port: DryRunPort = {
    open: async url => { opened.push(url); state = 'list'; return undefined; },
    look: async () => { const v = views[state]; return { ...v, controls: v.controls.filter(c => !over.missing?.includes(c.name)) }; },
    click: async name => {
      pressed.push(name);
      if (name === 'Add API key') state = 'form'; else if (name === 'Select a team') state = 'team'; else if (name === 'Select a role') state = 'role';
      return undefined;
    },
  };
  return { port, pressed, opened };
}

describe('dryRunRecipe', () => {
  const compacted = compactRecipeSteps(PROBELY).steps;
  it('checks every target on the live page and never presses a submit', async () => {
    const site = fakeProbely();
    const report = await dryRunRecipe({ host: 'plus.probely.app', steps: compacted, keyPage: 'https://plus.probely.app/api-keys/add' }, site.port);
    expect(site.opened).toEqual(['https://plus.probely.app/api-keys/add']);
    expect(report.ok).toBe(true);
    expect(site.pressed).toEqual(['Add API key', 'Select a team', 'Global (account)', 'Select a role', 'Developer']);
    expect(report.steps.filter(s => s.status === 'missing')).toEqual([]);
    expect(report.steps.find(s => s.step.includes('Generate key'))?.note).toMatch(/not pressed/);
  });
  it('reports a step whose target is gone', async () => {
    const site = fakeProbely({ missing: ['Developer'] });
    const report = await dryRunRecipe({ host: 'plus.probely.app', steps: compacted }, site.port);
    expect(report.ok).toBe(false);
    expect(report.steps.find(s => s.status === 'missing')?.step).toContain('Developer');
  });
  it('signs in when the first target is not there, then opens the page again', async () => {
    const site = fakeProbely();
    let signedIn = false;
    const port: DryRunPort = { ...site.port, look: async () => signedIn ? site.port.look() : { text: 'Log in', controls: [{ name: 'Log in' }], fields: ['Email'] }, login: async () => { signedIn = true; return true; } };
    const report = await dryRunRecipe({ host: 'plus.probely.app', steps: compacted }, port);
    expect(report.ok).toBe(true);
    expect(site.opened).toHaveLength(2);
  });
});
