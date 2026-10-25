import { describe, expect, it } from 'vitest';
import { dryRun, humanStepFor, planFor, runConnectors, type BrowserDriver, type DeployClient, type DriveOutcome, type OnboardResult, type StopInfo } from './connector-runner.js';

const oauthTask = (id: string): OnboardResult => ({ id, state: 'needs-agent', stage: 'connect', reason: 'a test account must be connected', next: { kind: 'agent', task: `oauth_connect: connect the test account for "${id}"`, call: { tool: 'oauth_connect', args: { id } } } });
const published = (id: string): OnboardResult => ({ id, state: 'published', stage: 'published', reason: 'published', next: { kind: 'none', task: 'nothing: the connector is published' } });
const stop = (over: Partial<StopInfo>): StopInfo => ({ kind: 'unknown', message: 'stopped', url: 'https://vendor.example/oauth/authorize', pageText: '', controls: [], ...over });

/** A fake ClikDeploy: the batch returns `first`, and each later onboard call returns the next scripted answer. */
function fakeClient(first: OnboardResult[], later: Record<string, OnboardResult[]> = {}) {
  const calls: string[] = [];
  const reports: unknown[] = [];
  const notes: Array<{ id: string; text: string }> = [];
  const client: DeployClient = {
    waiting: async () => first.filter(r => r.state === 'needs-agent').map(r => ({ id: r.id, reason: r.reason, task: r.next.task })),
    batch: async () => ({ results: first, skipped: [] }),
    onboard: async id => { calls.push(`onboard ${id}`); const r = later[id]?.shift(); if (!r) throw new Error('script ran out'); return r; },
    report: async input => { reports.push(input); },
    note: async (id, text) => { notes.push({ id, text }); },
    tool: async name => { calls.push(`tool ${name}`); return { state: 'published' }; },
  };
  return { client, calls, reports, notes };
}
function fakeDriver(outcomes: DriveOutcome[], recipe = false) {
  const driven: string[] = [];
  const driver: BrowserDriver = {
    oauthConnect: async id => { driven.push(`oauth ${id}`); return outcomes.shift() ?? { ok: true }; },
    hasRecipe: async () => recipe,
    captureKey: async id => { driven.push(`capture ${id}`); return outcomes.shift() ?? { ok: true }; },
    keygrab: async (id, url) => { driven.push(`keygrab ${id} ${url}`); return outcomes.shift() ?? { ok: true, note: 'key created, captured unseen' }; },
  };
  return { driver, driven };
}
const quick = { sleep: async () => undefined, writeFile: async () => undefined, handoffDir: async () => '/tmp/handoffs' };

