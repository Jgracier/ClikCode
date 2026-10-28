import { stateDirectory } from '../session/store/paths.js';
import { emitResult } from '../cli/structured-output.js';
import { isJsonDefaultMode } from '../cli/output-mode.js';

export interface ConnectorsRunFlags { limit?: string; ids?: string; parallel?: string; dryRun?: boolean; maxSteps?: string; maxMinutes?: string; published?: boolean }

const number = (value: string | undefined, name: string, min: number, max: number): number | undefined => {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`--${name} is a whole number from ${min} to ${max}.`);
  return n;
};

/** `clikcode connectors run`: complete connector onboarding tasks without a model; hand on what it does not know. */
export async function connectorsRun(flags: ConnectorsRunFlags): Promise<void> {
  const [{ dryRun, runConnectors }, { liveClient, liveDriver }] = await Promise.all([import('../agent/computer/connector-runner.js'), import('../agent/computer/connector-runner-live.js')]);
  const ids = flags.ids?.split(',').map(s => s.trim()).filter(Boolean);
  if (ids?.some(id => !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id))) throw new Error('--ids are connector ids: lower-case letters, digits and dashes, separated by commas.');
  if (flags.published && !ids?.length) throw new Error('--published needs --ids: it connects the named connectors only.');
  const limit = number(flags.limit, 'limit', 1, 25), parallel = number(flags.parallel, 'parallel', 1, 4), maxSteps = number(flags.maxSteps, 'max-steps', 1, 50), maxMinutes = number(flags.maxMinutes, 'max-minutes', 1, 60);
  const options = { ...(ids?.length ? { ids } : {}), ...(flags.published ? { published: true } : {}), ...(limit ? { limit } : {}), ...(parallel ? { parallel } : {}), ...(maxSteps ? { maxSteps } : {}), ...(maxMinutes ? { maxMs: maxMinutes * 60_000 } : {}) };
  const client = liveClient();
  const driver = liveDriver({ stateDir: stateDirectory() });
  if (flags.dryRun) {
    const plan = await dryRun(client, driver, options);
    if (isJsonDefaultMode()) return emitResult({ connectors: { dryRun: true, plan } });
    process.stdout.write(plan.length ? plan.map(p => `${p.id}\n  why: ${p.reason}\n  plan: ${p.plan}\n`).join('\n') : 'No vendor is waiting for an agent.\n');
    return;
  }
  const log = isJsonDefaultMode() ? undefined : (line: string): void => void process.stdout.write(`${line}\n`);
  const { outcomes, skipped } = await runConnectors(client, driver, { ...options, ...(log ? { log } : {}) });
  if (isJsonDefaultMode()) return emitResult({ connectors: { outcomes, skipped } });
  const by = new Map<string, number>();
  for (const o of outcomes) by.set(o.status, (by.get(o.status) ?? 0) + 1);
  process.stdout.write(`\n${outcomes.length} vendors: ${[...by].map(([s, n]) => `${n} ${s}`).join(', ') || 'none'}${skipped.length ? `; ${skipped.length} skipped` : ''}.\n`);
  for (const o of outcomes.filter(o => o.handoff)) process.stdout.write(`handoff ${o.id}: ${o.handoff!.file ?? '(no file)'}\n`);
}

export interface ConnectorsResumeFlags { click?: string; goto?: string; only?: boolean; maxMinutes?: string; maxSteps?: string }

/** `clikcode connectors resume <id>`: reattach to the hidden tab a keygrab run left parked, optionally press one thing, and carry on with keygrab. */
export async function connectorsResume(id: string, flags: ConnectorsResumeFlags): Promise<void> {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error('The connector id is lower-case letters, digits and dashes.');
  if (flags.click && flags.goto) throw new Error('Give --click or --goto, not both.');
  const maxMinutes = number(flags.maxMinutes, 'max-minutes', 1, 60), maxSteps = number(flags.maxSteps, 'max-steps', 1, 100);
  const { resumeKeygrab } = await import('../agent/computer/keygrab-resume.js');
  const { narrowTask, resumeCommand } = await import('../agent/computer/connector-runner.js');
  const result = await resumeKeygrab({ stateDir: stateDirectory(), id, ...(flags.click ? { click: flags.click } : {}), ...(flags.goto ? { goto: flags.goto } : {}), ...(flags.only ? { only: true } : {}), ...(maxMinutes ? { maxMs: maxMinutes * 60_000 } : {}), ...(maxSteps ? { maxSteps } : {}) });
  const { outcome } = result;
  let onboard: string | undefined;
  if (outcome.ok) {
    // The key is in ClikDeploy: let it take its next step (publish, proof) so the item moves on.
    try {
      const { liveClient } = await import('../agent/computer/connector-runner-live.js');
      const next = await liveClient().onboard(id);
      onboard = `${next.state}${next.stage ? ` at ${next.stage}` : ''}: ${next.reason ?? ''}`.slice(0, 240);
    } catch (error) { onboard = `could not call onboard (${(error instanceof Error ? error.message : String(error)).slice(0, 120)})`; }
  }
  const summary = outcome.ok
    ? { id, captured: true, reattached: result.reattached, ...(result.pressed ? { pressed: result.pressed } : {}), note: outcome.note, recipeRecorded: outcome.recipe === true, ...(onboard ? { onboard } : {}) }
    : { id, captured: false, reattached: result.reattached, ...(result.pressed ? { pressed: result.pressed } : {}), why: outcome.stop.message, url: outcome.stop.url, page: outcome.stop.pageText, controls: outcome.stop.controls.slice(0, flags.only ? 60 : 12), visited: outcome.stop.visited, menus: outcome.stop.menus, trail: outcome.stop.trail?.slice(-12), parked: outcome.stop.parked === true, ...(outcome.stop.parked ? { resume: resumeCommand(id), narrowTask: narrowTask(id, outcome.stop) } : {}) };
  if (isJsonDefaultMode()) return emitResult({ connectors: { resume: summary } });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}
