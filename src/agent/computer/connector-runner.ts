/** A deterministic runner for ClikDeploy's connector onboarding: it loops `connector_onboard_batch` / `connector_onboard` and does each
 * returned `next` task without a model when the task is a known kind (connect a test account through the consent driver, capture a key by a
 * saved recipe, call a pipeline tool, call onboard again). A screen or task it does not know is handed to an agent as a structured request
 * in the work item's note; a wall only a person clears (captcha, SMS or authenticator code, payment, identity, review) is reported blocked
 * with a full humanStep. It never solves a captcha, spends money, or prints a key, and every vendor has a step and time budget. */
import { scrubSecrets } from './secret-scrubber.js';
import { detectBlocker } from './signup-recipes.js';

export type HumanKind = 'captcha' | 'mfa' | 'payment' | 'identity' | 'app-review' | 'app-registration' | 'worker-setup';
export interface HumanStep { kind: HumanKind | 'retire'; url?: string; instructions?: string; reasonCode?: string; prefill?: string[] }
export interface AgentCall { tool: string; args: Record<string, unknown> }
export type Next =
  | { kind: 'call'; task: string }
  | { kind: 'agent'; task: string; then?: string; call?: AgentCall; orElse?: AgentCall }
  | { kind: 'human'; task: string; humanStep: HumanStep; then?: string }
  | { kind: 'none'; task: string };
export interface OnboardResult { id: string; state: 'running' | 'needs-agent' | 'needs-human' | 'published' | 'blocked'; stage: string; route?: string | null; next: Next; reason: string; lease?: string }

/** Where a browser step stopped, as data. */
export interface StopInfo {
  kind: 'captcha' | 'mfa' | 'payment' | 'password' | 'unrecognized-client' | 'choice' | 'unknown';
  message: string; url: string; pageText: string; controls: string[]; screenshot?: string;
}
export type DriveOutcome = { ok: true; note?: string } | { ok: false; stop: StopInfo };

/** ClikDeploy as the runner sees it. */
export interface DeployClient {
  /** Read-only: the vendors waiting for an agent and the task each one has. */
  waiting(): Promise<Array<{ id: string; reason: string; task: string }>>;
  batch(input: { ids?: string[]; limit?: number; parallel?: number }): Promise<{ results: OnboardResult[]; skipped: Array<{ id: string; why: string }> }>;
  onboard(id: string): Promise<OnboardResult>;
  report(input: { id: string; outcome: 'blocked' | 'retry'; reason: string; humanStep?: HumanStep }): Promise<void>;
  note(id: string, text: string): Promise<void>;
  tool(name: string, args: Record<string, unknown>): Promise<unknown>;
}
/** The browser as the runner sees it. */
export interface BrowserDriver {
  oauthConnect(id: string): Promise<DriveOutcome>;
  /** Whether a saved recipe could capture a key for this connector (the address is a hint taken from the task). */
  hasRecipe(id: string, url?: string): Promise<boolean>;
  captureKey(id: string, url?: string): Promise<DriveOutcome>;
}

export interface RunnerOptions {
  ids?: string[]; limit?: number; parallel?: number;
  /** Most actions per vendor (default 12). */ maxSteps?: number;
  /** Most time per vendor in ms (default 300000). */ maxMs?: number;
  dryRun?: boolean;
  now?: () => number; sleep?: (ms: number) => Promise<void>;
  /** Where hand-off requests are written (default: a fresh temp directory). */ handoffDir?: () => Promise<string>;
  writeFile?: (path: string, text: string) => Promise<void>;
  log?: (line: string) => void;
}

export type VendorStatus = 'published' | 'blocked' | 'human' | 'handoff' | 'budget' | 'waiting' | 'error';
export interface VendorOutcome { id: string; status: VendorStatus; steps: number; stage: string; summary: string; actions: string[]; humanStep?: HumanStep; handoff?: { file?: string; request: HandoffRequest }; recorded?: string }
export interface HandoffRequest { id: string; why: string; task: string; url?: string; pageText?: string; controls?: string[]; screenshot?: string }

/** The task kinds the runner knows. */
export type Plan =
  | { do: 'done'; status: 'published' | 'blocked' }
  | { do: 'wait'; ms: number }
  | { do: 'oauth' }
  | { do: 'tool'; call: AgentCall }
  | { do: 'capture'; url?: string }
  | { do: 'human'; humanStep: HumanStep }
  | { do: 'handoff'; why: string };

/** Tools the runner may call on ClikDeploy's behalf, because they only advance or read the pipeline. */
export const RUNNABLE_TOOLS: ReadonlySet<string> = new Set(['connector_finish', 'connector_test_job_status', 'connector_proof', 'connector_pipeline_status']);

