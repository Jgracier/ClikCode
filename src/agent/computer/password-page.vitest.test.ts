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

const CLIENGO = `<title>Cliengo</title><h1>Prueba gratis</h1><form>
  <label>Nombre completo <input type="text" name="fullname" value="Ada Lovelace"></label>
  <label>Correo electrónico <input type="email" name="email" value="ada@example.com"></label>
  <label>Teléfono <input type="tel" name="phone"></label>
  <label>Contraseña <input type="password" name="password" placeholder=""></label><small>Entre 8 y 20 caracteres</small>
  <label><input type="checkbox" name="terms"> Acepto los términos y condiciones y la política de privacidad</label>
  <button type="submit">Crear cuenta</button></form>`;

it('a Spanish sign-up form with a filled email, name, phone, length hint, terms and "Crear cuenta" is a sign-up', async ctx => {
  if (!browser) return ctx.skip();
  const result = await kindOf(CLIENGO, '/registro');
  expect(result.kind).toBe('signup');
});

it('a genuine Spanish login page with a filled email still parks as a sign-in', async ctx => {
  if (!browser) return ctx.skip();
  const login = '<h1>Bienvenido</h1><form><label>Correo electrónico <input type="email" name="email" value="ada@example.com"></label><label>Contraseña <input type="password" name="password"></label><a href="/olvide">¿Olvidaste tu contraseña?</a><button type="submit">Iniciar sesión</button></form>';
  expect((await kindOf(login, '/acceso')).kind).toBe('signin');
  const noLink = '<form><label>Correo <input type="email" value="ada@example.com"></label><label>Contraseña <input type="password"></label><button type="submit">Entrar</button></form>';
  expect((await kindOf(noLink, '/acceso')).kind).toBe('signin');
});

it('pure rules: multilingual sign-up and sign-in cues beat or yield to a filled email', () => {
  const base = { url: 'https://x.test/a', boxes: 1, boxText: 'password', headings: '', forgotLink: false, prefilledAccount: true };
  const form = { fieldText: '', inputs: 2, dropdown: false, termsBox: false, submitText: '', hintText: '' };
  expect(classifyPasswordPage({ ...base, form }).kind).toBe('signin');
  for (const submitText of ['Crear cuenta', 'Registrarse', 'Criar conta', 'Cadastrar', "S'inscrire", 'Créer un compte', 'Konto erstellen', 'Registrieren', 'Registrati', 'Crea account', 'Sign up', 'Create account']) {
    expect(classifyPasswordPage({ ...base, form: { ...form, submitText } }).kind, submitText).toBe('signup');
  }
  for (const submitText of ['Iniciar sesión', 'Entrar', 'Se connecter', 'Anmelden', 'Accedi', 'Log in', 'Sign in']) {
    expect(classifyPasswordPage({ ...base, form: { ...form, submitText, termsBox: true } }).kind, submitText).toBe('signin');
  }
  for (const hintText of ['Entre 8 y 20 caracteres', 'Mínimo 8 caracteres', 'At least 8 characters', 'Mindestens 8 Zeichen', 'Au moins 8 caractères', 'Almeno 8 caratteri', 'Pelo menos 8 caracteres', 'one number', 'one uppercase letter']) {
    expect(classifyPasswordPage({ ...base, form: { ...form, hintText } }).kind, hintText).toBe('signup');
  }
  expect(classifyPasswordPage({ ...base, form: { ...form, fieldText: 'Teléfono | tel' } }).kind).toBe('signup');
  expect(classifyPasswordPage({ ...base, form: { ...form, fieldText: 'Nombre | name' } }).kind).toBe('signup');
  expect(classifyPasswordPage({ ...base, form: { ...form, dropdown: true } }).kind).toBe('signup');
  expect(classifyPasswordPage({ ...base, form: { ...form, inputs: 4 } }).kind).toBe('signup');
  expect(classifyPasswordPage({ ...base, form: { ...form, fieldText: 'username | user' } }).kind).toBe('signin');
  expect(classifyPasswordPage({ ...base, forgotLink: true, form: { ...form, termsBox: true } }).kind).toBe('signin');
});
