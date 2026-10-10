#!/usr/bin/env node
/** Head-to-head harness benchmark: ClikCode's own agent (on ClikDeploy
 * Gateway) against Claude Code, same model, same tasks, same prompt.
 *
 *   node bench/harness/run.mjs [--tasks 01,05] [--harnesses clikcode,claude]
 *       [--model claude-sonnet-5-5] [--timeout-min 10]
 *       [--claude-credentials <path to a .credentials.json>]
 *   node bench/harness/run.mjs --self-check
 *
 * Each task × harness gets a fresh copy of tasks/<task>/template under
 * /var/tmp (a git repo with one commit), runs the harness there through
 * scripts/vendor-sandbox.mjs (so nothing lands in the real home), then runs
 * tasks/<task>/verify.mjs in it. Results go to results/<date>.json and .md;
 * each run's work copy and transcripts stay in the printed /var/tmp folder.
 *
 * --self-check proves every verify script: the bare template must fail, and
 * the template with solution/ laid over it (plus solution/solve.mjs, when
 * there is one) must pass. Needs no harness and spends nothing.
 *
 * Needs a build (`node scripts/build.mjs`): ClikCode runs from dist/. */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const tasksDir = join(here, 'tasks');

const args = parseArgs(process.argv.slice(2));
const allTasks = readdirSync(tasksDir).filter((name) => existsSync(join(tasksDir, name, 'verify.mjs'))).sort();
const tasks = args.tasks ? allTasks.filter((name) => args.tasks.split(',').some((prefix) => name.startsWith(prefix))) : allTasks;

if (args['self-check']) process.exit(selfCheck(tasks) ? 0 : 1);

const harnesses = (args.harnesses ?? 'clikcode,claude').split(',');
const model = args.model ?? 'claude-sonnet-5-5';
const timeoutMs = Number(args['timeout-min'] ?? 10) * 60_000;
const claudeCredentials = args['claude-credentials'] ?? process.env.BENCH_CLAUDE_CREDENTIALS
  ?? join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), '.credentials.json');
/** List price per million tokens, for a cost estimate where a harness reports none. */
const PRICES = { 'claude-sonnet-5-5': { input: 2, cacheRead: 0.2, output: 10 }, 'claude-opus-5-5': { input: 4, cacheRead: 0.4, output: 20 } };

if (!existsSync(join(root, 'dist', 'index.js'))) throw new Error('no build: run `node scripts/build.mjs` first');
let started = new Date();
const results = [];
// --recompute <results.json>: the metrics again from the runs' kept artifacts
// (after the runner learned a new one), written back over the same files.
if (args.recompute) {
  const saved = JSON.parse(readFileSync(args.recompute, 'utf8'));
  started = new Date(saved.startedAt);
  for (const result of saved.results) {
    const artifacts = join(result.dir, 'artifacts');
    results.push({ ...result, ...(existsSync(artifacts) ? (result.harness === 'clikcode' ? clikcodeMetrics(artifacts) : claudeMetrics(artifacts)) : {}) });
  }
  writeResults(results, args.recompute.replace(/\.json$/, ''));
  process.exit(0);
}
for (const task of tasks) {
  for (const harness of harnesses) {
    console.error(`== ${task} on ${harness}`);
    const result = await runOne(task, harness);
    results.push(result);
    console.error(`   ${result.success ? 'PASS' : 'FAIL'} in ${(result.wallMs / 1000).toFixed(1)}s ${result.note ?? ''}\n   ${result.dir}`);
  }
}
writeResults(results);

// ---------------------------------------------------------------------------

function parseArgs(list) {
  const out = {};
  for (let index = 0; index < list.length; index += 1) {
    const name = list[index].replace(/^--/, '');
    if (list[index + 1] && !list[index + 1].startsWith('--')) out[name] = list[++index];
    else out[name] = true;
  }
  return out;
}

