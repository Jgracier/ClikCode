/** Sign-up or sign-in for a page with password boxes, on local fixture pages (no network). */
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { classifyPasswordPage, readPasswordPageContext } from './password-page.js';

let browser: Browser | undefined;
beforeAll(async () => {
  try { browser = await chromium.launch({ headless: true }); } catch { try { browser = await chromium.launch({ channel: 'chrome', headless: true }); } catch { browser = undefined; } }
}, 60_000);
afterAll(async () => { await browser?.close(); });

const kindOf = async (html: string, path: string): Promise<{ kind: string; reason: string }> => {
  const page: Page = await (await browser!.newContext()).newPage();
  await page.route('https://vendor.example/**', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(`https://vendor.example${path}`);
  const result = classifyPasswordPage(await readPasswordPageContext(page));
  await page.close();
  return result;
};

it('a Quaderno-like welcome page with one box under "Create your new password" is a new-password page', async ctx => {
  if (!browser) return ctx.skip();
  const result = await kindOf('<title>Quaderno</title><h1>Create your new password</h1><form><label>Password <input type="password" name="p"></label><button>Continue</button></form>', '/welcome/your-personal-data');
  expect(result.kind).toBe('signup');
});

it('a bare "Password" box on a /welcome address is a new-password page', async ctx => {
  if (!browser) return ctx.skip();
  expect((await kindOf('<h1>Your details</h1><label>Password <input type="password"></label>', '/welcome/your-personal-data')).kind).toBe('signup');
});

it('"set a password" with "confirm password" is a new-password page', async ctx => {
  if (!browser) return ctx.skip();
  const result = await kindOf('<h1>Account</h1><label>Set a password <input type="password"></label><label>Confirm password <input type="password"></label>', '/account');
  expect(result.kind).toBe('signup');
});

it('an invite or activate page is a new-password page', async ctx => {
  if (!browser) return ctx.skip();
  expect((await kindOf('<h1>Activate your account</h1><label>Password <input type="password"></label>', '/activate/abc123')).kind).toBe('signup');
  expect((await kindOf('<h1>You\'ve been invited</h1><label>Password <input type="password"></label>', '/x')).kind).toBe('signup');
});

it('a genuine login page (username, password, forgot link) is a sign-in', async ctx => {
  if (!browser) return ctx.skip();
  const result = await kindOf('<h1>Welcome back</h1><label>Email <input type="email" name="email"></label><label>Password <input type="password" name="password"></label><a href="/forgot">Forgot password?</a><button>Sign in</button>', '/account');
  expect(result.kind).toBe('signin');
  expect((await kindOf('<h1>Log in</h1><label>Username <input name="u" value="ada@example.com"></label><label>Password <input type="password"></label>', '/welcome')).kind).toBe('signin');
});

it('pure rules: a /login address stays a sign-in, and wording beats a forgot link', () => {
  const base = { url: 'https://x.test/login', boxes: 1, boxText: 'new password', headings: '', forgotLink: false, prefilledAccount: false };
  expect(classifyPasswordPage(base).kind).toBe('signin');
  expect(classifyPasswordPage({ ...base, url: 'https://x.test/a', forgotLink: true }).kind).toBe('signup');
  expect(classifyPasswordPage({ ...base, url: 'https://x.test/a', boxText: 'password', forgotLink: true }).kind).toBe('signin');
  expect(classifyPasswordPage({ ...base, url: 'https://x.test/set-password', boxText: 'password' }).kind).toBe('signup');
  expect(classifyPasswordPage({ ...base, url: 'https://x.test/a', boxText: 'password' }).reason).toContain('no new-password wording');
});