describe('connectors run', () => {
  it('presses the consent screens through the driver, then asks ClikDeploy again until published', async () => {
    const c = fakeClient([oauthTask('slack')], { slack: [published('slack')] });
    const d = fakeDriver([{ ok: true, note: 'allowed access' }]);
    const { outcomes } = await runConnectors(c.client, d.driver, quick);
    expect(d.driven).toEqual(['oauth slack']);
    expect(c.calls).toEqual(['onboard slack']);
    expect(outcomes[0]).toMatchObject({ id: 'slack', status: 'published', steps: 2 });
    expect(outcomes[0]!.actions).toContain('allowed access');
  });

  it('waits and calls onboard again for a running vendor', async () => {
    const running: OnboardResult = { id: 'acme', state: 'running', stage: 'proof', reason: 'waiting', next: { kind: 'call', task: 'call connector_onboard again in about 20 seconds' } };
    const c = fakeClient([running], { acme: [published('acme')] });
    const slept: number[] = [];
    const { outcomes } = await runConnectors(c.client, fakeDriver([]).driver, { ...quick, sleep: async ms => { slept.push(ms); } });
    expect(slept).toEqual([20_000]);
    expect(outcomes[0]!.status).toBe('published');
  });

  it('hands an unknown screen to an agent as a structured request in the work item note', async () => {
    const c = fakeClient([oauthTask('zoho')]);
    const files: Array<{ path: string; text: string }> = [];
    const d = fakeDriver([{ ok: false, stop: stop({ kind: 'unknown', message: 'a screen it does not recognize', pageText: 'Pick the data center for your organisation '.repeat(12), controls: ['EU', 'US', 'India'], screenshot: '/tmp/shots/zoho.png' }) }]);
    const { outcomes } = await runConnectors(c.client, d.driver, { ...quick, writeFile: async (path, text) => { files.push({ path, text }); } });
    const o = outcomes[0]!;
    expect(o.status).toBe('handoff');
    expect(o.handoff!.request).toMatchObject({ id: 'zoho', controls: ['EU', 'US', 'India'], screenshot: '/tmp/shots/zoho.png', url: 'https://vendor.example/oauth/authorize' });
    expect(o.handoff!.request.pageText!.length).toBeLessThanOrEqual(300);
    expect(c.notes).toHaveLength(1);
    expect(c.notes[0]!.text).toContain('"screenshot":"/tmp/shots/zoho.png"');
    expect(files[0]!.path).toBe('/tmp/handoffs/zoho.handoff.json');
    expect(c.reports).toHaveLength(0);
  });

  it('hands over a task kind it does not know without running anything', async () => {
    const odd: OnboardResult = { id: 'odd', state: 'needs-agent', stage: 'connect', reason: 'r', next: { kind: 'agent', task: 'Rewrite the spec by hand', call: { tool: 'connector_spec_put', args: {} } } };
    const c = fakeClient([odd]);
    const d = fakeDriver([]);
    const { outcomes } = await runConnectors(c.client, d.driver, quick);
    expect(outcomes[0]!.status).toBe('handoff');
    expect(d.driven).toEqual([]);
    expect(c.notes[0]!.text).toContain('connector_spec_put');
  });

  it('records a captcha as a blocked report with a full human step and never retries it', async () => {
    const c = fakeClient([oauthTask('hubspot')]);
    const d = fakeDriver([{ ok: false, stop: stop({ kind: 'captcha', url: 'https://app.hubspot.com/signup?token=abc123', pageText: 'Verify you are human' }) }]);
    const { outcomes } = await runConnectors(c.client, d.driver, quick);
    expect(outcomes[0]).toMatchObject({ status: 'human', humanStep: { kind: 'captcha', url: 'https://app.hubspot.com/signup' } });
    expect(c.reports).toEqual([expect.objectContaining({ id: 'hubspot', outcome: 'blocked', humanStep: expect.objectContaining({ kind: 'captcha', url: 'https://app.hubspot.com/signup', instructions: expect.stringContaining('captcha') }) })]);
    expect(d.driven).toEqual(['oauth hubspot']);
    expect(c.notes).toHaveLength(0);
  });

  it.each([
    ['mfa', 'Enter the code', 'mfa'], ['payment', 'Add credits to continue', 'payment'], ['unrecognized-client', 'Unrecognized client_id', 'app-registration'], ['password', 'Password', 'worker-setup'],
  ] as const)('maps a %s stop to the %s human step', (kind, pageText, human) => {
    expect(humanStepFor('v', stop({ kind, pageText }))?.kind).toBe(human);
  });

  it('maps identity and review pages found in the page text', () => {
    expect(humanStepFor('v', stop({ pageText: 'Business verification is required before we can continue' }))?.kind).toBe('identity');
    expect(humanStepFor('v', stop({ pageText: 'Your application is under review' }))?.kind).toBe('app-review');
    expect(humanStepFor('v', stop({ pageText: 'Pick a region' }))).toBeUndefined();
  });

  it('stops at the step budget when the same task keeps coming back, and never loops forever', async () => {
    const again = (): OnboardResult => oauthTask('loop');
    const c = fakeClient([oauthTask('loop')], { loop: Array.from({ length: 30 }, again) });
    const d = fakeDriver([]);
    const { outcomes } = await runConnectors(c.client, d.driver, { ...quick, maxSteps: 50 });
    expect(outcomes[0]!.status).toBe('budget');
    expect(outcomes[0]!.summary).toContain('no progress');
    expect(d.driven.length).toBeLessThanOrEqual(3);
  });

  it('stops at the step budget', async () => {
    let n = 0;
    const next = (): OnboardResult => ({ id: 'busy', state: 'running', stage: `proof${n++}`, reason: '', next: { kind: 'call', task: `call again ${n}` } });
    const c = fakeClient([next()], { busy: Array.from({ length: 30 }, next) });
    const { outcomes } = await runConnectors(c.client, fakeDriver([]).driver, { ...quick, maxSteps: 4 });
    expect(outcomes[0]).toMatchObject({ status: 'budget', steps: 4 });
    expect(c.calls.length).toBe(4);
  });

  it('stops at the time budget', async () => {
    let t = 0;
    const next = (): OnboardResult => ({ id: 'slow', state: 'running', stage: `s${t}`, reason: '', next: { kind: 'call', task: `call again ${t}` } });
    const c = fakeClient([next()], { slow: Array.from({ length: 30 }, next) });
    const { outcomes } = await runConnectors(c.client, fakeDriver([]).driver, { ...quick, maxMs: 1000, now: () => (t += 400) });
    expect(outcomes[0]!.status).toBe('budget');
    expect(outcomes[0]!.summary).toContain('time budget');
  });

  it('records a human step ClikDeploy already holds without reporting it again', async () => {
    const human: OnboardResult = { id: 'stripe', state: 'needs-human', stage: 'connect', reason: 'needs a card', next: { kind: 'human', task: 'sign up', humanStep: { kind: 'payment', url: 'https://stripe.example/signup' } } };
    const c = fakeClient([human]);
    const { outcomes } = await runConnectors(c.client, fakeDriver([]).driver, quick);
    expect(outcomes[0]).toMatchObject({ status: 'human', humanStep: { kind: 'payment' } });
    expect(c.reports).toHaveLength(0);
  });

  it('captures a key by a saved recipe, and hands on when there is no recipe', async () => {
    const keyTask = (id: string): OnboardResult => ({ id, state: 'needs-agent', stage: 'connect', reason: 'no credential', next: { kind: 'agent', task: `Connector "${id}": no credential is connected. Connect an account with the API key stored in the vault.` } });
    const withRecipe = fakeClient([keyTask('salad')], { salad: [published('salad')] });
    const d1 = fakeDriver([], true);
    expect((await runConnectors(withRecipe.client, d1.driver, quick)).outcomes[0]!.status).toBe('published');
    expect(d1.driven).toEqual(['capture salad']);
    const without = fakeClient([keyTask('newco')]);
    const d2 = fakeDriver([], false);
    expect((await runConnectors(without.client, d2.driver, quick)).outcomes[0]!.status).toBe('handoff');
    expect(d2.driven).toEqual([]);
  });

  it('runs a pipeline tool the task names, then calls onboard again', async () => {
    const finish: OnboardResult = { id: 'fin', state: 'needs-agent', stage: 'finish', reason: 'r', next: { kind: 'agent', task: 'finish it', call: { tool: 'connector_finish', args: { id: 'fin' } } } };
    const c = fakeClient([finish], { fin: [published('fin')] });
    const { outcomes } = await runConnectors(c.client, fakeDriver([]).driver, quick);
    expect(c.calls).toEqual(['tool connector_finish', 'onboard fin']);
    expect(outcomes[0]!.status).toBe('published');
  });

  it('works several vendors, taking the browser one at a time', async () => {
    const c = fakeClient([oauthTask('a'), oauthTask('b'), oauthTask('c')], { a: [published('a')], b: [published('b')], c: [published('c')] });
    let active = 0, peak = 0;
    const driver: BrowserDriver = { hasRecipe: async () => false, captureKey: async () => ({ ok: true }), oauthConnect: async () => { peak = Math.max(peak, ++active); await new Promise(r => setTimeout(r, 5)); active--; return { ok: true }; } };
    const { outcomes } = await runConnectors(c.client, driver, { ...quick, parallel: 3 });
    expect(outcomes.map(o => o.status)).toEqual(['published', 'published', 'published']);
    expect(peak).toBe(1);
  });

  it('turns an error into an outcome and never prints a held secret', async () => {
    const c = fakeClient([oauthTask('x')]);
    const driver: BrowserDriver = { hasRecipe: async () => false, captureKey: async () => ({ ok: true }), oauthConnect: async () => { throw new Error('boom'); } };
    expect((await runConnectors(c.client, driver, quick)).outcomes[0]).toMatchObject({ status: 'error', summary: expect.stringContaining('boom') });
  });
});

