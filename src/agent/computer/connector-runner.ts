/** A deterministic runner for ClikDeploy's connector onboarding: it loops `connector_onboard_batch` / `connector_onboard` and does each
 * returned `next` task without a model when the task is a known kind (connect a test account through the consent driver, capture a key by a
 * saved recipe, call a pipeline tool, call onboard again). A screen or task it does not know is handed to an agent as a structured request
 * in the work item's note; a wall only a person clears (captcha, SMS or authenticator code, payment, identity, review) is reported blocked
 * with a full humanStep. It solves a captcha itself (the vision model answers the puzzle), never spends money, and never prints a key, and every vendor has a step and time budget. */
import { quiet } from '../../runtime/lifecycle-log.js';
import { scrubSecrets } from './secret-scrubber.js';
import { BACKOFF_HOURS } from './keygrab-park.js';
import { sleep as sleepFor } from '../../runtime/sleep.js';
import type { AgentCall, DeployClient, Plan, BrowserDriver, DriveOutcome, HandoffRequest, HumanStep, OnboardResult, RunnerOptions, StopInfo, VendorOutcome, VendorStatus } from './connector-types.js';
import { CLOUD_VENDOR, WAIT_LIMIT_MS, docsToSpecPrompt, isSpecFix, narrowTask, oauthAppTask, planFor, referenceTask, resumeCommand, siteUrl, unsettledDiscovery } from './connector-tasks.js';
import { hostOf, humanStepFor } from './connector-walls.js';

// The runner's parts moved to connector-types.ts, connector-tasks.ts and connector-walls.ts; what other files import from here stays.
export type { HumanKind, HumanStep, OnboardResult, StopInfo, DriveOutcome, DeployClient, BrowserDriver, VendorOutcome } from './connector-types.js';
export { BACKOFF_HOURS } from './keygrab-park.js';
export { docsToSpecPrompt, oauthAppTask, otherUrls, planFor, referenceTask, resumeCommand, siteUrl, narrowTask } from './connector-tasks.js';
export { humanStepFor } from './connector-walls.js';

const fix = (r: OnboardResult): OnboardResult => r.next ? r : { ...r, next: { kind: 'none', task: r.reason } };
const cap = (text: string, n: number): string => text.length > n ? `${text.slice(0, n - 1)}…` : text;
const firstLine = (text: string): string => text.split('\n')[0] ?? text;
const scrubArgs = (call: AgentCall): AgentCall => JSON.parse(scrubSecrets(JSON.stringify(call))) as AgentCall;
const say = (text: string): string => scrubSecrets(text);

