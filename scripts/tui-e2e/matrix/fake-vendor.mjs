#!/usr/bin/env node
/* One fake vendor executable for the whole catalog. It is installed on PATH
 * (a symlink) under each harness's real binary name -- `binary`, and the
 * separate `acp.binary` where the catalog names one -- and takes its behaviour
 * from that harness's catalog entry (FAKE_CATALOG = the build's
 * dist/harness-catalog.cjs): which transport ClikCode will speak, the parser
 * family, the ACP launch argv, the modes/models/effort options.
 *
 *   ACP        the shared ACP agent of scripts/tui-e2e/fake-grok.mjs, shaped by
 *              FAKE_ACP_PROFILE built here from the catalog entry
 *   codex      the app-server JSON-RPC of codex-server.mjs
 *   structured json-lines of the entry's parser family (cli-families.mjs)
 *   text       plain lines
 *
 * Every invocation appends to FAKE_EMIT_LOG (JSONL, Date.now() ms):
 *   start  the process began (`execAt` is its exec time, from process.uptime)
 *   recv   the prompt arrived (session/prompt, turn/start, argv, stdin)
 *   update / emit  each event, at the moment it is written to the pipe
 * so matrix.py can subtract the vendor's own time from what ClikCode adds. */
import { appendFileSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildTurn } from './turn-script.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const execAt = Math.round(Date.now() - process.uptime() * 1000);
const name = basename(process.argv[1]);
const argv = process.argv.slice(2);
const logFile = process.env.FAKE_EMIT_LOG;
export const log = (record) => { if (logFile) appendFileSync(logFile, `${JSON.stringify({ t: Date.now(), pid: process.pid, ...record })}\n`); };
log({ ev: 'start', name, argv, execAt });

const catalog = createRequire(import.meta.url)(process.env.FAKE_CATALOG).AI_LOCAL_HARNESSES;
const harness = catalog.find((item) => item.binary === name) ?? catalog.find((item) => item.acp?.binary === name);
if (!harness) { console.error(`fake vendor: no catalog harness has binary ${name}`); process.exit(127); }

const same = (left, right) => Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((part, index) => part === right[index]);
const hasRun = (haystack, needle) => needle.length > 0 && haystack.some((_, at) => needle.every((part, index) => haystack[at + index] === part));

// ---- Everything that is not a turn: version, status, models, logout -------
const versionArgv = harness.versionArgv ?? ['--version'];
if (same(argv, versionArgv) || argv.includes('--version')) { console.log(`${harness.command} 9.9.9 (fake)`); process.exit(0); }
if (harness.statusArgv && same(argv, harness.statusArgv)) {
  console.log(JSON.stringify({ loggedIn: true, isAuthenticated: true, status: 'signed in' }));
  process.exit(0);
}
if (harness.logoutArgv && same(argv, harness.logoutArgv)) process.exit(0);

const turn = buildTurn(harness);
const models = [harness.defaultModel ?? 'fake-model-1', 'fake-model-2'].filter((id, at, all) => all.indexOf(id) === at);
if (harness.modelDiscoveryArgv && same(argv, harness.modelDiscoveryArgv)) { console.log(models.join('\n')); process.exit(0); }
if (argv.includes('--help')) { console.log(`Usage: ${harness.command} [options]\n  --reasoning-effort <EFFORT>  Reasoning effort`); process.exit(0); }

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const wordMs = Number(process.env.FAKE_DELAY_MS ?? 25);

// ---- ACP -------------------------------------------------------------------
const acp = harness.acp;
const isAcp = acp && (name === acp.binary || (acp.argv.length > 0 && hasRun(argv, [...acp.argv]))
  || (!acp.binary && acp.argv.length === 0));
if (harness.transport === 'acp' && isAcp) {
  const efforts = harness.effortValues ?? ['low', 'medium', 'high'];
  const select = (id, category, values, current, extra = {}) => ({
    id, name: id, category, type: 'select', currentValue: current, options: values.map((value) => ({ value, name: value })), ...extra,
  });
  // Goose, Devin, OpenCode, Kilo, Qwen and Cline publish modes as a config
  // option (acp-client.ts); the rest as a `modes` object.
  const modesAsOption = ['goose', 'devin', 'opencode', 'kilo', 'qwen', 'cline'].includes(harness.command);
  const modeIds = [...new Set(Object.values(acp.permissionModeIds ?? {}))];
  const profile = {
    models: modesAsOption ? null : { currentModelId: models[0], availableModels: models.map((id) => ({ modelId: id, name: id })) },
    configOptions: [
      ...(modesAsOption || acp.effortConfigId || acp.providerConfigId ? [] : []),
      ...(modesAsOption ? [select('model', 'model', models, models[0])] : []),
      ...(modesAsOption && modeIds.length ? [select('mode', 'mode', modeIds, modeIds[0])] : []),
      ...(acp.effortConfigId ? [select(acp.effortConfigId, 'thought_level', efforts, efforts.includes('medium') ? 'medium' : efforts[0])] : []),
    ],
    ...(!modesAsOption && modeIds.length ? { modes: { currentModeId: modeIds[0], availableModes: modeIds.map((id) => ({ id, name: id })) } } : {}),
    parentShape: { qwen: 'qwen', cursor: 'cursor' }[harness.command] ?? 'claude',
    ...(harness.capabilities?.usage ? { promptUsage: { inputTokens: 4000, outputTokens: 321 } } : {}),
    ...(process.env.FAKE_PROMPT ? { promptMatch: process.env.FAKE_PROMPT } : {}),
  };
  if (!profile.configOptions.length) delete profile.configOptions;
  process.env.FAKE_ACP_PROFILE = JSON.stringify(profile);
  process.env.FAKE_TURNS = JSON.stringify([{ emits: turn.ops }]);
  process.env.FAKE_DELAY_MS = String(wordMs);
  // fake-grok speaks ACP when started as `agent stdio`.
  process.argv = [process.argv[0], join(here, '..', 'fake-grok.mjs'), 'agent', 'stdio'];
  await import('../fake-grok.mjs');
} else if (harness.transport === 'codex-app-server' && argv[0] === 'app-server') {
  const { serveCodex } = await import('./codex-server.mjs');
  await serveCodex({ turn, log, sleep, wordMs, promptMatch: process.env.FAKE_PROMPT });
} else {
  const { runCli } = await import('./cli-families.mjs');
  await runCli({ harness, turn, argv, log, sleep, wordMs, promptMatch: process.env.FAKE_PROMPT });
}