describe('dry run', () => {
  it('shows the plan per waiting vendor and changes nothing', async () => {
    const c = fakeClient([oauthTask('slack'), { id: 'odd', state: 'needs-agent', stage: 'connect', reason: 'r', next: { kind: 'agent', task: 'Rewrite the spec by hand' } }]);
    const d = fakeDriver([]);
    const lines = await dryRun(c.client, d.driver, { limit: 5 });
    expect(lines.map(l => l.id)).toEqual(['slack', 'odd']);
    expect(lines[0]!.plan).toContain('consent');
    expect(lines[1]!.plan).toContain('hand to an agent');
    expect(d.driven).toEqual([]);
    expect(c.calls).toEqual([]);
    expect(c.reports).toEqual([]);
    expect(c.notes).toEqual([]);
  });

  it('plans a named vendor that is not waiting as one onboarding step', async () => {
    const lines = await dryRun(fakeClient([]).client, fakeDriver([]).driver, { ids: ['nothing-yet'] });
    expect(lines[0]!.plan).toContain('advance one onboarding step');
  });
});

const keyAt = (id: string, extra: Partial<OnboardResult> = {}): OnboardResult => ({ id, state: 'needs-agent', stage: 'connect', reason: `${id} needs a test credential (api-key)`, next: { kind: 'agent', task: `Connector "${id}": ${id} needs a test credential (api-key)\nget a key at https://${id}.example, capture_secret with send_to clikdeploy-connection (${id}), then call onboard again\nThen: call connector_onboard again.` }, ...extra });

