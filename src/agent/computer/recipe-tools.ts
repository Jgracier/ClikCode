/** Maintenance of saved recipes: lint (what is wrong with the steps), compact (drop what a retry left behind, keeping the last
 * successful sequence), and a dry run (does every step's target exist on the live page, without submitting anything).
 * The step logic is pure; the dry run takes a small port so it is tested with a fake site. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeHost, saveRecipe, type Recipe, type RecipeStep } from './signup-recipes.js';
import { selectorsOf } from './keygrab-scope.js';

const same = (a: RecipeStep, b: RecipeStep): boolean => a.do === b.do && a.target === b.target && a.text === b.text;
const label = (s: RecipeStep): string => `${s.do}${s.target ? ` "${s.target}"` : ''}${s.text ? ` "${s.text}"` : ''}${s.key ? ` ${s.key}` : ''}`;
/** A click on a menu option is idempotent; the same click twice in a row after a selector is one selection, not a toggle. */
const afterSelector = (steps: readonly RecipeStep[], i: number): boolean => i > 0 && steps[i - 1]!.do === 'click' && selectorsOf([{ name: steps[i - 1]!.target ?? '' }], new Set()).length > 0;

/** Retry laps: where two or more steps in a row repeat an earlier run, the steps from the earlier run up to the repeat are dropped. */
export function dropLaps(steps: RecipeStep[]): RecipeStep[] {
  const out = steps.map(s => ({ ...s }));
  for (let i = 1; i + 1 < out.length; i++) {
    for (let j = 0; j < i; j++) {
      if (same(out[j]!, out[i]!) && same(out[j + 1]!, out[i + 1]!) && j + 1 < i) { out.splice(j, i - j); i = j; break; }
    }
  }
  return out;
}

/** Consecutive identical clicks: an even run toggled something and back, so it goes; an odd run keeps one click. After a selector
 * ("Select a team", then the option twice) the run is one selection, so one click is kept. */
export function dropToggles(steps: RecipeStep[]): RecipeStep[] {
  const out: RecipeStep[] = [];
  for (let i = 0; i < steps.length;) {
    const s = steps[i]!;
    let n = 1;
    while (s.do === 'click' && i + n < steps.length && same(s, steps[i + n]!)) n++;
    const keep = s.do !== 'click' || n === 1 ? n : afterSelector(steps, i) ? 1 : n % 2;
    for (let k = 0; k < keep; k++) out.push({ ...s });
    i += n;
  }
  return out;
}

const SUBMIT_STEP = /^\W*(?:create|generate|save|submit|confirm|finish|register|sign ?up|publish|apply|done|add|continue|ok)\b/i;
const danglingAt = (steps: readonly RecipeStep[]): boolean => {
  const last = steps[steps.length - 1], before = steps[steps.length - 2];
  return steps.length > 2 && last?.do === 'click' && same(last, steps[0]!) && before?.do === 'click' && SUBMIT_STEP.test(before.target ?? '');
};
/** A click at the end that goes back to where the sequence began, right after the submit ("Generate key", then "Add API key" again),
 * reopens what is done. A lone repeated press in the middle of a journey (Next, ..., Next) is never cut. */
export function dropTrailingClicks(steps: RecipeStep[]): RecipeStep[] {
  const out = steps.map(s => ({ ...s }));
  while (danglingAt(out)) out.pop();
  return out;
}

/** The recorder's earlier name for the lap rule alone. */
export const compactSteps = dropLaps;

export interface Compacted { steps: RecipeStep[]; removed: number }
/** The recipe's steps without retry laps, toggle pairs and a trailing click back to the start. Idempotent. */
export function compactRecipeSteps(steps: RecipeStep[]): Compacted {
  const out = dropTrailingClicks(dropToggles(dropLaps(steps)));
  return { steps: out, removed: steps.length - out.length };
}

export interface LintFinding { code: 'repeated-lap' | 'duplicate-click' | 'trailing-click' | 'no-capture'; message: string; steps?: number[] }
export function lintRecipe(recipe: Pick<Recipe, 'steps' | 'keyPage' | 'captureHint'>): LintFinding[] {
  const steps = recipe.steps;
  const found: LintFinding[] = [];
  const laps = steps.length - dropLaps(steps).length;
  if (laps > 0) found.push({ code: 'repeated-lap', message: `${laps} step${laps === 1 ? '' : 's'} belong to an earlier lap that a retry repeated` });
  for (let i = 1; i < steps.length; i++) if (steps[i]!.do === 'click' && same(steps[i]!, steps[i - 1]!)) found.push({ code: 'duplicate-click', message: `step ${i} and ${i + 1} click ${label(steps[i]!).replace(/^click /, '')} twice in a row (a toggle)`, steps: [i, i + 1] });
  const last = steps[steps.length - 1];
  if (last && danglingAt(steps)) found.push({ code: 'trailing-click', message: `the last step (${label(last)}) goes back to where the recipe began and reopens what was done`, steps: [steps.length] });
  if (!recipe.keyPage && !recipe.captureHint) found.push({ code: 'no-capture', message: 'no capture step: the recipe has neither a key page nor a capture hint, so replay cannot tell where the key shows' });
  return found;
}

// ── Saved recipes: compact with a backup ────────────────────────────────────

const recipeFile = (stateDir: string, host: string): string => path.join(stateDir, 'computer', 'recipes', `${normalizeHost(host)}.json`);

export interface CompactReport { host: string; route: string; before: RecipeStep[]; after: RecipeStep[]; removed: number; backup?: string; findings: LintFinding[] }