/** A fresh git-tracked copy of the template in its own /var/tmp folder. */
function prepare(task, label) {
  const dir = mkdtempSync(`/var/tmp/hb-${task}-${label}-`);
  const work = join(dir, 'work');
  cpSync(join(tasksDir, task, 'template'), work, { recursive: true });
  const git = (...rest) => execFileSync('git', ['-c', 'user.name=bench', '-c', 'user.email=bench@example.invalid', ...rest], { cwd: work, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-qm', 'task template');
  return { dir, work };
}

function verify(task, work) {
  const result = spawnSync('node', [join(tasksDir, task, 'verify.mjs')], { cwd: work, encoding: 'utf8', timeout: 180_000 });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  return { pass: result.status === 0, output };
}

function selfCheck(list) {
  let ok = true;
  for (const task of list) {
    const bare = prepare(task, 'selfcheck');
    const before = verify(task, bare.work);
    const solved = prepare(task, 'selfcheck');
    const solution = join(tasksDir, task, 'solution');
    for (const name of readdirSync(solution)) if (name !== 'solve.mjs') cpSync(join(solution, name), join(solved.work, name), { recursive: true });
    if (existsSync(join(solution, 'solve.mjs'))) execFileSync('node', [join(solution, 'solve.mjs')], { cwd: solved.work, stdio: 'inherit' });
    const after = verify(task, solved.work);
    const good = !before.pass && after.pass;
    ok &&= good;
    console.log(`${good ? 'ok  ' : 'BAD '} ${task}: template ${before.pass ? 'PASSES (should fail)' : 'fails'}; solution ${after.pass ? 'passes' : `FAILS: ${after.output}`}`);
    if (good) for (const dir of [bare.dir, solved.dir]) rmSync(dir, { recursive: true, force: true });
  }
  return ok;
}

/** The bash wrapper that runs inside the sandbox: the harness, then a copy
 * of its transcripts out of the sandbox home before the sandbox deletes it. */
function wrapper(harness) {
  const lines = ['#!/bin/bash', 'cd "$BENCH_WORK" || exit 90'];
  if (harness === 'claude') {
    lines.push('mkdir -p "$HOME/.claude" && ln -s "$BENCH_CLAUDE_CREDENTIALS" "$HOME/.claude/.credentials.json"');
  }
  lines.push('"$@" > "$BENCH_ARTIFACTS/stdout.json" 2> "$BENCH_ARTIFACTS/stderr.txt"', 'rc=$?');
  if (harness === 'clikcode') {
    // Not secrets.json: the gateway key lives there.
    lines.push('mkdir -p "$BENCH_ARTIFACTS/home"', 'for name in sessions logs turn-changes invocations.jsonl; do [ -e "$HOME/.clikcode/$name" ] && cp -r "$HOME/.clikcode/$name" "$BENCH_ARTIFACTS/home/"; done');
  } else {
    lines.push('[ -d "$HOME/.claude/projects" ] && cp -r "$HOME/.claude/projects" "$BENCH_ARTIFACTS/claude-projects"');
  }
  lines.push('exit $rc');
  return `${lines.join('\n')}\n`;
}

function command(harness, prompt) {
  if (harness === 'clikcode') {
    return ['--link', '.config/clikcode/auth.json', '--', 'bash', 'WRAP', 'node', join(root, 'dist', 'index.js'), 'send', '--harness', 'gateway', '--model', model, '--permissions', 'bypass', prompt];
  }
  if (harness === 'claude') {
    return ['--', 'bash', 'WRAP', 'claude', '-p', '--model', model, '--permission-mode', 'bypassPermissions', '--output-format', 'json', prompt];
  }
  throw new Error(`unknown harness ${harness}`);
}

/** Why this harness cannot run now, if it cannot. */
function unavailable(harness) {
  if (harness !== 'claude') return null;
  try {
    const expiresAt = JSON.parse(readFileSync(claudeCredentials, 'utf8')).claudeAiOauth?.expiresAt;
    // A refresh inside the sandbox would spend the refresh token the real
    // sign-in still holds; only run on a token that outlives the run.
    if (expiresAt && expiresAt < Date.now() + timeoutMs + 5 * 60_000) return `Claude sign-in token expires at ${new Date(expiresAt).toISOString()}, before this run could finish`;
  } catch (error) {
    return `no Claude sign-in at ${claudeCredentials}: ${error.message}`;
  }
  return null;
}

async function runOne(task, harness) {
  const prompt = readFileSync(join(tasksDir, task, 'prompt.md'), 'utf8').trim();
  const { dir, work } = prepare(task, harness);
  const artifacts = join(dir, 'artifacts');
  const tmp = join(dir, 'tmp');
  mkdirSync(artifacts, { recursive: true });
  mkdirSync(tmp, { recursive: true });
  const base = { task, harness, model, dir, prompt };
  const skip = unavailable(harness);
  if (skip) return { ...base, success: false, skipped: true, note: skip, wallMs: 0 };

  const wrap = join(dir, 'wrap.sh');
  writeFileSync(wrap, wrapper(harness));
  const runId = `${task}-${harness}-${Date.now()}`;
  const argv = command(harness, prompt).map((part) => (part === 'WRAP' ? wrap : part));
  const startedAt = Date.now();
  const child = spawn('node', [join(root, 'scripts', 'vendor-sandbox.mjs'), ...argv], {
    cwd: work,
    detached: true,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, TMPDIR: tmp, BENCH_WORK: work, BENCH_ARTIFACTS: artifacts, BENCH_CLAUDE_CREDENTIALS: claudeCredentials, BENCH_RUN_ID: runId },
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 5000).unref();
  }, timeoutMs);
  const exitCode = await new Promise((done) => child.on('exit', (code, signal) => done(code ?? signal)));
  clearTimeout(timer);
  const wallMs = Date.now() - startedAt;
  if (timedOut) salvage(tmp, artifacts, harness);

  const checked = verify(task, work);
  const leftovers = killLeftovers(runId, work);
  const diff = spawnSync('git', ['diff', '--stat', 'HEAD'], { cwd: work, encoding: 'utf8' }).stdout.trim();
  spawnSync('git', ['add', '-A'], { cwd: work });
  writeFileSync(join(artifacts, 'final.diff'), spawnSync('git', ['diff', '--cached', 'HEAD'], { cwd: work, encoding: 'utf8' }).stdout);
  rmSync(tmp, { recursive: true, force: true });
  const metrics = harness === 'clikcode' ? clikcodeMetrics(artifacts) : claudeMetrics(artifacts);
  return {
    ...base,
    success: checked.pass,
    verify: checked.output.split('\n').slice(0, 15).join('\n'),
    exitCode,
    timedOut,
    wallMs,
    leftovers,
    diffStat: diff.split('\n').at(-1) ?? '',
    ...metrics,
  };
}