describe('keygrab as the policy when no recipe fits', () => {
  it('takes a get-a-key task with no recipe through keygrab, then asks ClikDeploy again', async () => {
    const c = fakeClient([keyAt('openapi-space')], { 'openapi-space': [published('openapi-space')] });
    const d = fakeDriver([]);
    const { outcomes } = await runConnectors(c.client, d.driver, quick);
    expect(d.driven).toEqual(['keygrab openapi-space https://openapi-space.example']);
    expect(outcomes[0]).toMatchObject({ status: 'published', steps: 2 });
    expect(outcomes[0]!.actions.join(' ')).toContain('keygrab');
  });
  it('reads a bare domain after "at" as the site', async () => {
    const task = (await import('./connector-runner.js')).siteUrl('get a key at appcenter.ms/settings, capture_secret');
    expect(task).toBe('https://appcenter.ms/settings');
  });
  it('records a keygrab wall as a blocked report with its human step', async () => {
    const c = fakeClient([keyAt('appcenter-ms')]);
    const d = fakeDriver([{ ok: false, stop: stop({ kind: 'mfa', message: 'a phone (SMS) verification at appcenter.ms', url: 'https://appcenter.ms/verify', human: { kind: 'sms', url: 'https://appcenter.ms/verify', reasonCode: 'phone-verification', instructions: 'appcenter.ms shows a phone (SMS) verification' } }) }]);
    const { outcomes } = await runConnectors(c.client, d.driver, quick);
    expect(outcomes[0]).toMatchObject({ status: 'human', humanStep: { kind: 'sms', url: 'https://appcenter.ms/verify' } });
    expect(c.reports).toHaveLength(1);
    expect(c.reports[0]).toMatchObject({ id: 'appcenter-ms', outcome: 'blocked', humanStep: { kind: 'sms' } });
  });
  it('hands an unknown keygrab page on with its text, buttons and screenshot', async () => {
    const c = fakeClient([keyAt('newco')]);
    const d = fakeDriver([{ ok: false, stop: stop({ kind: 'unknown', message: 'no API key page was found', pageText: 'Hello', controls: ['Home'], screenshot: '/tmp/s.png' }) }]);
    const { outcomes } = await runConnectors(c.client, d.driver, quick);
    expect(outcomes[0]).toMatchObject({ status: 'handoff' });
    expect(outcomes[0]!.handoff!.request).toMatchObject({ controls: ['Home'], screenshot: '/tmp/s.png', pageText: 'Hello' });
  });
  it('falls back to keygrab when a saved recipe no longer fits, but not when it hit a wall', async () => {
    const c1 = fakeClient([keyAt('salad')], { salad: [published('salad')] });
    const d1 = fakeDriver([{ ok: false, stop: stop({ kind: 'unknown', message: 'recipe step failed' }) }], true);
    expect((await runConnectors(c1.client, d1.driver, quick)).outcomes[0]!.status).toBe('published');
    expect(d1.driven.map(x => x.split(' ')[0])).toEqual(['capture', 'keygrab']);
    const c2 = fakeClient([keyAt('walled')]);
    const d2 = fakeDriver([{ ok: false, stop: stop({ kind: 'captcha', message: 'captcha', pageText: 'Complete the captcha' }) }], true);
    expect((await runConnectors(c2.client, d2.driver, quick)).outcomes[0]!.status).toBe('human');
    expect(d2.driven.map(x => x.split(' ')[0])).toEqual(['capture']);
  });
  it('hands over a key task that names no site', async () => {
    const odd = keyAt('nosite', { next: { kind: 'agent', task: 'get a key for it, capture_secret' } });
    const { outcomes } = await runConnectors(fakeClient([odd]).client, fakeDriver([]).driver, quick);
    expect(outcomes[0]!.status).toBe('handoff');
  });
  it('plans keygrab in a dry run', async () => {
    const c = fakeClient([keyAt('openapi-space')]);
    const lines = await dryRun(c.client, fakeDriver([]).driver, { limit: 5 });
    expect(lines[0]!.plan).toContain('keygrab');
  });
});

