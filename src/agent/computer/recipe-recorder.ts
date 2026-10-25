/** Records signup recipes without the agent doing anything. Every successful `computer_web` interaction since a tab opened a
 * site is kept in a short in-memory journal (by control text, never a typed value). When the sequence ends in a verified
 * capture_secret or login, the journal is saved as that host's recipe. A step that cannot be saved safely (a control named
 * after an id or a key, a page reference with no readable name) spoils the journal, so a partial recipe is never saved. */
import { sharedState } from './shared-state.js';
import { keyShaped } from './secret-finder.js';
import { getRecipe, normalizeHost, recipeProblem, saveRecipe, type LoginRoute, type Recipe, type RecipeStep } from './signup-recipes.js';

interface Journal { host: string; steps: RecipeStep[]; visited: Set<string>; spoiled?: string; signedIn: boolean }
const journals = sharedState('recipe-journals', () => new Map<string, Journal>());
const REF = /^(?:f\d+)?e\d+$/;
const EMAIL = /[^\s@"'<>()]+@[^\s@"'<>()]+\.[A-Za-z]{2,}/g;

/** The saved form of a control name: an email becomes the profile placeholder; anything shaped like an id or a key is refused (undefined). */
export function safeText(text: string, max = 80): string | undefined {
  const one = text.replace(/\s+/g, ' ').trim().replace(EMAIL, '{{sso_email}}');
  if (!one || one.length > max) return undefined;
  if (/\d{6,}|[0-9a-f]{8}-[0-9a-f]{4}-/i.test(one)) return undefined;
  if (one.split(/\s+/).some(word => keyShaped(word.replace(/^[("'`]+|[)"'`,.;]+$/g, '')))) return undefined;
  return one;
}

/** One step in its saved form, 'skip' for one that is not worth keeping, 'spoiled' for one that cannot be kept safely.
 * `label` is the control's readable name when the step addressed it by a page reference. */
export function recordableStep(step: RecipeStep, label?: string): RecipeStep | 'skip' | 'spoiled' {
  if (step.do === 'scroll') return 'skip';
  if (step.do === 'wait') {
    if (!step.text) return 'skip';
    const text = safeText(step.text, 60);
    return text ? { do: 'wait', text, ...(step.gone ? { gone: true } : {}), ...(step.seconds ? { seconds: step.seconds } : {}) } : 'skip';
  }
  if (step.do === 'press') return step.key ? { do: 'press', key: step.key } : 'skip';
  const raw = step.target?.trim();
  const name = raw && !REF.test(raw) ? raw : label;
  const target = name ? safeText(name, 120) : undefined;
  if (!target) return 'spoiled';
  const out: RecipeStep = { do: step.do, target };
  if (step.at) out.at = step.at;
  if (step.accept_dialog) out.accept_dialog = true;
  if (step.do === 'fill') return out; // never the typed text: replay fills from the profile or the saved login
  if (step.do === 'upload') return step.text && /_file$/.test(step.text) ? { ...out, text: step.text } : 'spoiled';
  if (step.do === 'choose') { const text = step.text ? safeText(step.text, 60) : undefined; return text ? { ...out, text } : 'spoiled'; }
  return out;
}

const hostOf = (url: string): string => { try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } };

/** A tab opened a site: a new sequence starts. */
export function beginJournal(key: string, url: string): void {
  const host = hostOf(url);
  if (!host) { journals.delete(key); return; }
  journals.set(key, { host, steps: [], visited: new Set([host]), signedIn: false });
}

/** A step succeeded on the page at `url`. Nothing is kept for a tab that never opened a site. */
export function noteStep(key: string, url: string, step: RecipeStep, label?: string): void {
  const journal = journals.get(key);
  if (!journal || journal.spoiled) return;
  const host = hostOf(url);
  if (host) journal.visited.add(host);
  const saved = recordableStep(step, label);
  if (saved === 'skip') return;
  if (saved === 'spoiled') { journal.spoiled = `a ${step.do} step could not be named safely`; return; }
  if (recipeProblem({ steps: [saved], loginRoute: 'email' }) ) { journal.spoiled = 'a step looked like it held a secret'; return; }
  if (journal.steps.length < 40) journal.steps.push(saved); else journal.spoiled = 'too many steps';
}

/** The journal as plain data, so a parked keygrab can carry it to the process that resumes it; and the way back. */
export interface JournalData { host: string; steps: RecipeStep[]; visited: string[]; spoiled?: string; signedIn: boolean }
export function exportJournal(key: string): JournalData | undefined {
  const j = journals.get(key);
  return j ? { host: j.host, steps: j.steps.map(s => ({ ...s })), visited: [...j.visited], ...(j.spoiled ? { spoiled: j.spoiled } : {}), signedIn: j.signedIn } : undefined;
}
export function importJournal(key: string, data: JournalData): void {
  journals.set(key, { host: data.host, steps: data.steps.map(s => ({ ...s })), visited: new Set(data.visited), ...(data.spoiled ? { spoiled: data.spoiled } : {}), signedIn: data.signedIn });
}

export const journalOf = (key: string): Journal | undefined => journals.get(key);

const routeOf = (journal: Journal): LoginRoute => journal.visited.has('accounts.google.com') ? 'google' : journal.visited.has('github.com') ? 'github' : 'email';

export type VerifiedEvent = { kind: 'login' } | { kind: 'capture'; url: string; hint?: string };

/** The sequence ended in a verified outcome: save it as the host's recipe, newest per host and route. Returns the saved recipe,
 * or undefined when nothing was saved (no journal, a spoiled one, or a plain login that would replace a richer capture recipe). */
export async function recordVerified(stateDir: string, key: string, event: VerifiedEvent, now = new Date()): Promise<Recipe | undefined> {
  const journal = journals.get(key);
  if (!journal || journal.spoiled) return undefined;
  const loginRoute = routeOf(journal);
  if (event.kind === 'login') {
    journal.signedIn = true;
    if (!journal.steps.length) return undefined;
  }
  let keyPage: string | undefined;
  if (event.kind === 'capture') {
    try { const u = new URL(event.url); keyPage = `${u.origin}${u.pathname}`; } catch { keyPage = undefined; }
  }
  const hint = event.kind === 'capture' ? `${journal.signedIn ? 'Sign in first with the login action (saved login). ' : ''}${event.hint ?? 'capture_secret reads the key the page shows.'}` : undefined;
  const input = { host: normalizeHost(journal.host), loginRoute, steps: journal.steps.map(s => ({ ...s })), ...(keyPage ? { keyPage } : {}), ...(hint ? { captureHint: hint } : {}) };
  if (recipeProblem(input, { allowEmpty: true })) {
    // A key page or hint that fails the checks is left out; the steps alone are still worth saving.
    delete (input as { keyPage?: string }).keyPage; delete (input as { captureHint?: string }).captureHint;
    if (recipeProblem(input, { allowEmpty: true })) return undefined;
  }
  if (event.kind === 'login') {
    const existing = await getRecipe(stateDir, journal.host, loginRoute);
    if (existing && (existing.keyPage || existing.captureHint)) return undefined;
  }
  const saved = await saveRecipe(stateDir, input, now, { allowEmpty: true });
  if (event.kind === 'capture') { journal.steps = []; }
  return saved;
}
