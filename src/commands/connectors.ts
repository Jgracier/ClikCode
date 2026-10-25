import { stateDirectory } from '../session/store/paths.js';
import { emitResult } from '../cli/structured-output.js';
import { isJsonDefaultMode } from '../cli/output-mode.js';

export interface ConnectorsRunFlags { limit?: string; ids?: string; parallel?: string; dryRun?: boolean; maxSteps?: string; maxMinutes?: string }

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
  const limit = number(flags.limit, 'limit', 1, 25), parallel = number(flags.parallel, 'parallel', 1, 4), maxSteps = number(flags.maxSteps, 'max-steps', 1, 50), maxMinutes = number(flags.maxMinutes, 'max-minutes', 1, 60);
  const options = { ...(ids?.length ? { ids } : {}), ...(limit ? { limit } : {}), ...(parallel ? { parallel } : {}), ...(maxSteps ? { maxSteps } : {}), ...(maxMinutes ? { maxMs: maxMinutes * 60_000 } : {}) };
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