describe('judgement tasks and spec fixes', () => {
  const judgement = (id: string): OnboardResult => ({ id, state: 'needs-agent', stage: 'connect', reason: 'proof and checklist gaps need judgement', next: { kind: 'agent', task: `Connector "${id}": gaps\nWhen done, report this work item with outcome "retry"`, call: { tool: 'connector_work_report', args: { id, outcome: 'blocked', reason: 'App Check needs a project-level decision' } }, orElse: { tool: 'connector_work_report', args: { id, outcome: 'retry' } } } });
  it('makes the blocked report itself instead of handing off to an agent', async () => {
    const c = fakeClient([judgement('firebaseappcheck')]);
    const { outcomes } = await runConnectors(c.client, fakeDriver([]).driver, quick);
    expect(outcomes[0]).toMatchObject({ status: 'blocked' });
    expect(c.reports).toEqual([{ id: 'firebaseappcheck', outcome: 'blocked', reason: 'App Check needs a project-level decision' }]);
    expect(c.notes).toEqual([]);
  });
  it('takes the blocked call from orElse, and the reason from the task when the call has none', async () => {
    const r = judgement('x');
    r.next = { kind: 'agent', task: 't', call: { tool: 'connector_work_report', args: { id: 'x', outcome: 'retry' } }, orElse: { tool: 'connector_work_report', args: { id: 'x', outcome: 'blocked' } } };
    const c = fakeClient([r]);
    await runConnectors(c.client, fakeDriver([]).driver, quick);
    expect(c.reports[0]).toMatchObject({ id: 'x', outcome: 'blocked', reason: 'proof and checklist gaps need judgement' });
  });
  it('reports a spec-fix task as platform-gap owned by a builder and writes a flagged hand-off file', async () => {
    const r: OnboardResult = { id: 'nytimes-movie-reviews', state: 'needs-agent', stage: 'auth', reason: 'the auth probe ended path-wrong', next: { kind: 'agent', task: `Connector "nytimes-movie-reviews": ${'a long task '.repeat(60)} the auth probe ended path-wrong` }, evidence: ['one', 'two', 'three', 'four'], attention: { kind: 'platform-gap' } };
    const c = fakeClient([r]);
    const files: Array<{ path: string; text: string }> = [];
    const { outcomes } = await runConnectors(c.client, fakeDriver([]).driver, { ...quick, writeFile: async (path, text) => { files.push({ path, text }); } });
    expect(outcomes[0]).toMatchObject({ status: 'blocked', attention: { kind: 'platform-gap', owner: 'builder' } });
    expect(c.reports[0]).toMatchObject({ outcome: 'blocked', humanStep: { kind: 'worker-setup', reasonCode: 'spec-fix' } });
    const file = JSON.parse(files[0]!.text) as { specFix: boolean; task: string };
    expect(file.specFix).toBe(true);
    expect(file.task.length).toBeGreaterThan(700);
  });
});