const URL_IN_TEXT = /https:\/\/[^\s"'<>)]+/;
const WALL_STATES = new Set(['needs-human']);

export function waitMs(task: string, fallback = 5_000): number {
  const m = /(\d+)\s*(?:s\b|sec)/i.exec(task);
  return Math.min(Math.max(m ? Number(m[1]) * 1000 : fallback, 1_000), 60_000);
}

/** What to do about the task ClikDeploy returned. `recipe` says whether a saved recipe exists for it. */
export function planFor(result: OnboardResult, recipe: boolean): Plan {
  const next = result.next;
  if (result.state === 'published') return { do: 'done', status: 'published' };
  if (next.kind === 'none') return { do: 'done', status: result.state === 'blocked' ? 'blocked' : 'published' };
  if (next.kind === 'call') return { do: 'wait', ms: waitMs(next.task) };
  if (next.kind === 'human') return { do: 'human', humanStep: next.humanStep };
  if (WALL_STATES.has(result.state)) return { do: 'handoff', why: 'ClikDeploy says a person is needed but gave no step' };
  const call = next.call;
  if (call?.tool === 'oauth_connect') return { do: 'oauth' };
  if (call && RUNNABLE_TOOLS.has(call.tool)) return { do: 'tool', call };
  if (call) return { do: 'handoff', why: `the task is the ${call.tool} call, which needs judgement` };
  if (/\boauth_connect\b|computer oauth-connect/i.test(next.task)) return { do: 'oauth' };
  if (/\b(api key|capture_secret|credential|key)\b/i.test(next.task) && recipe) return { do: 'capture', ...(URL_IN_TEXT.exec(next.task)?.[0] ? { url: URL_IN_TEXT.exec(next.task)![0] } : {}) };
  return { do: 'handoff', why: recipe ? 'the task is not one of the known kinds' : 'the task is not one of the known kinds and no saved recipe fits it' };
}

const IDENTITY = /identity verification|verify your identity|business verification|government[- ]issued|id document|passport/i;

/** A wall only a person clears, from where the browser stopped; undefined when it is just a screen the runner does not know. */
export function humanStepFor(id: string, stop: StopInfo): HumanStep | undefined {
  const url = cleanUrl(stop.url);
  const blocker = detectBlocker(stop.pageText);
  const at = url ? { url } : {};
  if (stop.kind === 'captcha' || blocker === 'a captcha') return { kind: 'captcha', ...at, reasonCode: 'captcha', instructions: `Solve the captcha at ${hostOf(url)} for ${id}, then the runner can carry on.` };
  if (stop.kind === 'mfa' || blocker === 'an SMS or authenticator code') return { kind: 'mfa', ...at, reasonCode: 'verification-code', instructions: `Enter the verification code (SMS or authenticator) at ${hostOf(url)} for ${id}.` };
  if (stop.kind === 'payment' || blocker === 'a payment page') return { kind: 'payment', ...at, reasonCode: 'payment', instructions: `${hostOf(url)} wants a card, credits or a paid plan before ${id} can continue; nothing was paid.` };
  if (IDENTITY.test(stop.pageText)) return { kind: 'identity', ...at, reasonCode: 'identity-check', instructions: `${hostOf(url)} asks for identity or business verification for ${id}.` };
  if (blocker === 'a review page') return { kind: 'app-review', ...at, reasonCode: 'app-review', instructions: `${hostOf(url)} holds the ${id} app for review; check its status.` };
  if (stop.kind === 'unrecognized-client') return { kind: 'app-registration', ...at, reasonCode: 'oauth-client-unknown', instructions: `${hostOf(url)} does not recognize ClikDeploy's OAuth client for ${id}: register the app there and save its client id and secret.` };
  if (stop.kind === 'password') return { kind: 'worker-setup', ...at, reasonCode: 'sign-in-needed', instructions: `The ClikCode browser is signed out at ${hostOf(url)}: sign in once (Google), then run the connectors again.` };
  return undefined;
}

const hostOf = (url: string | undefined): string => { try { return new URL(url ?? '').host; } catch { return 'the vendor'; } };
function cleanUrl(url: string | undefined): string | undefined {
  try { const u = new URL(url ?? ''); return u.protocol === 'https:' ? `${u.origin}${u.pathname}` : undefined; } catch { return undefined; }
}

const cap = (text: string, n: number): string => text.length > n ? `${text.slice(0, n - 1)}…` : text;
const say = (text: string): string => scrubSecrets(text);

/** Runs one vendor from the result of its latest onboarding step until it is finished, handed on, or out of budget. */
export async function runVendor(first: OnboardResult, client: DeployClient, driver: BrowserDriver, options: RunnerOptions, gate: <T>(job: () => Promise<T>) => Promise<T>): Promise<VendorOutcome> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const maxSteps = options.maxSteps ?? 12, maxMs = options.maxMs ?? 300_000;
  const began = now();
  const id = first.id;
  const actions: string[] = [];
  let result = first, steps = 0;
  const seen = new Map<string, number>();
  const out = (status: VendorStatus, summary: string, extra: Partial<VendorOutcome> = {}): VendorOutcome => ({ id, status, steps, stage: result.stage, summary: say(summary), actions, ...extra });
  const handoff = async (why: string, stop?: StopInfo): Promise<VendorOutcome> => {
    const request: HandoffRequest = {
      id, why: cap(say(why), 300), task: cap(say(result.next.task), 400),
      ...(stop ? { url: stop.url, pageText: cap(say(stop.pageText), 300), controls: stop.controls.slice(0, 12).map(c => say(c)), ...(stop.screenshot ? { screenshot: stop.screenshot } : {}) } : {}),
    };
    let file: string | undefined;
    try {
      const dir = await (options.handoffDir ?? defaultHandoffDir)();
      file = `${dir}/${id}.handoff.json`;
      await (options.writeFile ?? defaultWrite)(file, `${JSON.stringify(request, null, 2)}\n`);
    } catch { file = undefined; }
    let recorded = 'the request is in the result only';
    try {
      await client.note(id, cap(`clikcode connectors run handed this on: ${JSON.stringify(request)}`, 3900));
      recorded = 'written to the work item note';
    } catch (error) { recorded = `could not write the work item note (${cap(say(error instanceof Error ? error.message : String(error)), 120)})`; }
    return out('handoff', why, { handoff: { ...(file ? { file } : {}), request }, recorded });
  };
  const wall = async (human: HumanStep, fromServer: boolean): Promise<VendorOutcome> => {
    if (fromServer) return out('human', result.reason, { humanStep: human, recorded: 'ClikDeploy already holds this human step' });
    let recorded = 'reported blocked with the human step';
    try {
      await client.report({ id, outcome: 'blocked', reason: cap(say(`${human.kind}: ${human.instructions ?? result.reason}`), 480).padEnd(10, '.'), humanStep: { ...human, instructions: cap(human.instructions ?? '', 300) } });
    } catch (error) { recorded = `could not report it (${cap(say(error instanceof Error ? error.message : String(error)), 120)})`; }
    return out('human', human.instructions ?? human.kind, { humanStep: human, recorded });
  };
  const stopped = (stop: StopInfo): Promise<VendorOutcome> => {
    const human = humanStepFor(id, stop);
    return human ? wall(human, false) : handoff(`${stop.kind === 'unknown' ? 'an unrecognized screen' : stop.kind}: ${stop.message}`, stop);
  };

  for (;;) {
    if (steps >= maxSteps) return out('budget', `step budget of ${maxSteps} used; ${result.stage} is where it stands`);
    if (now() - began > maxMs) return out('budget', `time budget of ${Math.round(maxMs / 1000)}s used; ${result.stage} is where it stands`);
    const key = `${result.stage}|${result.next.kind}|${result.next.task}`;
    const times = (seen.get(key) ?? 0) + 1;
    seen.set(key, times);
    if (times > 3) return out('budget', `no progress: the same task came back ${times - 1} times (${cap(say(result.next.task), 120)})`);

    const recipe = result.next.kind === 'agent' && !result.next.call && !/oauth_connect/i.test(result.next.task) ? await driver.hasRecipe(id, URL_IN_TEXT.exec(result.next.task)?.[0]) : false;
    const plan = planFor(result, recipe);
    steps++;
    try {
      switch (plan.do) {
        case 'done': return out(plan.status, result.reason || result.next.task);
        case 'human': return await wall(plan.humanStep, true);
        case 'handoff': return await handoff(plan.why);
        case 'wait': {
          actions.push(`wait ${plan.ms / 1000}s, call onboard again`);
          await sleep(plan.ms);
          result = await client.onboard(id);
          break;
        }
        case 'oauth': {
          actions.push('connect the test account through the consent driver');
          const done = await gate(() => driver.oauthConnect(id));
          if (!done.ok) return await stopped(done.stop);
          actions.push(done.note ?? 'consent finished, ClikDeploy shows an active connection');
          result = await client.onboard(id);
          break;
        }
        case 'capture': {
          actions.push('capture the key with the saved recipe');
          const done = await gate(() => driver.captureKey(id, plan.url));
          if (!done.ok) return await stopped(done.stop);
          actions.push(done.note ?? 'key captured unseen and sent to ClikDeploy');
          result = await client.onboard(id);
          break;
        }
        case 'tool': {
          actions.push(`call ${plan.call.tool}`);
          let state = '';
          // A test job is retried until it stops running or the step budget ends; each call is one step.
          for (let tries = 0; tries < 6; tries++) {
            const reply = await client.tool(plan.call.tool, plan.call.args);
            state = stateOf(reply);
            if (state !== 'running') break;
            await sleep(5_000);
            if (now() - began > maxMs) break;
          }
          actions.push(`${plan.call.tool} answered ${state || 'with no state'}`);
          result = await client.onboard(id);
          break;
        }
      }
    } catch (error) {
      return out('error', `${plan.do} failed: ${cap(say(error instanceof Error ? error.message : String(error)), 200)}`);
    }
  }
}