/** Runs one vendor from the result of its latest onboarding step until it is finished, handed on, or out of budget. */
export async function runVendor(first: OnboardResult, client: DeployClient, driver: BrowserDriver, options: RunnerOptions, gate: <T>(job: () => Promise<T>) => Promise<T>): Promise<VendorOutcome> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? sleepFor;
  const maxSteps = options.maxSteps ?? 12, maxMs = options.maxMs ?? 300_000;
  // Time spent in an agent hand-off is the agent's own budget, not the deterministic steps'.
  let agentSpent = 0;
  const startedAt = now();
  const elapsed = (): number => now() - startedAt - agentSpent;
  const id = first.id;
  // Every action is logged as it starts, so a vendor that hangs shows where (the loop's hard time limit names the last one).
  const actions: string[] = [];
  const push = actions.push.bind(actions);
  actions.push = (...lines: string[]): number => { for (const line of lines) { options.log?.(`step: ${cap(say(line), 200)}`); options.onAction?.(line); } return push(...lines); };
  options.onAction?.(`started at stage ${first.stage || 'unknown'}: ${cap(say(first.next.task), 120)}`);
  let result = fix(first), steps = 0, browserActions = 0, recipeSaved = false;
  const seen = new Map<string, number>();
  const out = (status: VendorStatus, summary: string, extra: Partial<VendorOutcome> = {}): VendorOutcome => ({ id, status, steps, browserActions, stage: result.stage, summary: say(summary), actions, ...(recipeSaved ? { recipe: true } : {}), ...extra });
  const handoff = async (why: string, stop?: StopInfo): Promise<VendorOutcome> => {
    const next = result.next;
    const request: HandoffRequest = {
      id, why: cap(say(why), 300), task: say(next.task),
      ...(next.kind === 'agent' && next.call ? { call: scrubArgs(next.call) } : {}),
      ...(next.kind === 'agent' && next.orElse ? { orElse: scrubArgs(next.orElse) } : {}),
      ...(result.attention ? { attention: JSON.parse(say(JSON.stringify(result.attention))) as unknown } : {}),
      ...(result.evidence?.length ? { evidence: result.evidence.slice(-3).map(line => cap(say(line), 300)) } : {}),
      ...(isSpecFix(next.task) || isSpecFix(result.reason) ? { specFix: true } : {}),
      ...(stop ? { url: stop.url, pageText: cap(say(stop.pageText), 300), controls: stop.controls.slice(0, 12).map(c => say(c)), ...(stop.screenshot ? { screenshot: stop.screenshot } : {}) } : {}),
      ...(stop?.parked ? {
        resume: resumeCommand(id), vendorUrl: stop.vendorUrl, narrowTask: narrowTask(id, stop),
        ...(stop.trail?.length ? { trail: stop.trail.slice(-20).map(t => cap(say(t), 100)) } : {}),
        ...(stop.visited?.length ? { visited: stop.visited.slice(-20) } : {}),
        ...(stop.menus?.length ? { menus: stop.menus.slice(-8).map(m => cap(say(m), 240)) } : {}),
      } : {}),
    };
    let file: string | undefined;
    try {
      const dir = await (options.handoffDir ?? defaultHandoffDir)();
      file = `${dir}/${id}.handoff.json`;
      await (options.writeFile ?? defaultWrite)(file, `${JSON.stringify(request, null, 2)}\n`);
    } catch { file = undefined; }
    let recorded = 'the request is in the result only';
    try {
      // The note is short; the file holds the whole request. The task text goes in the note whole up to the note's own limit.
      const full = `clikcode connectors run handed this on: ${JSON.stringify(request)}`;
      const lean = full.length > 3900 ? `clikcode connectors run handed this on (the file ${file ?? 'in the result'} holds the rest): ${JSON.stringify({ ...request, pageText: undefined, controls: undefined, attention: undefined })}` : full;
      await client.note(id, cap(lean, 3900));
      recorded = 'written to the work item note';
    } catch (error) { recorded = `could not write the work item note (${cap(say(error instanceof Error ? error.message : String(error)), 120)})`; }
    return out('handoff', why, { handoff: { ...(file ? { file } : {}), request }, recorded, ...(stop?.parked ? { resume: resumeCommand(id) } : {}) });
  };
  const wall = async (human: HumanStep, fromServer: boolean): Promise<VendorOutcome> => {
    if (fromServer) return out('human', result.reason, { humanStep: human, recorded: 'ClikDeploy already holds this human step' });
    let recorded = 'reported blocked with the human step';
    try {
      await client.report({ id, outcome: 'blocked', reason: cap(say(`${human.kind}: ${human.instructions ?? result.reason}`), 480).padEnd(10, '.'), humanStep: { ...human, instructions: cap(human.instructions ?? '', 300) } });
    } catch (error) { recorded = `could not report it (${cap(say(error instanceof Error ? error.message : String(error)), 120)})`; }
    return out('human', human.instructions ?? human.kind, { humanStep: human, recorded });
  };
  // Each distinct onboarding task gets one bounded agent attempt. A completed task may
  // advance to another task within the vendor budget; an unchanged task never retries.
  const agentTasksTried = new Set<string>();
  let qualified = false;
  let referenceTried = false;
  let appRegistrationTried = false;
  let accessRequested = false;
  /** What the qualifier read on the vendor's pages, or could not read: leads for an agent to check, never a reason to stop or to start one. */
  let leads: string | undefined;
  const viaAgent = async (given: StopInfo, wholeTask = false): Promise<DriveOutcome | undefined> => {
    const stop = leads ? { ...given, pageText: `${given.pageText}\nWhat the qualifier read on the vendor's pages (unverified leads, not walls: check them on the live site): ${leads}` } : given;
    const taskKey = JSON.stringify([result.stage, result.next.kind, result.next.task]);
    if (agentTasksTried.has(taskKey) || !driver.agentTask || !wholeTask && (stop.human || humanStepFor(id, stop))) return undefined;
    agentTasksTried.add(taskKey);
    actions.push('an unrecognized screen: one bounded agent micro-task');
    const agentBegan = now();
    options.onAgent?.(true);
    let done: DriveOutcome;
    try { done = await gate(() => driver.agentTask!(id, stop, { maxCalls: options.agentCalls ?? 25, maxMs: options.agentMs ?? Math.max(30_000, maxMs - elapsed()) })); }
    finally { options.onAgent?.(false); }
    if (options.agentMs) agentSpent += now() - agentBegan;
    if (done.ok && done.recipe) recipeSaved = true;
    return done;
  };
  const stopped = async (stop: StopInfo): Promise<VendorOutcome> => {
    browserActions += stop.actions ?? stop.trail?.length ?? 0;
    if (stop.trail?.length) actions.push(`keygrab did: ${stop.trail.join(' > ')}`);
    const human = stop.human ?? humanStepFor(id, stop);
    const resume = stop.parked ? resumeCommand(id) : undefined;
    if (!human) return handoff(`${stop.kind === 'unknown' ? 'an unrecognized screen' : stop.kind}: ${stop.message}`, stop);
    // A captcha the solver could not get past: do not come back for an hour. The end time goes in the attention item.
    let until: Date | undefined;
    if (human.kind === 'captcha' && driver.recordBackoff) until = await driver.recordBackoff(id).catch(quiet('agent/computer/connector-runner'));
    const note = until ? ` Backed off ${BACKOFF_HOURS} hours: the runner will not try ${id} again before ${until.toISOString()}.` : '';
    const out2 = await wall({ ...human, instructions: `${cap(human.instructions ?? '', 220)}${note}`.trim() }, false);
    return { ...out2, ...(resume ? { resume } : {}), ...(until ? { backoffUntil: until.toISOString() } : {}) };
  };

  let reusedCredential = false;
  let waitedMs = 0;
  for (;;) {
    if (steps >= maxSteps) return out('budget', `step budget of ${maxSteps} used; ${result.stage} is where it stands`);
    if (elapsed() > maxMs) return out('budget', `time budget of ${Math.round(maxMs / 1000)}s used; ${result.stage} is where it stands`);
    const key = `${result.stage}|${result.next.kind}|${result.next.task}`;
    const times = (seen.get(key) ?? 0) + 1;
    seen.set(key, times);
    // "Call onboard again" is ClikDeploy saying its own work (a test job, a build) is still running: that is waited out with longer
    // and longer pauses for up to WAIT_LIMIT_MS, not counted as the runner going round in circles.
    const stillRunning = result.next.kind === 'call' && waitedMs < WAIT_LIMIT_MS;
    if (times > 3 && !stillRunning) return out('budget', `no progress: the same task came back ${times - 1} times (${cap(say(result.next.task), 120)})`);

    const recipe = result.next && result.next.kind === 'agent' && !result.next.call && !/oauth_connect/i.test(result.next.task) ? await driver.hasRecipe(id, siteUrl(result.next.task)) : false;
    const plan = planFor(result, recipe);
    steps++;
    try {
      if (!reusedCredential && driver.reuseCredential && (plan.do === 'capture' || plan.do === 'oauth' || /^(auth|connect|credential)$/.test(result.stage))) {
        reusedCredential = true;
        const saved = await driver.reuseCredential(id);
        if (saved && typeof saved === 'object') {
          const repaired = await viaAgent({ kind: 'unknown', message: saved.problem, url: siteUrl(result.next.task) ?? '', pageText: `A credential is already saved. Diagnose its connection and definition with connector_task; do not create another account or key. ${saved.problem}`, controls: [] }, true);
          if (repaired?.ok) { result = fix(await client.onboard(id)); continue; }
          return await handoff(`The saved credential could not connect: ${saved.problem}`);
        }
        if (saved) {
          actions.push('connected the saved credential without opening signup');
          result = fix(await client.onboard(id));
          continue;
        }
      }
      // Qualify acquisition only, after saved credentials have had their chance.
      // Documentation, copy and proof work do not need a new vendor account.
      const acquisition = plan.do === 'capture' || plan.do === 'oauth' || plan.do === 'handoff' && /^(auth|connect|credential|triage)$/.test(result.stage) && !/docs-to-spec|connector_copy_task|copy[- :]+review|wording|connector_spec|connector_build|proof/i.test(result.next.task);
      if (!qualified && driver.qualify && acquisition) {
        qualified = true;
        const q = await gate(() => driver.qualify!(id)).catch(() => ({ lane: 'research' as const, summary: 'rendered qualification could not complete', human: undefined }));
        actions.push(`qualify: lane ${q.lane} - ${cap(say(q.summary), 160)}`);
        // Only a site that is not there stops here. A qualifier that could not settle the vendor used to hand it straight to an agent,
        // skipping the deterministic sign-up and key capture (517 agent runs in a day, two thirds with no result): what it read is now
        // carried as leads to whatever runs next, and the plan runs.
        if (q.lane === 'dead' && q.human) return await wall(q.human, false);
        if (q.lane !== 'auto') leads = cap(say(q.summary), 400);
      }
      switch (plan.do) {
        case 'done': return out(plan.status, result.reason || result.next.task);
        case 'human': {
          // Registering the platform's own OAuth app at a vendor is form-filling an agent can do: one bounded try, under its own rule
          // (connector-micro-agent.ts oauthAppRule). A vendor that reviews apps, or a second visit, stays a person's step.
          const step = plan.humanStep;
          if (step.kind === 'app-registration' && driver.agentTask && !appRegistrationTried && !CLOUD_VENDOR.test(id)) {
            appRegistrationTried = true;
            const done = await viaAgent({ kind: 'unknown', message: `oauth-app: ${cap(say(step.instructions ?? result.reason), 260)}`, url: step.url ?? siteUrl(result.next.task) ?? '', pageText: oauthAppTask(id, step, result.next.task), controls: [] }, true);
            if (done?.ok) {
              actions.push(done.note ?? 'an agent registered the OAuth app and filed its client secret');
              result = fix(await client.onboard(id));
              break;
            }
            if (done && !done.ok) actions.push(`the agent could not register the OAuth app: ${cap(say(done.stop.message), 160)}`);
            // What the agent met (a paid plan, an app review) is the real step now: it replaces "register an app" on the person's list.
            if (done && !done.ok && done.stop.human && done.stop.human.kind !== 'app-registration') return await stopped(done.stop);
          }
          // A sales-only vendor is asked once, through its own form, for developer access; its answer comes by email.
          if (step.kind === 'vendor-contact' && driver.agentTask && !accessRequested && !CLOUD_VENDOR.test(id) && !/access requested|no access form/i.test(`${step.instructions ?? ''} ${result.reason}`)) {
            accessRequested = true;
            const asked = await viaAgent({ kind: 'unknown', message: `access-request: ${cap(say(step.instructions ?? result.reason), 260)}`, url: step.url ?? siteUrl(result.next.task) ?? '', pageText: `Ask the vendor for developer API access for connector "${id}". What ClikDeploy says: ${cap(say(step.instructions ?? result.reason), 600)}`, controls: [] }, true);
            if (asked && !asked.ok && asked.stop.human) return await stopped(asked.stop);
          }
          return await wall(plan.humanStep, true);
        }
        case 'handoff': {
          let task = result.next.task;
          // "No reference found" is first answered with a browser, not an agent: most documentation sites load a description file a plain fetch never sees.
          const wanted = referenceTask(task) ?? unsettledDiscovery(result);
          if (wanted && driver.findReference && !referenceTried) {
            referenceTried = true;
            const found = await gate(() => driver.findReference!(id, wanted.homepage)).catch(() => ({ applied: false, note: 'the browser search could not run', docsUrls: [] as string[] }));
            actions.push(`reference search: ${cap(say(found.note), 200)}`);
            if (found.applied) { result = fix(await client.onboard(id)); break; }
            // Nothing machine-readable: the agent writes the spec, from the documentation pages the browser saw.
            const docs = [...new Set([...found.docsUrls, ...wanted.docs])].slice(0, 4);
            task = docsToSpecPrompt(id, wanted.homepage, docs);
          }
          const agent = await viaAgent({ kind: 'unknown', message: plan.why, url: siteUrl(task) ?? '', pageText: task, controls: [] }, true);
          if (agent?.ok) {
            actions.push(agent.note ?? 'the agent micro-task finished');
            if (agent.recipe) recipeSaved = true;
            result = fix(await client.onboard(id));
            break;
          }
          if (agent && !agent.ok && (agent.stop.human || humanStepFor(id, agent.stop))) return await stopped(agent.stop);
          return await handoff(agent && !agent.ok ? `${plan.why}; ${agent.stop.message}` : plan.why);
        }
        case 'reference': {
          // A vendor ClikDeploy parked for want of an API reference, the browser search not yet run for it: run it once. A spec it finds is
          // stored and the item reopened; nothing found leaves the item where ClikDeploy put it, with what the search saw.
          if (referenceTried || !driver.findReference) return out('blocked', plan.why);
          referenceTried = true;
          const found = await gate(() => driver.findReference!(id, plan.homepage)).catch(() => ({ applied: false, note: 'the browser search could not run', docsUrls: [] as string[] }));
          actions.push(`reference search: ${cap(say(found.note), 200)}`);
          if (!found.applied && found.docsUrls.length && driver.agentTask) {
            // The browser has exhausted its deterministic formats; HTML docs still need interpretation. Only now ask an agent to
            // turn the pages actually seen into a spec. A total miss stays parked and spends no agent turn.
            const prompt = docsToSpecPrompt(id, plan.homepage, found.docsUrls.slice(0, 4));
            const agent = await viaAgent({ kind: 'unknown', message: 'HTML API docs were found, but no machine-readable spec; convert the documented endpoints into a connector spec', url: found.docsUrls[0] ?? plan.homepage, pageText: prompt, controls: [] }, true);
            if (agent?.ok) {
              await client.tool('connector_work_enqueue', { id, retry: true });
              actions.push('reopened the item with the documentation-derived spec');
              result = fix(await client.onboard(id));
              break;
            }
            if (agent && !agent.ok && (agent.stop.human || humanStepFor(id, agent.stop))) return await stopped(agent.stop);
            return await handoff(`HTML API documentation was found, but needs a spec: ${agent && !agent.ok ? agent.stop.message : plan.why}`);
          }
          if (!found.applied) return out('blocked', `${plan.why}; browser reference search: ${found.note}`);
          await client.tool('connector_work_enqueue', { id, retry: true });
          actions.push('reopened the item with the reference stored');
          result = fix(await client.onboard(id));
          break;
        }
        case 'wait': {
          const ms = Math.min(60_000, plan.ms * 2 ** Math.max(0, (seen.get(key) ?? 1) - 1));
          // The job is persisted by ClikDeploy; if this wait and a small call margin will not fit, yield until then instead of
          // spending the vendor budget polling and later handing this deterministic task to an agent.
          const remaining = Math.max(0, maxMs - elapsed());
          if (remaining < ms + 2_000) return out('waiting', `persisted job is still running; resume in ${Math.ceil(ms / 1000)}s`, { retryAfterMs: ms });
          actions.push(`wait ${Math.round(ms / 1000)}s, call onboard again`);
          await sleep(ms);
          waitedMs += ms;
          result = fix(await client.onboard(id));
          break;
        }
        case 'oauth': {
          const wait = await driver.backoff?.(id);
          if (wait) return out('waiting', `backed off after a captcha until ${wait.toISOString()}; not retried before then`, { backoffUntil: wait.toISOString() });
          actions.push('connect the test account through the consent driver');
          let done = await gate(() => driver.oauthConnect(id));
          if (!done.ok) { const again = await viaAgent(done.stop); if (again) done = again; }
          if (!done.ok) return await stopped(done.stop);
          actions.push(done.note ?? 'consent finished, ClikDeploy shows an active connection');
          result = fix(await client.onboard(id));
          break;
        }
        case 'capture': {
          const wait = await driver.backoff?.(id);
          if (wait) return out('waiting', `backed off after a captcha until ${wait.toISOString()}; not retried before then`, { backoffUntil: wait.toISOString() });
          const generic = async (url: string, alternates = plan.alternates): Promise<DriveOutcome> => {
            actions.push('no saved recipe fits: keygrab signs in, finds the key page, creates and captures a key');
            return gate(() => driver.keygrab(id, url, { maxMs: Math.max(30_000, maxMs - (elapsed())), ...(alternates?.length ? { alternates } : {}) }));
          };
          let done: DriveOutcome;
          if (plan.generic && plan.url) done = await generic(plan.url);
          else {
            actions.push('capture the key with the saved recipe');
            done = await gate(() => driver.captureKey(id, plan.url));
            // A recipe that no longer fits (the site changed) falls back to the generic policy; a wall stays a wall.
            if (!done.ok && plan.url && !done.stop.human && !humanStepFor(id, done.stop)) done = await generic(plan.url);
          }
          if (!done.ok) { const again = await viaAgent(done.stop); if (again) done = again; }
          if (!done.ok) return await stopped(done.stop);
          browserActions += done.actions ?? 0;
          actions.push(done.note ?? 'key captured unseen and sent to ClikDeploy');
          if (done.recipe) recipeSaved = true;
          result = fix(await client.onboard(id));
          break;
        }
        case 'report': {
          // A judgement task: the answer is the blocked report ClikDeploy already wrote. Making it puts the item on the attention list.
          const args = plan.call.args;
          const given = typeof args.reason === 'string' ? args.reason.trim() : '';
          const reason = given.length >= 10 ? given : (result.reason || firstLine(result.next.task)).padEnd(10, '.');
          const humanStep = args.humanStep && typeof args.humanStep === 'object' ? args.humanStep as HumanStep : undefined;
          actions.push('report the item blocked with the reason ClikDeploy wrote, so it shows on the attention list');
          await client.report({ id, outcome: 'blocked', reason: cap(say(reason), 480), ...(humanStep ? { humanStep } : {}) });
          return out('blocked', `reported blocked: ${cap(say(reason), 160)}`, { recorded: 'the item is attention on the list' });
        }
        case 'specfix': {
          // Deterministic spec work for the gate/enrich tools, not browser work: the file is for an agent that can use connector_spec_patch.
          actions.push('spec-fix: the auth probe ended path-wrong or in the wrong place');
          const handed = await handoff(plan.why);
          const reason = `platform-gap: ${cap(say(result.reason || firstLine(result.next.task)), 250)}`.padEnd(10, '.');
          let recorded = handed.recorded ?? '';
          try {
            await client.report({ id, outcome: 'blocked', reason, humanStep: { kind: 'worker-setup', reasonCode: 'spec-fix', instructions: 'A builder fixes the connector spec (auth probe path or placement); nothing for a vendor portal.' } });
            recorded = `reported as attention kind platform-gap owner builder; ${recorded}`;
          } catch (error) { recorded = `could not report it (${cap(say(error instanceof Error ? error.message : String(error)), 120)}); ${recorded}`; }
          return { ...handed, status: 'blocked', summary: `spec-fix: ${plan.why}`, recorded, attention: { kind: 'platform-gap', owner: 'builder' } };
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
            if (elapsed() > maxMs) break;
          }
          actions.push(`${plan.call.tool} answered ${state || 'with no state'}`);
          result = fix(await client.onboard(id));
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
  if (options.published) {
    if (!options.ids?.length) throw new Error('--published needs --ids: it connects the named connectors only.');
    const outcomes: VendorOutcome[] = [];
    for (const id of options.ids) {
      const wait = await driver.backoff?.(id);
      const outcome: VendorOutcome = wait
        ? { id, status: 'waiting', steps: 0, browserActions: 0, stage: 'connect', summary: `backed off after a captcha until ${wait.toISOString()}`, actions: [], backoffUntil: wait.toISOString() }
        : await driver.oauthConnect(id).then(done => done.ok
          ? { id, status: 'published' as const, steps: 1, browserActions: 1, stage: 'connect', summary: say(done.note ?? 'consent finished, ClikDeploy shows an active connection'), actions: ['connect only (published connector): consent driver'] }
          : { id, status: 'error' as const, steps: 1, browserActions: 1, stage: 'connect', summary: cap(say(done.stop.message), 300), actions: ['connect only (published connector): consent driver'] },
        (error: unknown) => ({ id, status: 'error' as const, steps: 1, browserActions: 0, stage: 'connect', summary: cap(say(error instanceof Error ? error.message : String(error)), 300), actions: [] }));
      options.log?.(`${id}: ${outcome.status}${outcome.summary ? ` - ${outcome.summary}` : ''}`);
      outcomes.push(outcome);
    }
    return { outcomes, skipped: [] };
  }
  const limit = Math.min(Math.max(options.limit ?? options.ids?.length ?? 5, 1), 25);
  const batch = await client.batch({ ...(options.ids?.length ? { ids: options.ids } : { limit }), parallel: Math.min(Math.max(options.parallel ?? 1, 1), 4) });
  options.log?.(`advanced ${batch.results.length} vendors by one step`);
  // One browser: browser work takes turns whatever the vendor parallelism.
  let tail: Promise<unknown> = Promise.resolve();
  const gate = <T>(job: () => Promise<T>): Promise<T> => { const run = tail.then(job, job); tail = run.catch(quiet('agent/computer/connector-runner')); return run; };
  const outcomes: VendorOutcome[] = [];
  const queue = [...batch.results];
  const worker = async (): Promise<void> => {
    for (let r = queue.shift(); r; r = queue.shift()) {
      const outcome = await runVendor(r, client, driver, options, gate).catch((error: unknown): VendorOutcome => ({ id: r!.id, status: 'error', steps: 0, browserActions: 0, stage: r!.stage, summary: cap(say(error instanceof Error ? error.message : String(error)), 200), actions: [] }));
      options.log?.(`${outcome.id}: ${outcome.status}${outcome.summary ? ` - ${outcome.summary}` : ''}`);
      outcomes.push(outcome);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(options.parallel ?? 1, 1), 4, queue.length || 1) }, worker));
  return { outcomes, skipped: batch.skipped };
}