describe('hand-off files', () => {
  it('carry the whole task, call, orElse, the attention record and the last 3 evidence lines', async () => {
    const task = `Connector "odd": ${'x'.repeat(900)} END`;
    const r: OnboardResult = { id: 'odd', state: 'needs-agent', stage: 'connect', reason: 'r', next: { kind: 'agent', task, call: { tool: 'connector_spec_put', args: { id: 'odd' } }, orElse: { tool: 'connector_work_report', args: { id: 'odd', outcome: 'blocked', reason: 'because of it' } } }, attention: { kind: 'decision', url: 'https://odd.example' }, evidence: ['a', 'b', 'c', 'd', 'e'] };
    const files: string[] = [];
    const { outcomes } = await runConnectors(fakeClient([r]).client, fakeDriver([]).driver, { ...quick, writeFile: async (_p, t) => { files.push(t); } });
    const req = JSON.parse(files[0]!) as Record<string, unknown>;
    expect(req.task).toBe(task);
    expect(req.call).toEqual({ tool: 'connector_spec_put', args: { id: 'odd' } });
    expect(req.orElse).toMatchObject({ tool: 'connector_work_report' });
    expect(req.attention).toEqual({ kind: 'decision', url: 'https://odd.example' });
    expect(req.evidence).toEqual(['c', 'd', 'e']);
    expect(outcomes[0]!.status).toBe('handoff');
  });
});

describe('planFor', () => {
  it('treats a terminal blocked result as done', () => {
    expect(planFor({ id: 'x', state: 'blocked', stage: 'discover', reason: 'gone', next: { kind: 'none', task: 'nothing' } }, false)).toEqual({ do: 'done', status: 'blocked' });
  });
});

describe('the consent driver reports where it stopped as data', () => {
  it('carries the page, its buttons and a kind on the stop', async () => {
    const { oauthConnect, ConsentStop } = await import('./oauth-consent.js');
    const controls = [{ name: 'Verify you are human', leaf: false }];
    const page = {
      url: () => 'https://api.vendor.example/v1/oauth/authorize?client_id=abc&state=zzz', isClosed: () => false, goto: async () => undefined, waitForTimeout: async () => undefined,
      evaluate: async (_fn: unknown, arg?: unknown) => (arg === undefined ? 'Please complete the captcha to continue' : controls),
      locator: () => ({ count: async () => 0 }),
    } as unknown as import('playwright-core').Page;
    const error = await oauthConnect('vendor', page, { start: async () => ({ url: 'https://api.vendor.example/v1/oauth/authorize?redirect_uri=https%3A%2F%2Fcd.example%2Fcallback', stop: () => undefined }), status: async () => ({ connected: false }), timeoutMs: 20_000 }).then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(ConsentStop);
    expect((error as InstanceType<typeof ConsentStop>).detail).toMatchObject({ kind: 'captcha', url: 'https://api.vendor.example/v1/oauth/authorize', controls: ['Verify you are human'] });
    expect((error as InstanceType<typeof ConsentStop>).detail!.pageText).toContain('captcha');
  });
});

describe('keygrab stops are not re-judged by marketing words', () => {
  it('does not turn a landing-page excerpt into a payment or identity wall', () => {
    const stop = { kind: 'unknown' as const, message: 'no way to sign in', url: 'https://www.shipstation.com/', pageText: 'Start Shipping Now. No credit card required. KYC Remediation is challenging. Pricing', controls: [], trail: ['open shipstation.com/'] };
    expect(humanStepFor('shipengine', stop)).toBeUndefined();
  });
  it('lists the task\'s other addresses for a start page that is no web page', async () => {
    const { otherUrls } = await import('./connector-runner.js');
    expect(otherUrls('get a key at https://tracking.api.here.com (docs https://developer.here.com/docs, sign up https://account.here.com/signup).')).toEqual(['https://developer.here.com/docs', 'https://account.here.com/signup']);
  });
});

