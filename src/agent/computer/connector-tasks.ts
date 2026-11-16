/** Reading what ClikDeploy asked for: addresses in a task text, the task kinds the runner knows, and `planFor`, the step each one gets. No browser, no network. */
import type { AgentCall, HumanStep, Next, OnboardResult, Plan, StopInfo } from './connector-types.js';
/** Tools the runner may call on ClikDeploy's behalf, because they only advance or read the pipeline. */
export const RUNNABLE_TOOLS: ReadonlySet<string> = new Set(['connector_finish', 'connector_test_job_status', 'connector_proof', 'connector_pipeline_status']);

export const URL_IN_TEXT = /https:\/\/[^\s"'<>)]+/;
export const URLS_IN_TEXT = /https:\/\/[^\s"'<>)]+/g;
/** Every other address the task names (homepage, sign-up, docs), for a start page that is no web page. */
export function otherUrls(task: string): string[] {
  const first = siteUrl(task);
  return [...new Set((task.match(URLS_IN_TEXT) ?? []).map(u => u.replace(/[.,;]+$/, '')).filter(u => u !== first))];
}
export { BACKOFF_HOURS } from './keygrab-park.js';
/** The command that reattaches to the parked hidden tab and carries on. */
export const resumeCommand = (id: string): string => `clikcode connectors resume ${id} [--click '<text>' | --goto <url>]`;
/** What an agent still has to do from the parked page: one narrow job. */
export function narrowTask(id: string, stop: StopInfo): string {
  return `The hidden browser tab for ${id} is still open on ${stop.url || 'its last page'} (signed in where the trail shows it). Reach this vendor's API key page, create a key named ClikDeploy, and capture it unseen with capture_secret (send_to clikdeploy-connection, integration ${id}). Press only what leads to API keys, tokens or developer settings; never delete, cancel, sign out or change billing. Do it with \`${resumeCommand(id)}\` (it reattaches to that tab and continues keygrab).`;
}
export const WALL_STATES = new Set(['needs-human']);
/** The auth probe ended with the key in the wrong place or on the wrong path: deterministic spec work for the gate/enrich tools. */
export const SPEC_FIX = /\bpath[- ]wrong\b|auth probe[^.\n]{0,80}(?:wrong|ended|mismatch|placement|path)|(?:key|token|credential|auth)[^.\n]{0,30}placement|placement[^.\n]{0,30}(?:wrong|mismatch)/i;
export const isSpecFix = (text: string): boolean => SPEC_FIX.test(text);

/** The vendor address in a task: an https address, or a bare domain after "at" or "from". */
export function siteUrl(task: string): string | undefined {
  const full = URL_IN_TEXT.exec(task)?.[0];
  if (full) return full.replace(/[.,;]+$/, '');
  const bare = /\b(?:at|from|on)\s+((?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s,;]*)?)/i.exec(task)?.[1];
  return bare ? `https://${bare}` : undefined;
}

/** For a judgement task (its `call` is a connector_work_report): the report that blocks the item, with its reason ready. Any other task's `orElse` is only a way out, never run. */
export function blockedCall(next: Next): AgentCall | undefined {
  if (next.kind !== 'agent' || next.call?.tool !== 'connector_work_report') return undefined;
  return [next.call, next.orElse].find(c => c?.tool === 'connector_work_report' && c.args.outcome === 'blocked');
}

export function waitMs(task: string, fallback = 5_000): number {
  const m = /(\d+)\s*(?:s\b|sec)/i.exec(task);
  return Math.min(Math.max(m ? Number(m[1]) * 1000 : fallback, 1_000), 60_000);
}

/** Vendors whose developer settings are a cloud console: no agent registers anything there (the 2026-11-14 root-key incident). */
export const CLOUD_VENDOR = /^(?:aws|amazon|amazonaws|google|googleapis|gcp|azure|microsoft-azure|oracle-cloud|oci|ibm-cloud|digitalocean|linode|vultr|hetzner|ovh|scaleway|akamai)(?:-|$)/i;

/** What the agent is told when the step is "register an OAuth app": the server's own instruction (it names the redirect address and fields) and the task. */
export function oauthAppTask(id: string, step: HumanStep, task: string): string {
  return [`Register the platform's OAuth app at the vendor for connector "${id}".`, step.instructions ? `What ClikDeploy asks for: ${step.instructions}` : '', step.prefill?.length ? `Values to use: ${step.prefill.join(' | ')}` : '', step.url ? `Where: ${step.url}` : '', task && task !== step.instructions ? `Task as given: ${task}` : ''].filter(Boolean).join('\n').slice(0, 1800);
}

/** A task that says the vendor has no machine-readable reference yet: its homepage and the documentation pages it names. */
export function referenceTask(task: string): { homepage: string; docs: string[] } | undefined {
  const named = /(?:^|\n)\s*(?:docs-to-spec|find-reference):[^(\n]{0,160}\((https:\/\/[^)\s]+)\)/i.exec(task);
  // The driver's own wording for the same thing: "write the spec from <the vendor's site>".
  const written = named ? undefined : /(?:^|\n)\s*write the spec from (https:\/\/[^\s,]+?)[.,]?(?:\s|$)/i.exec(task);
  const homepage = named?.[1] ?? written?.[1];
  if (!homepage) return undefined;
  const after = /inspected:\s*([^\n]*?)(?:\.\s+Read the docs|$)/i.exec(task)?.[1] ?? '';
  return { homepage, docs: (after.match(/https:\/\/[^\s,]+/g) ?? []).map(url => url.replace(/[.,]+$/, '')).slice(0, 4) };
}

/** The agent's task when the browser found no description file: write one from the documentation, or say plainly that there is no API. */
export function docsToSpecPrompt(id: string, homepage: string, docs: readonly string[]): string {
  return `docs-to-spec: ${id} (${homepage}) has no machine-readable API reference: a browser search of its site found none. `
    + (docs.length ? `These pages read like its API documentation: ${docs.join(' , ')}. ` : 'No page that reads like API documentation was found either: look for its developer or API pages yourself (the site footer, a help centre, a separate docs or developers address). ')
    + `Read the documentation and write an OpenAPI 3 document of the REST endpoints it documents (do not invent any), then store it with connector_task tool=connector_build_apply {id: "${id}", document, sourceUrl}. `
    + 'If the vendor documents no API at all, or only one given out by its sales team, end with RESULT: wall no-api (or sales) and one sentence of evidence.';
}

/** How long ClikDeploy's own running work (a test job, a build) is waited out in one vendor run. */
export const WAIT_LIMIT_MS = 180_000;

/** What to do about the task ClikDeploy returned. `recipe` says whether a saved recipe exists for it. */
export function planFor(result: OnboardResult, recipe: boolean): Plan {
  const next = result.next;
  if (result.state === 'published' || result.state === 'complete') return { do: 'done', status: 'published' };
  if (result.state === 'attention') {
    // One parked step is an agent's to try before it is a person's: registering the platform's OAuth app at the vendor.
    const parked = result.attention as { kind?: string; url?: string; instruction?: string; reasonCode?: string } | null | undefined;
    if (parked?.kind === 'vendor-contact' && !/access requested|no access form/i.test(parked.instruction ?? '')) return { do: 'human', humanStep: { kind: 'vendor-contact', reasonCode: parked.reasonCode || 'sales', ...(parked.url ? { url: parked.url } : {}), ...(parked.instruction ? { instructions: parked.instruction } : {}) } };
    if (parked?.kind === 'app-registration') return { do: 'human', humanStep: { kind: 'app-registration', reasonCode: parked.reasonCode || 'oauth-app', ...(parked.url ? { url: parked.url } : {}), ...(parked.instruction ? { instructions: parked.instruction } : {}) } };
    return { do: 'done', status: 'blocked' };
  }
  if (!next || next.kind === 'none') return result.state === 'blocked' ? { do: 'done', status: 'blocked' } : { do: 'handoff', why: 'onboarding supplied no next step without confirming completion' };
  if (next.kind === 'agent' && (isSpecFix(next.task) || isSpecFix(result.reason))) return { do: 'specfix', why: 'the auth probe ended path-wrong or in the wrong place: a spec fix', ...(blockedCall(next) ? { call: blockedCall(next)! } : {}) };
  if (next.kind === 'call') return { do: 'wait', ms: waitMs(next.task) };
  if (next.kind === 'human') return { do: 'human', humanStep: { ...next.humanStep, reasonCode: next.humanStep.reasonCode || next.humanStep.kind } };
  if (WALL_STATES.has(result.state)) return { do: 'handoff', why: 'ClikDeploy says a person is needed but gave no step' };
  const call = next.call;
  if (call?.tool === 'oauth_connect') return { do: 'oauth' };
  // A judgement task whose answer is a report the task already spells out: the runner makes the blocked report itself.
  const blocked = blockedCall(next);
  if (blocked) return { do: 'report', call: blocked };
  if (call && RUNNABLE_TOOLS.has(call.tool)) return { do: 'tool', call };
  if (call) return { do: 'handoff', why: `the task is the ${call.tool} call, which needs judgement` };
  if (/\boauth_connect\b|computer oauth-connect/i.test(next.task)) return { do: 'oauth' };
  const url = siteUrl(next.task);
  const wantsKey = /\b(api key|capture_secret|credential|key|token)\b/i.test(next.task);
  if (wantsKey && recipe) return { do: 'capture', ...(url ? { url } : {}) };
  // No saved recipe fits: the generic policy takes a task that asks for a key and names the site.
  if (wantsKey && /\b(get|capture|create)\b[^\n]{0,40}\b(key|token|secret|credential)|capture_secret/i.test(next.task)) {
    return url ? { do: 'capture', url, generic: true, alternates: otherUrls(next.task) } : { do: 'handoff', why: 'a key is wanted but the task names no site address' };
  }
  return { do: 'handoff', why: 'the task is not one of the known kinds' };
}