/** A timed-out sandbox never reached its own copy step. */
function salvage(tmp, artifacts, harness) {
  for (const name of readdirSync(tmp).filter((entry) => entry.startsWith('vendor-sandbox-'))) {
    const home = join(tmp, name, 'home');
    const from = harness === 'clikcode' ? join(home, '.clikcode', 'sessions') : join(home, '.claude', 'projects');
    if (existsSync(from)) cpSync(from, join(artifacts, harness === 'clikcode' ? 'home/sessions' : 'claude-projects'), { recursive: true });
    const log = join(home, '.clikcode', 'logs');
    if (existsSync(log)) cpSync(log, join(artifacts, 'home', 'logs'), { recursive: true });
  }
}

/** Every process the run left behind (a worker, a server the agent started):
 * recorded, then killed. Found by the run id in its environment or a cwd in
 * the work copy. */
function killLeftovers(runId, work) {
  const found = [];
  for (const pid of readdirSync('/proc').filter((name) => /^\d+$/.test(name))) {
    if (Number(pid) === process.pid) continue;
    try {
      const environ = readFileSync(`/proc/${pid}/environ`, 'utf8');
      const cwd = readlinkSync(`/proc/${pid}/cwd`);
      if (!environ.includes(`BENCH_RUN_ID=${runId}\0`) && !cwd.startsWith(work)) continue;
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ').trim().slice(0, 160);
      found.push(cmdline);
      process.kill(Number(pid), 'SIGKILL');
    } catch {}
  }
  return found;
}

function readJsonLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter((line) => line.trim().startsWith('{')).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function clikcodeMetrics(artifacts) {
  const records = readJsonLines(join(artifacts, 'stdout.json'));
  const out = records.findLast((record) => record.session) ?? records.at(-1) ?? {};
  const stderr = existsSync(join(artifacts, 'stderr.txt')) ? readFileSync(join(artifacts, 'stderr.txt'), 'utf8').trim() : '';
  let session = out.session;
  if (!session) {
    const sessions = join(artifacts, 'home', 'sessions');
    const file = existsSync(sessions) ? readdirSync(sessions).find((name) => name.endsWith('.json')) : undefined;
    if (file) session = JSON.parse(readFileSync(join(sessions, file), 'utf8'));
  }
  const replies = (session?.messages ?? []).filter((message) => message.role === 'assistant');
  const tools = replies.flatMap((message) => (message.activities ?? []).map((activity) => activity.event).filter((event) => event?.kind?.startsWith('tool')));
  const usage = out.usage ?? session?.lastUsage ?? {};
  const price = PRICES[model];
  const cost = price && usage.input !== undefined
    ? ((usage.input - (usage.cacheRead ?? 0)) * price.input + (usage.cacheRead ?? 0) * price.cacheRead + (usage.output ?? 0) * price.output) / 1e6
    : null;
  return {
    ...clikcodeSteps(artifacts),
    reply: (out.text ?? replies.at(-1)?.content ?? '').slice(0, 600),
    error: out.error ?? (stderr ? stderr.slice(0, 600) : undefined),
    inputTokens: usage.input ?? null,
    cacheReadTokens: usage.cacheRead ?? null,
    outputTokens: usage.output ?? null,
    costUsd: cost,
    costSource: 'estimate (list price)',
    turns: null,
    toolCalls: tools.length,
    toolFailures: tools.filter((event) => event.kind === 'tool-failed' || event.error || event.status === 'failed').length,
    tools: tools.map((event) => `${event.category ?? '?'}: ${event.label ?? ''}`.slice(0, 140)),
    harnessMs: out.invocation?.latencyMs ?? null,
  };
}

/** Model steps from the agent's own conversation log: a step runs from the
 * last user item or tool result to its first assistant item. `setupMs` is the
 * worker's turn start to the prompt being recorded (before the first step). */
function clikcodeSteps(artifacts) {
  const sessions = join(artifacts, 'home', 'sessions');
  const dir = existsSync(sessions) ? readdirSync(sessions).find((name) => !name.endsWith('.json')) : undefined;
  const items = dir ? readJsonLines(join(sessions, dir, 'harness.jsonl')).filter((line) => line.kind === 'item') : [];
  const steps = [];
  let from;
  let inStep = false;
  for (const line of items) {
    const at = Date.parse(line.at);
    if (line.item.role === 'assistant' || line.item.type === 'tool_call') {
      if (!inStep && from !== undefined) steps.push(at - from);
      inStep = true;
    } else {
      inStep = false;
      from = at;
    }
  }
  const started = readJsonLines(join(artifacts, 'home', 'logs', 'lifecycle.log')).find((line) => line.event === 'worker.turn.start');
  const setupMs = started && items.length ? Date.parse(items[0].at) - Date.parse(started.t) : null;
  return { modelCalls: steps.length || null, modelMs: steps.reduce((sum, ms) => sum + ms, 0) || null, stepMs: steps, setupMs };
}

/** The same from Claude Code's transcript: one step per assistant message id. */
function claudeSteps(records) {
  const lines = records.filter((record) => record.timestamp && (record.type === 'user' || record.type === 'assistant'))
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const steps = new Map();
  let from;
  for (const line of lines) {
    const at = Date.parse(line.timestamp);
    if (line.type === 'user') { from = at; continue; }
    const id = line.message?.id;
    if (!steps.has(id)) steps.set(id, { from, to: at });
    else steps.get(id).to = at;
  }
  const stepMs = [...steps.values()].filter((step) => step.from !== undefined).map((step) => step.to - step.from);
  return { modelCalls: stepMs.length || null, modelMs: stepMs.reduce((sum, ms) => sum + ms, 0) || null, stepMs };
}