describe('warm hand-off and rate-limit back-off', () => {
  const mx = (): OnboardResult => keyAt('musixmatch');
  it('a parked stop hands over the vendor, url, trail, menus, narrow task and the resume command', async () => {
    const c = fakeClient([keyAt('probely')]);
    const d = fakeDriver([{ ok: false, stop: stop({ kind: 'unknown', message: 'no API key page was found', url: 'https://app.snyk.io/org/x', pageText: 'Org overview', controls: ['Settings'], parked: true, vendorUrl: 'https://probely.com', trail: ['click Log in', 'click Continue with Google'], visited: ['https://app.snyk.io/'], menus: ['User menu: Account settings | Sign out'] }) }]);
    const { outcomes } = await runConnectors(c.client, d.driver, quick);
    const o = outcomes[0]!;
    expect(o.status).toBe('handoff');
    expect(o.resume).toContain('clikcode connectors resume probely');
    expect(o.handoff!.request).toMatchObject({ vendorUrl: 'https://probely.com', trail: ['click Log in', 'click Continue with Google'], visited: ['https://app.snyk.io/'], menus: ['User menu: Account settings | Sign out'], url: 'https://app.snyk.io/org/x' });
    expect(o.handoff!.request.narrowTask).toContain('capture_secret');
    expect(o.handoff!.request.resume).toContain('connectors resume probely');
    expect(c.notes[0]!.text).toContain('connectors resume probely');
  });

  it('a captcha starts a 6 hour back-off that is written into the attention item, and the vendor is not retried', async () => {
    const until = new Date('2026-10-25T23:00:00.000Z');
    const recorded: string[] = [];
    const c = fakeClient([mx(), mx()]);
    const d = fakeDriver([{ ok: false, stop: stop({ kind: 'captcha', message: 'a captcha at www.musixmatch.com', url: 'https://www.musixmatch.com/', human: { kind: 'captcha', url: 'https://www.musixmatch.com/', reasonCode: 'captcha', instructions: 'www.musixmatch.com shows a captcha' }, parked: true }) }]);
    let backed: Date | undefined;
    const driver: BrowserDriver = { ...d.driver, recordBackoff: async id => { recorded.push(id); backed = until; return until; }, backoff: async () => backed };
    const first = await runConnectors(c.client, driver, quick);
    expect(first.outcomes[0]).toMatchObject({ status: 'human', backoffUntil: until.toISOString() });
    expect(recorded).toEqual(['musixmatch']);
    expect((c.reports[0] as { humanStep: { instructions: string } }).humanStep.instructions).toContain(`before ${until.toISOString()}`);
    // A later run in the back-off window does not drive the browser at all.
    const c2 = fakeClient([mx()]);
    const second = await runConnectors(c2.client, driver, quick);
    expect(second.outcomes[0]).toMatchObject({ status: 'waiting', backoffUntil: until.toISOString() });
    expect(d.driven).toEqual(['keygrab musixmatch https://musixmatch.example']);
    expect(c2.reports).toEqual([]);
  });

  it('a wall that is not a captcha starts no back-off', async () => {
    let started = false;
    const c = fakeClient([keyAt('appcenter-ms')]);
    const d = fakeDriver([{ ok: false, stop: stop({ kind: 'mfa', message: 'sms', human: { kind: 'sms', instructions: 'a phone verification' } }) }]);
    await runConnectors(c.client, { ...d.driver, recordBackoff: async () => { started = true; return new Date(); } }, quick);
    expect(started).toBe(false);
  });

  it('reports a recipe saved by a captured key', async () => {
    const c = fakeClient([keyAt('newco')], { newco: [published('newco')] });
    const d = fakeDriver([{ ok: true, note: 'captured', recipe: true }]);
    const { outcomes } = await runConnectors(c.client, d.driver, quick);
    expect(outcomes[0]).toMatchObject({ status: 'published', recipe: true });
  });
});
