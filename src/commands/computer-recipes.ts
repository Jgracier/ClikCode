import { quiet } from '../runtime/lifecycle-log.js';
import { stateDirectory } from '../session/store/paths.js';
import { emitResult } from '../cli/structured-output.js';
import { isJsonDefaultMode } from '../cli/output-mode.js';
import { describeRecipe, getRecipe, listRecipes, normalizeHost, type Recipe } from '../agent/computer/signup-recipes.js';
import { compactSavedRecipes, dryRunRecipe, lintRecipe, type DryRunReport } from '../agent/computer/recipe-tools.js';

const out = (text: string): void => void process.stdout.write(`${text}\n`);
const numbered = (steps: Recipe['steps']): string => steps.map((s, i) => `${i + 1}. ${s.do}${s.target ? ` "${s.target}"` : ''}${s.text ? ` "${s.text}"` : ''}${s.key ? ` ${s.key}` : ''}`).join('\n') || '(no steps)';

async function need(host: string | undefined): Promise<Recipe> {
  if (!host) throw new Error('Name the site: clikcode computer recipe show <host>');
  const recipe = await getRecipe(stateDirectory(), normalizeHost(host));
  if (!recipe) throw new Error(`No recipe is saved for ${host}. List them with: clikcode computer recipe list`);
  return recipe;
}

export async function recipeList(): Promise<void> {
  const all = await listRecipes(stateDirectory());
  if (isJsonDefaultMode()) return emitResult({ recipes: all.map(r => ({ host: r.host, loginRoute: r.loginRoute, steps: r.steps.length, verifiedAt: r.verifiedAt, issues: lintRecipe(r).length })) });
  out(all.length ? all.map(r => `${r.host} via ${r.loginRoute}: ${r.steps.length} steps, verified ${r.verifiedAt.slice(0, 10)}${lintRecipe(r).length ? ` (${lintRecipe(r).length} lint finding${lintRecipe(r).length === 1 ? '' : 's'})` : ''}`).join('\n') : 'No recipes saved yet.');
}

export async function recipeShow(host: string | undefined): Promise<void> {
  const recipe = await need(host);
  if (isJsonDefaultMode()) return emitResult({ recipe });
  out(describeRecipe(recipe));
}

export async function recipeLintCommand(host: string | undefined): Promise<void> {
  const recipe = await need(host);
  const findings = lintRecipe(recipe);
  if (isJsonDefaultMode()) return emitResult({ host: recipe.host, findings });
  out(findings.length ? `${recipe.host}: ${findings.length} finding${findings.length === 1 ? '' : 's'}\n${findings.map(f => `- ${f.code}: ${f.message}`).join('\n')}\nFix with: clikcode computer recipe compact ${recipe.host}` : `${recipe.host}: clean.`);
}

export async function recipeCompactCommand(host: string | undefined): Promise<void> {
  const recipe = await need(host);
  const reports = await compactSavedRecipes(stateDirectory(), recipe.host);
  if (isJsonDefaultMode()) return emitResult({ host: recipe.host, reports });
  for (const r of reports) {
    out(r.removed ? `${r.host} via ${r.route}: ${r.before.length} steps -> ${r.after.length} (removed ${r.removed}); the earlier recipe is kept in ${r.backup}\nBefore:\n${numbered(r.before)}\nAfter:\n${numbered(r.after)}` : `${r.host} via ${r.route}: nothing to compact (${r.before.length} steps).`);
    const left = lintRecipe({ steps: r.after, ...((await getRecipe(stateDirectory(), r.host, r.route)) ?? {}) });
    if (left.length) out(`Still to fix:\n${left.map(f => `- ${f.code}: ${f.message}`).join('\n')}`);
  }
}

const printDry = (r: DryRunReport): string => `${r.host}: ${r.ok ? 'every checked step has its target on the page' : 'a step has no target on the page'} (opened ${r.opened}; nothing was submitted)\n${r.steps.map(s => `${s.index}. [${s.status}] ${s.step}${s.note ? ` - ${s.note}` : ''}`).join('\n')}${r.landed ? `\nThe page now shows: ${r.landed.text || '(nothing)'}\nControls: ${r.landed.controls.join(' | ') || '(none)'}` : ''}`;

/** Replays the recipe's selectors in the hidden browser against the live page, signing in with the saved login when the page asks, and submits nothing. */
export async function recipeDryRunCommand(host: string | undefined): Promise<void> {
  const recipe = await need(host);
  const stateDir = stateDirectory();
  const [{ liveKeygrabPort }, browser] = await Promise.all([import('../agent/computer/keygrab-live.js'), import('../agent/computer/browser.js')]);
  const port = await liveKeygrabPort({ stateDir, id: 'recipe-dry-run' });
  try {
    const report = await dryRunRecipe(recipe, {
      open: url => port.open(url),
      look: async () => { const v = await port.look(); return { text: v.text, controls: v.controls, fields: v.fields }; },
      click: name => port.click(name),
      login: async () => (await port.login()).ok,
    });
    if (isJsonDefaultMode()) emitResult({ dryRun: report }); else out(printDry(report));
    if (!report.ok) process.exitCode = 1;
  } finally {
    await browser.closeComputerPage(stateDir, 'connectors').catch(quiet('commands/computer-recipes'));
    await browser.releaseComputerBrowser(stateDir).catch(quiet('commands/computer-recipes'));
  }
}
