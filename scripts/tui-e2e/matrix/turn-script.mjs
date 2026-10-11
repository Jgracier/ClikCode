#!/usr/bin/env node
/* The one scripted turn the matrix rig plays through every harness, derived
 * from what the catalog DECLARES that harness supplies (`capabilities`) and
 * what its wire family can carry at all.
 *
 *   text, [thought], one tool, two parallel tools (B ends first),
 *   [agent + two children], [plan], [usage], closing text
 *
 * Ops are fake-grok's `emits` vocabulary (scripts/tui-e2e/fake-grok.mjs), so
 * the ACP harnesses play them as they are; the other families translate them
 * (cli-families.mjs, codex-server.mjs). Every piece of text a screen check
 * looks for is a unique marker word (MARK), so emission order, paint time and
 * "shown once" are all decided by string search, never by wording.
 *
 * As a program: `turn-script.mjs <dist/harness-catalog.cjs> <command>` prints
 * {ops, expect} for that harness as JSON (matrix.py reads it). */
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

export const MARK = {
  text1: 'mkrTextOne', head: 'mkrThinkHead', think: 'mkrThinkBody',
  solo: 'mkrSoloCmd', soloOut: 'mkrSoloOut',
  parA: 'mkrParallelA', parB: 'mkrParallelB', outA: 'mkrOutA', outB: 'mkrOutB',
  agent: 'mkrAgentRow', child1: 'mkrChildOne', child2: 'mkrChildTwo',
  plan1: 'mkrPlanOne', plan2: 'mkrPlanTwo', final: 'mkrFinalText',
};

/** What a wire family can carry at all, whatever the catalog declares for the
 * vendor. `tools`: tool-call rows; `text`: live prose; `doc`: one JSON
 * document at the end (OpenClaw), so only the closing text. */
export function familyAbility(harness) {
  const transport = harness.transport;
  if (transport === 'acp' || transport === 'codex-app-server') return { tools: true, live: true };
  if (transport === 'text-cli') return { tools: false, live: true };
  if (harness.turn?.output === 'json') return { tools: false, live: false };
  return { tools: true, live: true };
}

/** The ops and what the screen must show of them. */
export function buildTurn(harness) {
  const caps = harness.capabilities ?? {};
  const ability = familyAbility(harness);
  const ops = [];
  const expect = []; // {marker, kind, persists, group}, in emission order
  const see = (marker, kind, persists = true, extra = {}) => expect.push({ marker, kind, persists, ...extra });
  // A one-document harness (OpenClaw `agent --json`) writes ONE reply at the end: only the closing text
  // can ever be on screen, so the opening text is not expected of it (it is still scripted, and the
  // fake keeps only the last, as the vendor does).
  const text = (value, marker, expected = true) => { ops.push({ op: 'text', text: value }); if (expected) see(marker, 'text'); };
  text(`Starting the work ${MARK.text1} now.`, MARK.text1, ability.live);
  if (caps.thinking && ability.live) {
    ops.push({ op: 'thought', heading: MARK.head, text: `Weighing the options ${MARK.think} carefully.`, ms: 20 });
    see(MARK.head, 'thought', true);
  }
  if (ability.tools) {
    const out = (marker) => (caps.toolOutput ? { result: `printed ${marker}` } : { result: 'ok' });
    ops.push({ op: 'tool-start', id: 'solo1', title: `echo ${MARK.solo}` }, { op: 'sleep', ms: 200 },
      { op: 'tool-end', id: 'solo1', ...out(MARK.soloOut) });
    see(MARK.solo, 'tool');
    if (caps.toolOutput) see(MARK.soloOut, 'output', true, { after: MARK.solo });
    ops.push({ op: 'tool-start', id: 'parA', title: `echo ${MARK.parA}` }, { op: 'tool-start', id: 'parB', title: `echo ${MARK.parB}` },
      { op: 'sleep', ms: 150 }, { op: 'tool-end', id: 'parB', ...out(MARK.outB) }, { op: 'sleep', ms: 100 }, { op: 'tool-end', id: 'parA', ...out(MARK.outA) });
    see(MARK.parA, 'tool', true, { group: 'parallel' });
    see(MARK.parB, 'tool', true, { group: 'parallel' });
    if (caps.toolOutput) { see(MARK.outB, 'output', true, { after: MARK.parB }); see(MARK.outA, 'output', true, { after: MARK.parA }); }
    if (caps.childActivity) {
      ops.push({ op: 'agent-start', id: 'ag1', title: `Task: ${MARK.agent}`, description: MARK.agent },
        { op: 'child-start', id: 'ch1', parent: 'ag1', title: `Read ${MARK.child1}.ts` },
        { op: 'child-start', id: 'ch2', parent: 'ag1', title: `Read ${MARK.child2}.ts` },
        { op: 'sleep', ms: 150 },
        { op: 'child-end', id: 'ch1', parent: 'ag1', result: 'ok' },
        { op: 'child-end', id: 'ch2', parent: 'ag1', result: 'ok' },
        { op: 'agent-end', id: 'ag1', result: 'explored' });
      see(MARK.agent, 'agent');
      see(MARK.child1, 'child', false, { parent: MARK.agent });
      see(MARK.child2, 'child', false, { parent: MARK.agent });
    }
  }
  if (caps.plan && ability.live) {
    // One plan, updated in place: first step done, then both.
    ops.push({ op: 'plan', entries: [{ content: `Do ${MARK.plan1}`, status: 'completed' }, { content: `Then ${MARK.plan2}`, status: 'in_progress' }] },
      { op: 'sleep', ms: 120 },
      { op: 'plan', entries: [{ content: `Do ${MARK.plan1}`, status: 'completed' }, { content: `Then ${MARK.plan2}`, status: 'completed' }] });
    see(MARK.plan1, 'plan', true);
    see(MARK.plan2, 'plan', true);
  }
  if (caps.usage) ops.push({ op: 'usage', used: 4321, size: 200000, input: 4000, output: 321 });
  ops.push({ op: 'sleep', ms: 100 });
  text(`Finished ${MARK.final} cleanly.`, MARK.final);
  return { ops, expect, ability, capabilities: { childActivity: false, thinking: false, plan: false, usage: false, toolOutput: false, ...caps } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , catalogPath, command] = process.argv;
  const harness = createRequire(import.meta.url)(resolve(catalogPath)).AI_LOCAL_HARNESSES.find((item) => item.command === command);
  if (!harness) { console.error(`no harness ${command}`); process.exit(2); }
  console.log(JSON.stringify(buildTurn(harness)));
}
