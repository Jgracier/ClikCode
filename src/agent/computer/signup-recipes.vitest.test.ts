import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectBlocker, getRecipe, listRecipes, recipeProblem, replayRecipe, saveRecipe, type RecipeStep } from './signup-recipes.js';

const steps: RecipeStep[] = [{ do: 'click', target: 'Continue with Google' }, { do: 'fill', target: 'Company' }, { do: 'click', target: 'Create API key' }];
const tmp = async <T>(fn: (dir: string) => Promise<T>): Promise<T> => { const dir = await mkdtemp(join(tmpdir(), 'clikcode-recipes-')); try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); } };

describe('saving', () => {
  it('stores a recipe per host and route and reads it back, newest verified first', () => tmp(async dir => {
    await saveRecipe(dir, { host: 'www.Example.com', loginRoute: 'email', steps }, new Date('2026-01-01'));
    await saveRecipe(dir, { host: 'example.com', loginRoute: 'google', steps, keyPage: 'https://example.com/keys', captureHint: 'Reveal, then Copy' }, new Date('2026-02-01'));
    expect((await getRecipe(dir, 'example.com'))?.loginRoute).toBe('google');
    expect((await getRecipe(dir, 'example.com', 'email'))?.verifiedAt).toContain('2026-01-01');
    expect(await getRecipe(dir, 'example.com', 'github')).toBeUndefined();
    expect(await getRecipe(dir, 'other.com')).toBeUndefined();
    expect((await listRecipes(dir)).map(r => r.loginRoute).sort()).toEqual(['email', 'google']);
  }));

  it('refuses refs, secrets, passwords, bad routes and bad key pages', () => tmp(async dir => {
    const save = (patch: Record<string, unknown>) => saveRecipe(dir, { host: 'x.com', loginRoute: 'email', steps, ...patch } as never);
    await expect(save({ steps: [{ do: 'click', target: 'e5' }] })).rejects.toThrow('page reference');
    await expect(save({ steps: [{ do: 'fill', target: 'Name', text: ['sk', 'live', '4eC39HqLyjWDarjtT1zdp7dc'].join('_') }] })).rejects.toThrow('key or token');
    await expect(save({ steps: [{ do: 'fill', target: 'Password', text: 'hunter2' }] })).rejects.toThrow('password');
    await expect(save({ steps: [{ do: 'fill', target: 'Display name', text: 'Tr0ub4dor&3xYz' }] })).rejects.toThrow('looks like a password');
    await expect(save({ loginRoute: 'sms' })).rejects.toThrow('login_route');
    await expect(save({ steps: [] })).rejects.toThrow('list of steps');
    await expect(save({ steps: [{ do: 'hack' }] })).rejects.toThrow('unknown action');
    await expect(save({ keyPage: 'https://u:p@x.com/k' })).rejects.toThrow('key_page');
    await expect(save({ captureHint: 'key is 3pV9kQ2mZx8LrT5wYb7NcA1dHf4GjEs6' })).rejects.toThrow('capture_hint');
    await expect(saveRecipe(dir, { host: '../x', loginRoute: 'email', steps })).rejects.toThrow('site name');
    expect(await listRecipes(dir)).toEqual([]);
  }));

  it('keeps ordinary typed text and fills with no text (profile autofill)', () => tmp(async dir => {
    expect(recipeRProblem()).toBeUndefined();
    const r = await saveRecipe(dir, { host: 'x.com', loginRoute: 'email', steps: [{ do: 'fill', target: 'Company', text: 'Acme Inc' }, { do: 'fill', target: 'Email' }] });
    expect(r.steps[1]).toEqual({ do: 'fill', target: 'Email' });
  }));
});
function recipeRProblem() { return recipeProblem({ loginRoute: 'google', steps: [{ do: 'fill', target: 'Email', text: 'me@example.com' }] }); }

describe('detectBlocker', () => {
  it.each([
    ['- heading "Verify you are human"\n- checkbox "I\'m not a robot"', 'a captcha'],
    ['- text: Complete the reCAPTCHA', 'a captcha'],
    ['- text: We sent a text message with a code to your phone', 'an SMS or authenticator code'],
    ['- heading "Set up two-factor authentication"', 'an SMS or authenticator code'],
    ['- textbox "Card number"\n- textbox "CVC"', 'a payment page'],
    ['- text: Your application is under review', 'a review page'],
  ])('%s', (text, want) => expect(detectBlocker(text)).toBe(want));
  it('leaves an ordinary signup and key page alone', () => {
    expect(detectBlocker('- heading "Create your account"\n- textbox "Email"\n- button "Continue with Google"')).toBeUndefined();
    expect(detectBlocker('- heading "API keys"\n- button "Create API key"\n- text: Emailed code sent to your email')).toBeUndefined();
  });
});

describe('replayRecipe', () => {
  const recipe = { host: 'x.com', loginRoute: 'google' as const, steps, verifiedAt: '2026-01-01T00:00:00.000Z', keyPage: 'https://x.com/keys' };
  /** A fake steps runner: runs steps in order against a list of fake pages, calling the guard after each. */
  const fake = (pages: string[], failAt = -1) => {
    let shown = '';
    const ran: string[] = [];
    const run = async (list: RecipeStep[], guard: () => Promise<string | undefined>) => {
      for (const [i, step] of list.entries()) {
        if (i === failAt) return { output: `Step ${i + 1} (${step.do} ${step.target}) failed: not found\n\nPage now: ${pages[i]}`, isError: true };
        ran.push(step.target ?? step.do); shown = pages[i]!;
        if (await guard()) return { output: `${list.length - i - 1} later steps were not run.\n\nPage now: ${shown}` };
      }
      return { output: `Page now: ${shown}` };
    };
    return { run, read: async () => shown, ran };
  };

  it('runs every step and reports the key page', async () => {
    const f = fake(['Welcome', 'Form', 'API keys']);
    const out = await replayRecipe(recipe, f.run, f.read);
    expect(out.completed).toBe(true);
    expect(f.ran).toEqual(['Continue with Google', 'Company', 'Create API key']);
    expect(out.output).toContain('ran all 3 steps');
    expect(out.output).toContain('https://x.com/keys');
  });

  it('stops at the first failure and returns the page to take over from', async () => {
    const f = fake(['Welcome', 'Form', 'API keys'], 1);
    const out = await replayRecipe(recipe, f.run, f.read);
    expect(out).toMatchObject({ completed: false, isError: true });
    expect(f.ran).toEqual(['Continue with Google']);
    expect(out.output).toContain('take over');
    expect(out.output).toContain('Page now: Form');
  });

  it.each([
    ['Verify you are human: I\'m not a robot', 'a captcha'],
    ['Enter the code we texted to your phone, SMS', 'an SMS or authenticator code'],
    ['Add a payment method: Card number', 'a payment page'],
    ['Your app is pending review', 'a review page'],
  ])('stops and reports, never continues, at %s', async (page, name) => {
    const f = fake(['Welcome', page, 'API keys']);
    const out = await replayRecipe(recipe, f.run, f.read);
    expect(out).toMatchObject({ completed: false, blocker: name });
    expect(f.ran).toEqual(['Continue with Google', 'Company']);
    expect(out.output).toContain('not bypassed');
    expect(out.output).toContain(page);
  });
});