function stateOf(reply: unknown): string {
  if (!reply || typeof reply !== 'object') return '';
  const r = reply as Record<string, unknown>;
  if (typeof r.state === 'string') return r.state;
  if (typeof r.status === 'string') return r.status;
  return r.data ? stateOf(r.data) : '';
}

async function defaultHandoffDir(): Promise<string> {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return mkdtemp(join(tmpdir(), 'clikcode-connectors-'));
}
async function defaultWrite(path: string, text: string): Promise<void> {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path, text, { mode: 0o600 });
}

/** One bounded run: one batch of up to `limit` vendors, each worked until finished, handed on, or out of budget. */
export async function runConnectors(client: DeployClient, driver: BrowserDriver, options: RunnerOptions = {}): Promise<{ outcomes: VendorOutcome[]; skipped: Array<{ id: string; why: string }> }> {
  const limit = Math.min(Math.max(options.limit ?? options.ids?.length ?? 5, 1), 25);
  const batch = await client.batch({ ...(options.ids?.length ? { ids: options.ids } : { limit }), parallel: Math.min(Math.max(options.parallel ?? 1, 1), 4) });
  options.log?.(`advanced ${batch.results.length} vendors by one step`);
  // One browser: browser work takes turns whatever the vendor parallelism.
  let tail: Promise<unknown> = Promise.resolve();
  const gate = <T>(job: () => Promise<T>): Promise<T> => { const run = tail.then(job, job); tail = run.catch(() => undefined); return run; };
  const outcomes: VendorOutcome[] = [];
  const queue = [...batch.results];
  const worker = async (): Promise<void> => {
    for (let r = queue.shift(); r; r = queue.shift()) {
      const outcome = await runVendor(r, client, driver, options, gate).catch((error: unknown): VendorOutcome => ({ id: r!.id, status: 'error', steps: 0, stage: r!.stage, summary: cap(say(error instanceof Error ? error.message : String(error)), 200), actions: [] }));
      options.log?.(`${outcome.id}: ${outcome.status}${outcome.summary ? ` - ${outcome.summary}` : ''}`);
      outcomes.push(outcome);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(options.parallel ?? 1, 1), 4, queue.length || 1) }, worker));
  return { outcomes, skipped: batch.skipped };
}

