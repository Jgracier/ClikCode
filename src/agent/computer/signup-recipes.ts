/** A signup / key-capture recipe: the steps that worked at a host, saved so the next run replays them
 * deterministically instead of rediscovering the screens. Steps name controls by their visible text (a
 * [ref=eN] is only good for one page view). A recipe never holds a secret: typed text that looks like a
 * key or password is refused, and a fill with no text is filled from the user's profile at replay time.
 * A replay stops at, and reports, a captcha, an SMS/authenticator code, a payment page or a review page:
 * those are for the person, and nothing here tries to get past them. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { keyShaped } from './secret-finder.js';

export const LOGIN_ROUTES = ['google', 'github', 'email'] as const;
export type LoginRoute = typeof LOGIN_ROUTES[number];
export type RecipeStep = { do: 'click' | 'fill' | 'choose' | 'press' | 'scroll' | 'wait' | 'upload'; target?: string; at?: 'start' | 'end'; text?: string; key?: string; direction?: 'up' | 'down'; accept_dialog?: boolean; gone?: boolean; seconds?: number };
export interface Recipe { host: string; loginRoute: LoginRoute; steps: RecipeStep[]; keyPage?: string; captureHint?: string; verifiedAt: string }

const MAX_STEPS = 40;
const REF = /^(?:f\d+)?e\d+$/;
const DOS = new Set(['click', 'fill', 'choose', 'press', 'scroll', 'wait', 'upload']);
const SECRET_FIELD = /pass(?:word|code|phrase)?|secret|token|api[ _-]?key|private[ _-]?key|\bpin\b|otp|cvv|cvc|card number|one[- ]time|2fa|verification code/i;

export function normalizeHost(host: string): string {
  const safe = host.trim().toLowerCase().replace(/^www\./, '').replace(/[^a-z0-9.-]/g, '_').slice(0, 100);
  if (!safe || safe.startsWith('.')) throw new Error('A recipe needs a site name such as app.asana.com.');
  return safe;
}

const file = (stateDir: string, host: string): string => path.join(stateDir, 'computer', 'recipes', `${normalizeHost(host)}.json`);

/** Why a step may not be saved, or undefined when it is fine. */
export function stepProblem(step: unknown, index: number): string | undefined {
  const at = `Step ${index + 1}`;
  if (!step || typeof step !== 'object') return `${at} is not a step.`;
  const s = step as RecipeStep;
  if (!DOS.has(s.do)) return `${at}: unknown action "${String(s.do)}".`;
  if (s.target !== undefined && (typeof s.target !== 'string' || s.target.length > 200)) return `${at}: target must be short text.`;
  if (s.target && REF.test(s.target.trim())) return `${at}: target "${s.target}" is a page reference that changes every visit. Use the visible text or label of the control.`;
  if ((s.do === 'click' || s.do === 'fill' || s.do === 'choose' || s.do === 'upload') && !s.target?.trim()) return `${at}: ${s.do} needs a target (the visible text or label).`;
  if (s.text === undefined) return undefined;
  if (typeof s.text !== 'string' || s.text.length > 200) return `${at}: text must be at most 200 characters.`;
  if (s.do === 'fill') {
    if (SECRET_FIELD.test(s.target ?? '')) return `${at}: not saved, "${s.target}" looks like a password or code field. Leave the text out: a fill with no text uses the profile autofill.`;
    const words = s.text.split(/\s+/).map(word => word.replace(/^[("'`]+|[)"'`,.;]+$/g, ''));
    if (words.some(keyShaped)) return `${at}: not saved, the text looks like a key or token. Recipes never hold secrets.`;
    const t = s.text.trim();
    if (t.length >= 8 && !/\s/.test(t) && !t.includes('@') && /[a-z]/.test(t) && /[A-Z]/.test(t) && /\d/.test(t) && /[^A-Za-z0-9]/.test(t)) return `${at}: not saved, the text looks like a password. Leave the text out to use the profile autofill.`;
  }
  return undefined;
}

export function recipeProblem(input: { steps?: unknown; loginRoute?: unknown; keyPage?: unknown; captureHint?: unknown }, options: { allowEmpty?: boolean } = {}): string | undefined {
  if (!LOGIN_ROUTES.includes(input.loginRoute as LoginRoute)) return `login_route must be one of ${LOGIN_ROUTES.join(', ')}.`;
  if (!Array.isArray(input.steps) || (!input.steps.length && !options.allowEmpty)) return 'A recipe needs a list of steps.';
  if (input.steps.length > MAX_STEPS) return `A recipe holds at most ${MAX_STEPS} steps.`;
  for (const [i, step] of input.steps.entries()) { const why = stepProblem(step, i); if (why) return why; }
  if (input.keyPage !== undefined) {
    try { const u = new URL(String(input.keyPage)); if (!/^https?:$/.test(u.protocol) || u.username || u.password || u.search.length > 200 || keyShaped(u.pathname.split('/').pop() ?? '')) return 'key_page must be a plain http(s) address without credentials or tokens.'; } catch { return 'key_page must be a web address.'; }
  }
  if (input.captureHint !== undefined && (typeof input.captureHint !== 'string' || input.captureHint.length > 500 || input.captureHint.split(/\s+/).some(w => keyShaped(w.replace(/^[("'`]+|[)"'`,.;]+$/g, ''))))) return 'capture_hint must be short text without a key or token.';
  return undefined;
}

async function readAll(stateDir: string, host: string): Promise<Recipe[]> {
  try { const parsed = JSON.parse(await fs.readFile(file(stateDir, host), 'utf8')) as unknown; return Array.isArray(parsed) ? parsed as Recipe[] : []; } catch { return []; }
}

/** The recipe for a host (the named route, else the most recently verified). */
export async function getRecipe(stateDir: string, host: string, route?: string): Promise<Recipe | undefined> {
  const all = await readAll(stateDir, host);
  const pool = route ? all.filter(r => r.loginRoute === route) : all;
  return [...pool].sort((a, b) => b.verifiedAt.localeCompare(a.verifiedAt))[0];
}

export async function saveRecipe(stateDir: string, input: { host: string; loginRoute: string; steps: unknown; keyPage?: string; captureHint?: string }, now = new Date(), options: { allowEmpty?: boolean } = {}): Promise<Recipe> {
  const host = normalizeHost(input.host);
  const why = recipeProblem(input, options);
  if (why) throw new Error(`Recipe not saved: ${why}`);
  const recipe: Recipe = { host, loginRoute: input.loginRoute as LoginRoute, steps: (input.steps as RecipeStep[]).map(s => ({ ...s })), ...(input.keyPage ? { keyPage: input.keyPage } : {}), ...(input.captureHint ? { captureHint: input.captureHint } : {}), verifiedAt: now.toISOString() };
  const rest = (await readAll(stateDir, host)).filter(r => r.loginRoute !== recipe.loginRoute);
  await fs.mkdir(path.dirname(file(stateDir, host)), { recursive: true, mode: 0o700 });
  await fs.writeFile(file(stateDir, host), `${JSON.stringify([...rest, recipe], null, 2)}\n`, { mode: 0o600 });
  return recipe;
}

/** A profile detail a step names without holding it: replaced with the real value only at replay. */
export const PROFILE_PLACEHOLDERS = ['sso_email'] as const;
export const fillPlaceholders = (text: string | undefined, values: Readonly<Record<string, string | undefined>>): string | undefined =>
  text?.replace(/\{\{(sso_email)\}\}/g, (all, name: string) => values[name] ?? all);

export async function listRecipes(stateDir: string): Promise<Recipe[]> {
  let names: string[] = [];
  try { names = await fs.readdir(path.join(stateDir, 'computer', 'recipes')); } catch { return []; }
  const out: Recipe[] = [];
  for (const name of names.filter(n => n.endsWith('.json'))) out.push(...await readAll(stateDir, name.slice(0, -5)));
  return out.sort((a, b) => a.host.localeCompare(b.host));
}

export function describeRecipe(recipe: Recipe): string {
  const steps = recipe.steps.map((s, i) => `${i + 1}. ${s.do}${s.target ? ` "${s.target}"` : ''}${s.do === 'fill' ? (s.text === undefined ? ' (from profile)' : ` "${s.text}"`) : s.text ? ` "${s.text}"` : ''}${s.key ? ` ${s.key}` : ''}`).join('\n');
  return `${recipe.host} via ${recipe.loginRoute}, verified ${recipe.verifiedAt.slice(0, 10)}${recipe.keyPage ? `\nKey page: ${recipe.keyPage}` : ''}${recipe.captureHint ? `\nCapture: ${recipe.captureHint}` : ''}\n${steps}`;
}

/** Pages a replay must hand back to the person. Matches words a page shows, not hidden markup. */
const BLOCKERS: ReadonlyArray<readonly [string, RegExp]> = [
  ['a captcha', /captcha|verify (?:that )?you(?:'| a)?re (?:a )?human|i'?m not a robot|are you a robot|cloudflare turnstile|checking (?:if|that) you are human|press (?:and|&) hold/i],
  ['an SMS or authenticator code', /(?:sent|texted) (?:a|the|your)? ?(?:\w+ )?(?:code )?(?:to|via) (?:your )?(?:phone|mobile|number|\+?\d)|text message|\bsms\b|authenticator app|two-factor|2-step verification|two-step verification|\bmfa\b|security key|enter the \d-digit code from your (?:phone|device)/i],
  ['a payment page', /card number|credit card|debit card|add (?:a )?payment method|payment (?:method|details|information)|billing (?:details|information|address)|enter your card|\bcvv\b|\bcvc\b|expiry date/i],
  ['a review page', /(?:under|pending|awaiting) (?:manual )?review|being reviewed|submit for review|review (?:can|may|will) take|we(?:'| a)re reviewing|application (?:is )?(?:pending|under)|waitlist/i],
];

export function detectBlocker(pageText: string): string | undefined {
  for (const [name, pattern] of BLOCKERS) if (pattern.test(pageText)) return name;
  return undefined;
}

export interface Replay { output: string; isError?: boolean; completed: boolean; blocker?: string }

/** Replays a recipe through `run` (the existing steps runner, which calls `guard` after each step and stops
 * when it returns text). Stops at the first failure or at a blocker page and says what to do from there. */
export async function replayRecipe(recipe: Recipe, run: (steps: RecipeStep[], guard: () => Promise<string | undefined>) => Promise<{ output: string; isError?: boolean }>, readPage: () => Promise<string>): Promise<Replay> {
  let blocker: string | undefined;
  const result = await run(recipe.steps.map(s => ({ ...s })), async () => {
    blocker = detectBlocker(await readPage().catch(() => ''));
    return blocker;
  });
  const head = `Recipe for ${recipe.host} (${recipe.loginRoute})`;
  if (blocker) return { output: `${head} stopped at ${blocker}. That step is for the person: not bypassed. Hand it over (handoff for a captcha or code, ask_user, or record it with queue), then carry on from the page below.\n\n${result.output}`, completed: false, blocker };
  if (result.isError) return { output: `${head} stopped at the first step that failed; the page below is where it is now, so take over from here. Save a corrected recipe when you finish.\n\n${result.output}`, isError: true, completed: false };
  if (/\d+ later steps? (?:was|were) not run/.test(result.output)) return { output: `${head} stopped early (a step is waiting on the page); take over from the page below.\n\n${result.output}`, completed: false };
  return { output: `${head} ran all ${recipe.steps.length} steps.${recipe.keyPage ? ` Key page: ${recipe.keyPage}.` : ''}${recipe.captureHint ? ` Capture: ${recipe.captureHint}` : ''}\n\n${result.output}`, completed: true };
}