/** Compacts the saved recipe of a host (the named route, else every route), keeping the file as it was in `<host>.json.bak`. A recipe with
 * nothing to compact is left untouched and gets no backup. The recipe keeps its verification date. */
export async function compactSavedRecipes(stateDir: string, host: string, route?: string): Promise<CompactReport[]> {
  const file = recipeFile(stateDir, host);
  let raw: string;
  try { raw = await fs.readFile(file, 'utf8'); } catch { return []; }
  const all = (() => { try { const p = JSON.parse(raw) as unknown; return Array.isArray(p) ? p as Recipe[] : []; } catch { return []; } })();
  const reports: CompactReport[] = [];
  let backup: string | undefined;
  for (const recipe of all) {
    if (route && recipe.loginRoute !== route) continue;
    const { steps, removed } = compactRecipeSteps(recipe.steps);
    const findings = lintRecipe(recipe);
    if (removed > 0) {
      if (!backup) { backup = `${file}.bak`; await fs.writeFile(backup, raw, { mode: 0o600 }); }
      await saveRecipe(stateDir, { host: recipe.host, loginRoute: recipe.loginRoute, steps, ...(recipe.keyPage ? { keyPage: recipe.keyPage } : {}), ...(recipe.captureHint ? { captureHint: recipe.captureHint } : {}) }, new Date(recipe.verifiedAt), { allowEmpty: true });
    }
    reports.push({ host: recipe.host, route: recipe.loginRoute, before: recipe.steps, after: steps, removed, ...(removed > 0 && backup ? { backup } : {}), findings });
  }
  return reports;
}

// ── Dry run ─────────────────────────────────────────────────────────────────

export interface DryView { text: string; controls: Array<{ name: string }>; fields: string[] }
export interface DryRunPort {
  open(url: string): Promise<string | undefined>;
  look(): Promise<DryView>;
  click(name: string): Promise<string | undefined>;
  /** Sign in with the saved login when the page asks for it. */
  login?(): Promise<boolean>;
}
export interface DryStep { index: number; step: string; status: 'found' | 'missing' | 'not-checked'; note?: string }
export interface DryRunReport { host: string; ok: boolean; steps: DryStep[]; opened: string }

const norm = (t: string): string => t.replace(/\s+/g, ' ').trim().toLowerCase();
const SUBMITS = /^\W*(?:create|generate|save|submit|confirm|finish|register|sign ?up|publish|apply|done|add|continue|next|ok)\b/i;
const NEVER = /\b(?:delete|revoke|remove|rotate|regenerate|cancel|deactivate|destroy)\b/i;

/** Is the step's target on the page: a pressable or text box with that name (exact, else containing it). */
export function targetOnPage(step: RecipeStep, view: DryView): boolean {
  if (step.do === 'wait') return !step.text || (norm(view.text).includes(norm(step.text)) === !step.gone);
  if (step.do === 'press' || step.do === 'scroll') return true;
  const t = norm(step.target ?? '');
  if (!t) return false;
  const names = step.do === 'fill' ? [...view.fields, ...view.controls.map(c => c.name)] : view.controls.map(c => c.name).concat(step.do === 'upload' ? view.fields : []);
  return names.some(n => norm(n) === t) || names.some(n => norm(n).includes(t));
}

/** Replays the selectors against the live page and submits nothing: it checks that each step's target exists, opening menus and
 * dialogs (plain clicks) so later steps can be seen, but never presses a submit-like control (Generate, Create, Save, Add, ...) unless
 * no form is showing yet and the next step's target is not on the page, so that press is what opens it ("Add API key" opening its form). Fills type nothing. */
export async function dryRunRecipe(recipe: Pick<Recipe, 'host' | 'steps' | 'keyPage'>, port: DryRunPort): Promise<DryRunReport> {
  const opened = recipe.keyPage ?? `https://${recipe.host}/`;
  const err = await port.open(opened);
  const report: DryRunReport = { host: recipe.host, ok: true, steps: [], opened };
  if (err) return { ...report, ok: false, steps: recipe.steps.map((s, index) => ({ index: index + 1, step: label(s), status: 'not-checked' as const, ...(index === 0 ? { note: `could not open ${opened}: ${err}` } : {}) })) };
  let view = await port.look();
  if (recipe.steps[0] && !targetOnPage(recipe.steps[0], view) && port.login) {
    if (await port.login().catch(() => false)) { await port.open(opened); view = await port.look(); }
  }
  let skipped = false; // a submit was not pressed: pages after it never appear, so an absent target is unchecked, not missing
  for (const [i, step] of recipe.steps.entries()) {
    const text = label(step);
    if (!targetOnPage(step, view)) {
      report.steps.push(skipped ? { index: i + 1, step: text, status: 'not-checked', note: 'would need the submit that was not pressed' } : { index: i + 1, step: text, status: 'missing', note: 'no such control on the page at this point' });
      if (!skipped) report.ok = false;
      continue;
    }
    const row: DryStep = { index: i + 1, step: text, status: 'found' };
    report.steps.push(row);
    if (step.do !== 'click') continue;
    const next = recipe.steps[i + 1];
    const name = step.target ?? '';
    const revealsNext = !!next && !targetOnPage(next, view);
    // A submit-like press is an opener only when no form is showing yet and the next step needs what it opens; with a form on screen it submits.
    const opener = revealsNext && view.fields.length === 0;
    if (NEVER.test(name) || (SUBMITS.test(name) && !opener)) { if (revealsNext) skipped = true; row.note = 'found, not pressed (a dry run submits nothing)'; continue; }
    const failed = await port.click(name);
    if (failed) { row.status = 'missing'; row.note = failed.slice(0, 120); report.ok = false; continue; }
    view = await port.look();
  }
  return report;
}