interface PlanLine { id: string; reason: string; plan: string }

/** The dry run: what each waiting vendor's current task would get, with nothing changed at ClikDeploy or in the browser. */
export async function dryRun(client: DeployClient, driver: BrowserDriver, options: RunnerOptions = {}): Promise<PlanLine[]> {
  const waiting = await client.waiting();
  const limit = Math.min(Math.max(options.limit ?? options.ids?.length ?? 5, 1), 25);
  const picked = options.ids?.length ? options.ids.map(id => waiting.find(w => w.id === id) ?? { id, reason: 'not waiting for an agent', task: '' }) : waiting.slice(0, limit);
  const lines: PlanLine[] = [];
  for (const w of picked) {
    if (!w.task) { lines.push({ id: w.id, reason: w.reason, plan: 'advance one onboarding step, then act on the task it returns' }); continue; }
    const url = siteUrl(w.task);
    const recipe = await driver.hasRecipe(w.id, url).catch(() => false);
    const plan = planFor({ id: w.id, state: 'needs-agent', stage: 'connect', reason: w.reason, next: { kind: 'agent', task: w.task } }, recipe);
    lines.push({ id: w.id, reason: cap(say(w.reason), 160), plan: describePlan(plan) });
  }
  return lines;
}

function describePlan(plan: Plan): string {
  switch (plan.do) {
    case 'oauth': return 'connect the test account: ClikDeploy authorization URL, then press the consent screens in the ClikCode browser (Google sign-in first); confirm an active connection; call onboard again';
    case 'capture': return plan.generic
      ? `keygrab (no recipe fits${plan.url ? `, ${hostOf(plan.url)}` : ''}): sign in (Google, GitHub, then profile email), find the API key page, create a key named ClikDeploy, capture it unseen, send it to ClikDeploy, record the recipe; call onboard again`
      : `capture the key with the saved recipe${plan.url ? ` (${hostOf(plan.url)})` : ''}, unseen, send it to ClikDeploy; call onboard again`;
    case 'report': return 'report the item blocked with the reason ClikDeploy wrote (it becomes attention on the list)';
    case 'specfix': return 'spec-fix: report attention kind platform-gap owner builder, and write a hand-off file for an agent that can patch the spec';
    case 'tool': return `call ${plan.call.tool} until it stops running; call onboard again`;
    case 'wait': return `wait ${plan.ms / 1000}s, call onboard again`;
    case 'human': return `record the human step (${plan.humanStep.kind})`;
    case 'done': return `nothing to do (${plan.status})`;
    case 'handoff': return `hand to an agent via a work item note: ${plan.why}`;
    case 'reference': return `search ${hostOf(plan.homepage)} for its API reference with the browser; store it and reopen the item when one is found`;
  }
}