function claudeMetrics(artifacts) {
  const out = readJsonLines(join(artifacts, 'stdout.json')).at(-1) ?? {};
  const projects = join(artifacts, 'claude-projects');
  const tools = [];
  const records = [];
  const stack = existsSync(projects) ? [projects] : [];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.name.endsWith('.jsonl')) {
        for (const record of readJsonLines(path)) {
          records.push(record);
          for (const block of record.message?.content ?? []) {
            if (block?.type === 'tool_use') tools.push(`${block.name}: ${JSON.stringify(block.input).slice(0, 120)}`);
            if (block?.type === 'tool_result' && block.is_error) tools.push(`  ! error: ${JSON.stringify(block.content).slice(0, 120)}`);
          }
        }
      }
    }
  }
  const usage = out.usage ?? {};
  return {
    ...claudeSteps(records),
    reply: String(out.result ?? '').slice(0, 600),
    error: out.is_error ? String(out.result ?? 'error') : undefined,
    inputTokens: usage.input_tokens === undefined ? null : usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
    cacheReadTokens: usage.cache_read_input_tokens ?? null,
    outputTokens: usage.output_tokens ?? null,
    costUsd: out.total_cost_usd ?? null,
    costSource: 'reported',
    turns: out.num_turns ?? null,
    toolCalls: tools.filter((line) => !line.startsWith('  !')).length,
    toolFailures: tools.filter((line) => line.startsWith('  !')).length,
    tools,
    permissionDenials: out.permission_denials?.length ?? 0,
    harnessMs: out.duration_ms ?? null,
  };
}

function writeResults(list, fixedStem) {
  const resultsDir = join(here, 'results');
  mkdirSync(resultsDir, { recursive: true });
  const day = started.toISOString().slice(0, 10);
  let stem = fixedStem ?? join(resultsDir, day);
  if (!fixedStem && existsSync(`${stem}.md`)) stem += `-${started.toISOString().slice(11, 16).replace(':', '')}`;
  writeFileSync(`${stem}.json`, `${JSON.stringify({ startedAt: started.toISOString(), model, timeoutMs, results: list }, null, 2)}\n`);
  const fmt = (n) => (n === null || n === undefined ? '–' : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const rows = list.map((r) => `| ${r.task} | ${r.harness} | ${r.skipped ? 'skipped' : r.success ? 'PASS' : r.timedOut ? 'TIMEOUT' : 'FAIL'} | ${(r.wallMs / 1000).toFixed(1)} | ${fmt(r.inputTokens)} | ${fmt(r.cacheReadTokens)} | ${fmt(r.outputTokens)} | ${r.costUsd === null || r.costUsd === undefined ? '–' : `$${r.costUsd.toFixed(3)}${r.costSource === 'reported' ? '' : '*'}`} | ${r.modelCalls ?? '–'} | ${r.modelMs ? (r.modelMs / 1000).toFixed(1) : '–'} | ${r.toolCalls ?? '–'} | ${r.leftovers?.length ?? 0} |`);
  const total = (harness, key) => list.filter((r) => r.harness === harness).reduce((sum, r) => sum + (r[key] ?? 0), 0);
  const summary = [...new Set(list.map((r) => r.harness))].map((harness) => {
    const mine = list.filter((r) => r.harness === harness);
    return `| ${harness} | ${mine.filter((r) => r.success).length}/${mine.length} | ${(total(harness, 'wallMs') / 1000).toFixed(0)} | ${fmt(total(harness, 'inputTokens'))} | ${fmt(total(harness, 'outputTokens'))} | $${total(harness, 'costUsd').toFixed(3)} |`;
  });
  const failures = list.filter((r) => !r.success).map((r) => `- **${r.task} / ${r.harness}**: ${r.note ?? r.verify?.split('\n')[0] ?? ''}${r.error ? ` (harness: ${r.error.split('\n')[0]})` : ''}`);
  const md = [
    `# Harness benchmark ${started.toISOString()}`,
    '',
    `Model \`${model}\` on both; timeout ${timeoutMs / 60_000} min; one run each. \\* = ClikCode reports no cost on the Gateway; estimated at list price (input less cache reads, cache reads at 10%, output). \`model s\` = time spent waiting on model steps (from each tool result or prompt to the step's last output); \`wall s\` less that is the harness's own time plus tool runtime.`,
    '',
    '| harness | passed | wall s | input tok | output tok | cost |',
    '| --- | --- | --- | --- | --- | --- |',
    ...summary,
    '',
    '| task | harness | result | wall s | input tok | cache read | output tok | cost | model calls | model s | tool calls | leftover procs |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
    failures.length ? '## Failures' : '',
    ...failures,
    '',
  ].join('\n');
  writeFileSync(`${stem}.md`, md);
  console.log(md);
  console.error(`results: ${stem}.md`);
}