export interface PlanLine { id: string; reason: string; plan: string }

/** The dry run: what each waiting vendor's current task would get, with nothing changed at ClikDeploy or in the browser. */
export async function dryRun(client: DeployClient, driver: BrowserDriver, options: RunnerOptions = {}): Promise<PlanLine[]> {
  const waiting = await client.waiting();
  const limit = Math.min(Math.max(options.limit ?? options.ids?.length ?? 5, 1), 25);
  const picked = options.ids?.length ? options.ids.map(id => waiting.find(w => w.id === id) ?? { id, reason: 'not waiting for an agent', task: '' }) : waiting.slice(0, limit);
  const lines: PlanLine[] = [];
  for (const w of picked) {
    if (!w.task) { lines.push({ id: w.id, reason: w.reason, plan: 'advance one onboarding step, then act on the task it returns' }); continue; }
    const url = URL_IN_TEXT.exec(w.task)?.[0];
    const recipe = await driver.hasRecipe(w.id, url).catch(() => false);
    const plan = planFor({ id: w.id, state: 'needs-agent', stage: 'connect', reason: w.reason, next: { kind: 'agent', task: w.task } }, recipe);
    lines.push({ id: w.id, reason: cap(say(w.reason), 160), plan: describePlan(plan) });
  }
  return lines;
}

export function describePlan(plan: Plan): string {
  switch (plan.do) {
    case 'oauth': return 'connect the test account: ClikDeploy authorization URL, then press the consent screens in the ClikCode browser (Google sign-in first); confirm an active connection; call onboard again';
    case 'capture': return `capture the key with the saved recipe${plan.url ? ` (${hostOf(plan.url)})` : ''}, unseen, send it to ClikDeploy; call onboard again`;
    case 'tool': return `call ${plan.call.tool} until it stops running; call onboard again`;
    case 'wait': return `wait ${plan.ms / 1000}s, call onboard again`;
    case 'human': return `record the human step (${plan.humanStep.kind})`;
    case 'done': return `nothing to do (${plan.status})`;
    case 'handoff': return `hand to an agent via a work item note: ${plan.why}`;
  }
}
