#!/usr/bin/env node
/** What a conversation loses at each compaction threshold: recall and continuity, against cost.
 *
 *   node scripts/compaction-eval.mjs <phase> --conv <session id> --source <copy of a ClikCode home>
 *        --cred <a Claude account's .credentials.json> [--thresholds 150,100,80,60,40] [--samples 1]
 *   phases: prepare | probes | baseline | chain | report      (each resumes from what is saved)
 *
 * Inside scripts/vendor-sandbox.mjs (never the user's own vendor history), on haiku through Claude Code:
 * - prepare: the conversation's first turns, as ClikCode writes a vendor thread from its record
 *   (canonicalRecord + fitRecord), up to SEGMENT_TOKENS.
 * - probes: once per conversation, haiku asks questions of four early stretches (a fact, a decision,
 *   a rejection, an identifier each) and of the end (continuity), with answers that must appear
 *   word for word; a probe whose answer is not in its stretch is dropped. Graded by substring.
 * - baseline: the whole stretch in context, each probe a forked resume.
 * - chain: per threshold, the thread is written up to the threshold, compacted by Claude Code's own
 *   /compact with ClikCode's PreCompact hook (state-only instructions), its summary opens the next
 *   thread, and so on to the end; then each probe is asked plainly (compaction only), and with the
 *   topic contents ahead of it and automatic recall after it (search/recall.ts, real embedder).
 * - report: accuracy, measured probe tokens, and the modelled cost per model call of running a
 *   whole conversation at each threshold (cache reads of the context, writes of what is new,
 *   compactions), Haiku prices.
 * Saved under ~/.clikcode/evals/compaction/<conv>/ (the probes quote the user's conversation). */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const phase = argv[0];
const option = (name, fallback) => { const at = argv.indexOf(name); return at > 0 ? argv[at + 1] : fallback; };
const conv = option('--conv');
const thresholds = option('--thresholds', '150,120,100,90,80,70,60,50').split(',').map((value) => Number(value) * 1000);
const samples = Number(option('--samples', '1'));
const MODEL = option('--model', 'haiku');
/** Haiku's files keep their first names; another model's answers, chains and warm turns are its own. */
const TAG = MODEL === 'haiku' ? '' : `-${MODEL}`;
const tagged = (name) => name.replace(/\.json$/, `${TAG}.json`);
const CONDITIONS = option('--conditions', 'compact,recall,hindsight').split(',');
/** The conversation stretch: about this many tokens in context with the system prompt. */
const SEGMENT_TOKENS = Number(option('--segment', '150')) * 1000;
/** $ per million tokens, Claude Haiku 4.5: input, 5-minute cache write, cache read, output. */
const PROBE_LIMIT = Number(option('--probe-limit', '0'));
/** At most PROBE_LIMIT probes: every continuity question, the rest sampled evenly in order (the
 * same subset each time, so a cell and the baseline it is paired with ask the same questions). */
function limitProbes(list) {
  if (!PROBE_LIMIT || list.length <= PROBE_LIMIT) return list;
  const continuity = list.filter((probe) => probe.kind === 'continuity');
  const rest = list.filter((probe) => probe.kind !== 'continuity');
  // Replacement continuity probes ("c" ids, added later) do not shrink the sample of the rest.
  const want = Math.max(0, PROBE_LIMIT - continuity.filter((probe) => !/^c\d/.test(probe.id)).length);
  const keep = new Set(continuity.map((probe) => probe.id));
  for (let index = 0; index < want; index += 1) keep.add(rest[Math.floor((index * rest.length) / want)].id);
  return list.filter((probe) => keep.has(probe.id));
}
/** The probes an audit (probe-audit.json, {drop: {id: reason}}) left in: a probe whose question is
 * broken (asks about a placeholder message, a false premise, a key that is not the answer) is dropped
 * from grading, not re-asked. */
function audited(list, dir) {
  const drop = (dir ? loadFrom(dir, 'probe-audit.json', {}) : load('probe-audit.json', {})).drop ?? {};
  return list.filter((probe) => !drop[probe.id]);
}
/** Graded probes: limitProbes, then the audit. */
const graded = (list, dir) => audited(limitProbes(list), dir);
/** Verdicts: judge-v2.json (the hedge and equivalence rules) when there is one, else judge.json. */
const JUDGE_FILE = option('--judge-file', 'judge-v2.json');
const judgedIn = (dir) => { const v2 = dir ? loadFrom(dir, JUDGE_FILE) : load(JUDGE_FILE); return v2 ?? (dir ? loadFrom(dir, 'judge.json', {}) : load('judge.json', {})); };
const PRICE = { input: 1, write: 1.25, read: 0.1, output: 5 };
const CONCURRENCY = Number(option('--concurrency', '3'));
const JUDGE_MODEL = option('--judge-model', 'sonnet');

if (!phase || (!conv && phase !== 'grid')) { console.error('usage: node scripts/compaction-eval.mjs <prepare|probes|baseline|chain|report> --conv <id> --source <dir> --cred <file>'); process.exit(2); }
const realHome = process.env.EVAL_REAL_HOME ?? homedir();
const evalsRoot = join(realHome, '.clikcode', 'evals', 'compaction');
const evalDir = join(evalsRoot, (conv ?? 'grid').slice(0, 8));
if (conv) mkdirSync(evalDir, { recursive: true });
const saved = (name) => join(evalDir, name);
const load = (name, fallback) => (existsSync(saved(name)) ? JSON.parse(readFileSync(saved(name), 'utf8')) : fallback);
const loadFrom = (dir, name, fallback) => (existsSync(join(evalsRoot, dir, name)) ? JSON.parse(readFileSync(join(evalsRoot, dir, name), 'utf8')) : fallback);
const lines = (dir, name) => (existsSync(join(evalsRoot, dir, name)) ? readFileSync(join(evalsRoot, dir, name), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
const save = (name, value) => writeFileSync(saved(name), `${JSON.stringify(value, null, 1)}\n`);

if (phase === 'report') { report(); process.exit(0); }
if (phase === 'grid') { grid(); process.exit(0); }

if (!process.env.EVAL_INSIDE) {
  const cred = option('--cred');
  if (!cred || !existsSync(cred)) { console.error('--cred: a Claude account\'s .credentials.json'); process.exit(2); }
  const result = spawnSync(process.execPath, [join(root, 'scripts', 'vendor-sandbox.mjs'), '--', process.execPath, fileURLToPath(import.meta.url), ...argv], {
    stdio: 'inherit', env: { ...process.env, EVAL_INSIDE: '1', EVAL_REAL_HOME: homedir(), EVAL_CRED: resolve(cred), ANTHROPIC_API_KEY: '' },
  });
  process.exit(result.status ?? 1);
}

// ------------------------------------------------- inside the sandbox ----
const home = process.env.HOME;
const profile = join(home, 'profile');
const claudeDir = join(profile, '.claude-profile');
mkdirSync(claudeDir, { recursive: true });
if (!existsSync(join(claudeDir, '.credentials.json'))) symlinkSync(process.env.EVAL_CRED, join(claudeDir, '.credentials.json'));
const workspace = join(home, 'work');
mkdirSync(workspace, { recursive: true });
// The embedder's model and runtime are the user's (read only); its server and leases are this run's.
const modelsHome = join(home, 'local-models');
mkdirSync(join(modelsHome, 'servers'), { recursive: true });
for (const name of ['models', 'runtimes']) {
  const from = join(realHome, '.clikcode', 'local-models', name);
  if (existsSync(from) && !existsSync(join(modelsHome, name))) symlinkSync(from, join(modelsHome, name));
}
process.env.CLIKCODE_LOCAL_MODELS_HOME = modelsHome;
delete process.env.VITEST;
const vendorEnv = { ...process.env, HOME: profile, CLAUDE_CONFIG_DIR: claudeDir, DISABLE_AUTO_COMPACT: '1', ANTHROPIC_API_KEY: '' };
delete vendorEnv.ANTHROPIC_API_KEY;

const { build } = await import('esbuild');
const bundle = join(home, 'eval-bundle.mjs');
await build({
  stdin: {
    contents: [
      "export { NATIVE_SESSION_STORES } from './src/session/discovery/registry.ts';",
      "export { canonicalRecord } from './src/session/canonical.ts';",
      "export { fitRecord } from './src/turn/thread-start.ts';",
      "export { readState } from './src/session/state/read.ts';",
      "export { writeState } from './src/session/state/write.ts';",
      "export { recall } from './src/search/recall.ts';",
      "export { topicContents } from './src/search/topic-contents.ts';",
      "export { wrapResourceNote } from './src/turn/resource-note-text.ts';",
      "export { fullRecordNote, recordReachFor } from './src/session/full-record.ts';",
      "export { claudeCompactSettings } from './src/turn/compaction.ts';",
      "export { conversationGroups, findConversation } from './src/search/conversations.ts';",
      "export { indexConversation, vectorFilePath } from './src/search/vectors.ts';",
      "export { embedderWithin } from './src/search/embedder.ts';",
      "export { queryVector } from './src/search/hybrid.ts';",
      "export { AI_LOCAL_HARNESSES } from '@clikcode/router/ai-local-harness';",
      "export { computerSettingsPath } from './src/agent/computer/settings.ts';",
      "export { stateDirectory } from './src/session/store/paths.ts';",
      "export { lifecycleLogPath } from './src/runtime/lifecycle-log.ts';",
    ].join('\n'),
    resolveDir: root, loader: 'ts',
  },
  bundle: true, platform: 'node', format: 'esm', outfile: bundle, logLevel: 'error',
  define: { __CLIKCODE_VERSION__: '"eval"' },
  banner: { js: "import { createRequire as __r } from 'node:module'; const require = __r(import.meta.url);" },
});
// The hindsight condition's tools: ClikCode's own MCP server (commands/mcp-serve.ts handleMcpRequest),
// answering for this conversation as a chat's worker would, each call logged.
const mcpBundle = join(home, 'eval-mcp.mjs');
await build({
  stdin: {
    contents: `import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
import { handleMcpRequest } from './src/commands/mcp-serve.ts';
const noWorker = async () => ({ ok: false, output: 'no worker in this eval' });
createInterface({ input: process.stdin }).on('line', async (line) => {
  let message; try { message = JSON.parse(line); } catch { return; }
  const started = Date.now();
  const response = await handleMcpRequest(message, noWorker, async () => process.env.EVAL_CONV);
  if (message.method === 'tools/call') appendFileSync(process.env.EVAL_TOOL_LOG, JSON.stringify({ at: process.env.EVAL_CELL, name: message.params?.name, args: message.params?.arguments, ms: Date.now() - started, chars: response?.result?.content?.[0]?.text?.length ?? 0, ...(process.env.EVAL_TOOL_TEXT ? { text: response?.result?.content?.[0]?.text ?? '' } : {}) }) + '\\n');
  if (response) process.stdout.write(JSON.stringify(response) + '\\n');
});`,
    resolveDir: root, loader: 'ts',
  },
  // Computer use is off here, so what only its tools load stays out.
  bundle: true, platform: 'node', format: 'esm', outfile: mcpBundle, logLevel: 'error', external: ['playwright', 'playwright-core', 'chromium-bidi', 'chromium-bidi/*'],
  define: { __CLIKCODE_VERSION__: '"eval"' },
  banner: { js: "import { createRequire as __r } from 'node:module'; const require = __r(import.meta.url);" },
});
// The embedder's supervisor is found beside the code that starts it (local-models/lifecycle.ts).
if (!existsSync(join(home, 'local-model-supervisor.cjs'))) symlinkSync(join(root, 'dist', 'local-model-supervisor.cjs'), join(home, 'local-model-supervisor.cjs'));
const clik = await import(pathToFileURL(bundle).href);
const harness = clik.AI_LOCAL_HARNESSES.find((item) => item.command === 'claude');
const writer = clik.NATIVE_SESSION_STORES.claude.writer;
const settingsJson = JSON.stringify(clik.claudeCompactSettings());
// Computer use off in this store: the conversation tools alone, as a chat with computer use off has.
mkdirSync(dirname(clik.computerSettingsPath(clik.stateDirectory())), { recursive: true });
writeFileSync(clik.computerSettingsPath(clik.stateDirectory()), JSON.stringify({ enabled: false }));
const TOOL_NAMES = ['hindsight', 'search_conversations', 'read_conversation', 'active_conversations'].map((name) => `mcp__clikcode__${name}`);
/** Claude Code arguments that give the model ClikCode's MCP server, as a ClikCode chat has it. */
function toolArgs(cell, log = saved(`tool-log${TAG}.jsonl`), text = false, maxTurns = 8) {
  const config = { mcpServers: { clikcode: { type: 'stdio', command: process.execPath, args: [mcpBundle], env: { EVAL_CONV: conv, EVAL_TOOL_LOG: log, EVAL_CELL: cell, ...(text ? { EVAL_TOOL_TEXT: '1' } : {}) } } } };
  return ['--mcp-config', JSON.stringify(config), '--allowedTools', TOOL_NAMES.join(','), '--max-turns', String(maxTurns)];
}
const version = spawnSync('claude', ['--version'], { encoding: 'utf8', env: vendorEnv }).stdout?.split('\n')[0]?.trim();

function turnBytes(turn) { return Buffer.byteLength((turn.providerNote ?? '') + turn.user + JSON.stringify(turn.parts), 'utf8'); }

/** The conversation as ClikCode keeps it, from the copied home (read only), and its first stretch. */
function sourceSession() {
  const source = option('--source');
  const index = JSON.parse(readFileSync(join(source, 'index.json'), 'utf8'));
  const entry = index.sessions.find((session) => session.id === conv);
  const file = JSON.parse(readFileSync(join(source, 'sessions', `${conv}.json`), 'utf8'));
  return { ...entry, messages: file.messages, pendingTurn: undefined };
}

async function prepare() {
  const session = sourceSession();
  const record = clik.canonicalRecord(session);
  const maxBytes = SEGMENT_TOKENS * 4;
  // The most turns that fit with nothing left out (fitRecord: older turns as their words and a line per call).
  let low = 1;
  let high = record.turns.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (clik.fitRecord({ ...record, turns: record.turns.slice(0, mid) }, maxBytes).omitted === 0) low = mid; else high = mid - 1;
  }
  const fitted = clik.fitRecord({ ...record, turns: record.turns.slice(0, low) }, maxBytes).record;
  // Which transcript message opens each turn (canonical.ts: a user message opens one, an answer with none before it too).
  const opens = [];
  let open = false;
  session.messages.forEach((message, at) => {
    if (message.role === 'user' || !open) { opens.push(at); open = true; }
  });
  const messageEnd = opens[low] ?? session.messages.length;
  save('segment.json', { conv, turns: fitted.turns, opens: opens.slice(0, low), messageEnd, title: session.name });
  console.log(`segment: ${low} of ${record.turns.length} turns, messages 0-${messageEnd - 1}, ${Math.round(fitted.turns.reduce((sum, turn) => sum + turnBytes(turn), 0) / 4 / 1000)}k tokens estimated`);
}

const segment = () => load('segment.json');

/** One Claude Code call; usage and text out. */
function claude(args, { input, timeoutMs = 600_000, model = MODEL } = {}) {
  return new Promise((done) => {
    const child = spawn('claude', ['-p', '--model', model, '--output-format', 'json', '--tools', '', '--strict-mcp-config', '--settings', settingsJson, ...args], { cwd: workspace, env: vendorEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.end(input ?? '');
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('close', (code) => {
      clearTimeout(timer);
      let json;
      try { json = JSON.parse(out); } catch { json = undefined; }
      // /compact reports no top-level usage; its model calls are in modelUsage.
      const models = Object.values(json?.modelUsage ?? {});
      const sum = (field) => models.reduce((total, item) => total + (item[field] ?? 0), 0);
      const usage = json?.usage?.input_tokens || json?.usage?.cache_read_input_tokens || !models.length ? (json?.usage ?? {})
        : { input_tokens: sum('inputTokens'), cache_creation_input_tokens: sum('cacheCreationInputTokens'), cache_read_input_tokens: sum('cacheReadInputTokens'), output_tokens: sum('outputTokens') };
      done({
        code, text: json?.result ?? '', sessionId: json?.session_id, error: json?.is_error ? json?.result : code ? err.slice(-500) : undefined,
        usage: { input: usage.input_tokens ?? 0, write: usage.cache_creation_input_tokens ?? 0, read: usage.cache_read_input_tokens ?? 0, output: usage.output_tokens ?? 0 },
        costUsd: json?.total_cost_usd ?? 0, turns: json?.num_turns, models: Object.keys(json?.modelUsage ?? {}),
      });
    });
  });
}

/** `fn` over `items`, CONCURRENCY at a time, results in order. */
async function pool(items, fn) {
  const out = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (next < items.length) { const index = next; next += 1; out[index] = await fn(items[index], index); }
  }));
  return out;
}

function weighted(usage) { return (usage.input * PRICE.input + usage.write * PRICE.write + usage.read * PRICE.read + usage.output * PRICE.output) / 1e6; }

async function writeThread(turns) {
  const written = await writer.write({ version: 1, conversationId: conv, sessionId: conv, workspace, turns, touchedFiles: [], attachments: [], pendingAttachments: [], openTodos: [] },
    { harness, workspace, environment: { HOME: profile, CLAUDE_CONFIG_DIR: claudeDir }, model: null, version });
  return written.nativeId;
}

function threadFile(id) {
  const projects = join(claudeDir, 'projects');
  for (const name of readdirSync(projects)) if (existsSync(join(projects, name, `${id}.jsonl`))) return join(projects, name, `${id}.jsonl`);
  return undefined;
}

/** Probes, made once per conversation by haiku from stretches of it, kept when every answer is in its
 * stretch and one answer is particular to it (in at most RARE of the segment's turns):
 * - 12 stretches of the older three quarters and 8 of the last quarter (by size), four each: a fact,
 *   a decision, a rejection, an identifier;
 * - six continuity questions from the last turns (the request, the step, what is next).
 * --extend: added to the probes there are (as "v" probes), at most --max-new of them. */
const RARE = 0.05;
async function probes() {
  const extend = argv.includes('--extend');
  /** --continuity: only end-of-work probes, from the last substantive turns (placeholder pings
   * like "x7216073" at a conversation's end are skipped), ids "c0".. */
  const onlyEnd = argv.includes('--continuity');
  if (load('probes.json') && !extend && !onlyEnd) { console.log('probes exist; --extend adds to them'); return; }
  const { turns } = segment();
  const n = turns.length;
  const text = (from, to) => turns.slice(from, to).map((turn) => `[turn ${turn.index}] USER: ${turn.user}\nASSISTANT: ${turn.assistant}`).join('\n\n');
  const norm = (value) => value.toLowerCase().replace(/\s+/g, ' ');
  const turnText = turns.map((turn) => norm(`${turn.user}\n${turn.assistant}`));
  const rare = (key) => turnText.filter((body) => body.includes(norm(key))).length <= Math.max(2, RARE * n);
  // Stretch edges by size: the turn where each share of the segment's bytes is reached.
  const sizes = turns.map(turnBytes);
  const total = sizes.reduce((sum, size) => sum + size, 0);
  const at = (share) => { let used = 0; for (let index = 0; index < n; index += 1) { used += sizes[index]; if (used >= share * total) return index + 1; } return n; };
  const edges = (from, to, count) => Array.from({ length: count }, (_, index) => [at(from + (to - from) * index / count), at(from + (to - from) * (index + 1) / count)]).filter(([x, y]) => y > x);
  const stretches = [...edges(0, 0.75, 12), ...edges(0.75, 1, 8)].map(([x, y]) => [x, Math.min(y, n - 8)]).filter(([x, y]) => y > x);
  const ask = async (body, wanted) => {
    const prompt = `Below is part of a long working conversation between a user and an AI assistant.\n\n<conversation>\n${body.slice(0, 160_000)}\n</conversation>\n\n`
      + `Write ${wanted} to test whether someone who took part in the WHOLE conversation still remembers this part. Return JSON only: an array of objects {"kind", "question", "answer"}. `
      + '"answer" is an array of 1 to 3 short strings, each copied WORD FOR WORD from the conversation above, that any correct answer must contain: '
      + 'distinctive names, identifiers, file paths, numbers, commands, or two-to-four-word exact phrases; never a whole sentence, never common words, never the conversation\'s own markup. '
      + 'Each question must stand on its own (name the subject so it is unambiguous in a long conversation about many things) and must not contain its answer.';
    const result = await claude([], { input: prompt });
    if (result.error || !result.text) console.log(`probe call: ${result.error ?? 'no text'} (exit ${result.code})`);
    appendFileSync(saved('probe-gen.jsonl'), `${JSON.stringify({ usage: result.usage })}\n`);
    const match = /\[[\s\S]*\]/.exec(result.text);
    try { return JSON.parse(match?.[0] ?? '[]'); } catch { return []; }
  };
  const made = [];
  const keep = (probe, body, stretch, kind) => {
    if (!Array.isArray(probe.answer) || !probe.answer.length || !probe.question) return;
    const keys = probe.answer.filter((key) => typeof key === 'string').map((key) => key.trim());
    if (keys.length !== probe.answer.length || keys.some((key) => key.length < 3 || !norm(body).includes(norm(key)))) return;
    if (keys.some((key) => norm(probe.question).includes(norm(key))) || !keys.some(rare)) return;
    made.push({ stretch, kind: kind ?? probe.kind, question: probe.question, answer: keys });
  };
  const results = onlyEnd ? [] : await pool(stretches, async ([from, to]) => {
    const body = text(from, to);
    return { body, from, to, list: await ask(body, 'four questions: kind "fact", "decision" (what the user or assistant decided, and why), "rejection" (an option the user turned down or ruled out), "identifier" (an exact name, path, id or value)') };
  });
  for (const { body, from, to, list } of results) for (const probe of list) keep(probe, body, [from, to]);
  const junk = (turn) => /^x\w*$/.test(turn.user.trim()) || !String(turn.assistant ?? '').trim();
  let endTo = n;
  if (onlyEnd) while (endTo > 8 && junk(turns[endTo - 1])) endTo -= 1;
  const endBody = text(endTo - 8, endTo);
  const pings = onlyEnd && endTo < n ? ' The conversation went on after this only with placeholder test messages, which do not count: ask about the substantive work below, and never about placeholder messages or turn numbers.' : '';
  for (const probe of await ask(endBody, `six questions of kind "continuity", about where the work stands at the very end: what the user asked for most recently, what step the work is on, what the assistant was doing last, what is to be done next, the latest decision, and the latest file or thing worked on.${pings}`)) keep(probe, endBody, [endTo - 8, endTo], 'continuity');
  const prior = load('probes.json', []);
  const prefix = onlyEnd ? 'c' : extend ? 'v' : 'p';
  let fresh = made.map((probe, index) => ({ id: `${prefix}${index}`, ...probe }));
  const most = Number(option('--max-new', '1000'));
  if (fresh.length > most) fresh = fresh.filter((_, index) => Math.floor(index * most / fresh.length) !== Math.floor((index - 1) * most / fresh.length));
  save('probes.json', [...prior, ...fresh]);
  console.log(`${made.length} probes made, ${fresh.length} kept, ${prior.length + fresh.length} in all; by kind ${JSON.stringify(fresh.reduce((all, probe) => ({ ...all, [probe.kind]: (all[probe.kind] ?? 0) + 1 }), {}))}`);
}

let errors = 0;
const PROBE_PREFIX = 'Answer from what you remember of this conversation; no tools. In one or two sentences, with exact names and values.\n\nQuestion: ';
/** Case, markdown, hyphens and spacing aside, every key in the answer. */
function plain(text) { return text.toLowerCase().replace(/[`*"]/g, '').replace(/[-_\s]+/g, ' '); }
function grade(answer, keys) { return keys.every((key) => plain(answer).includes(plain(key))); }
/** The judge's verdict on an answer (judge.json, by probe and answer text), else the substring grade.
 * The substring grade fails right answers that paraphrase a key ("106 of 106" for "106/106"). */
function answerHash(probe, answer) { return `${probe}|${createHash('sha1').update(answer ?? '').digest('hex').slice(0, 16)}`; }
function verdict(judged, row, keys) { return judged?.[answerHash(row.probe, row.answer)] ?? grade(row.answer, keys); }

/** Every probe on thread `id`, as a forked resume; one first to warm the cache, then a few at a time. */
async function askAll(id, condition, threshold, promptFor, extraArgs = [], { file = tagged('answers.json'), only } = {}) {
  const argsFor = (probe) => (typeof extraArgs === 'function' ? extraArgs(probe) : extraArgs);
  const done = new Set(load(file, []).map((row) => row.key));
  const jobs = [];
  for (const probe of limitProbes(load('probes.json')).filter((item) => !only || only.has(item.id))) {
    for (let sample = 0; sample < samples; sample += 1) {
      const key = `${condition}|${threshold}|${probe.id}|${sample}`;
      if (!done.has(key)) jobs.push({ key, probe, sample });
    }
  }
  const run = async ({ key, probe, sample }) => {
    const prompt = await promptFor(probe);
    const result = await claude(['--resume', id, '--fork-session', ...argsFor(probe)], { input: prompt });
    const row = { key, condition, threshold, probe: probe.id, kind: probe.kind, sample, correct: grade(result.text, probe.answer), usage: result.usage, costUsd: result.costUsd, turns: result.turns, models: result.models, promptChars: prompt.length, answer: result.text, ...(result.error ? { error: result.error } : {}) };
    if (result.error) { errors += 1; console.log(`  ${key}: ERROR ${result.error.slice(0, 200)}`); if (/limit|rate|overloaded|login/i.test(result.error) && errors > 5) { console.log('stopping: repeated limit errors'); process.exit(3); } return; }
    const all = load(file, []);
    all.push(row);
    save(file, all);
    console.log(`  ${key}: ${row.correct ? 'ok ' : 'MISS'} read ${result.usage.read} write ${result.usage.write} in ${result.usage.input} turns ${result.turns}`);
  };
  if (!jobs.length) return;
  // Claude Code caches up to a request's last message, so forks that differ only in their question
  // would each write the whole thread again. One plain turn on the thread first leaves an entry
  // ending at the thread; every fork reads it, as a conversation's next turn reads its last.
  const warm = await claude(['--resume', id, ...argsFor(jobs[0].probe)], { input: 'Reply with OK only.' });
  const warms = load(tagged('warm.json'), []);
  warms.push({ condition, threshold, usage: warm.usage, costUsd: warm.costUsd });
  save(tagged('warm.json'), warms);
  console.log(`  warm ${condition}|${threshold}: read ${warm.usage.read} write ${warm.usage.write}`);
  await pool(jobs, run);
}

/** With ClikCode's tools the request is the question as a user would put it; no word about tools. */
const TOOL_PROBE_PREFIX = 'In one or two sentences, with exact names and values.\n\nQuestion: ';

async function baseline() {
  const id = await writeThread(segment().turns);
  await askAll(id, 'baseline', 0, (probe) => `${PROBE_PREFIX}${probe.question}`);
}

/** The system prompt and tools Claude Code reads before any conversation, measured with its default tools. */
async function overhead() {
  const known = load('overhead.json');
  if (known) return known;
  const child = spawnSync('claude', ['-p', '--model', MODEL, '--output-format', 'json', '--strict-mcp-config', 'Reply with OK only.'], { cwd: workspace, env: vendorEnv, encoding: 'utf8' });
  const usage = JSON.parse(child.stdout).usage;
  const value = { tokens: usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens };
  save('overhead.json', value);
  return value;
}

/** Tokens per byte of written turn, from the baseline's first probe (the whole stretch in context). */
function tokenScale() {
  const first = load('answers.json', []).find((row) => row.condition === 'baseline');
  const bytes = segment().turns.reduce((sum, turn) => sum + turnBytes(turn), 0);
  if (!first) return 0.25;
  const context = first.usage.input + first.usage.write + first.usage.read;
  const fixed = load('probe-overhead.json')?.tokens ?? 0;
  return (context - fixed) / bytes;
}

async function probeOverhead() {
  const known = load('probe-overhead.json');
  if (known) return known;
  const result = await claude([], { input: 'Reply with OK only.' });
  const value = { tokens: result.usage.input + result.usage.write + result.usage.read };
  save('probe-overhead.json', value);
  return value;
}

/** Thread up to the threshold, /compact with the hook, its summary opens the next; the last thread is what the probes resume. */
async function chain() {
  const { turns, opens, messageEnd } = segment();
  const fixed = (await overhead()).tokens;
  await probeOverhead();
  const scale = tokenScale();
  const tokens = turns.map((turn) => Math.ceil(turnBytes(turn) * scale));
  const chains = load(tagged('chains.json'), {});
  for (const threshold of thresholds) {
    const budget = threshold - fixed;
    let state = chains[threshold] ?? { compactions: [], summary: undefined, from: 0 };
    while (true) {
      const summaryTokens = state.summary ? Math.ceil(state.summary.length / 4) : 0;
      let to = state.from;
      let used = summaryTokens;
      while (to < turns.length && used + tokens[to] <= budget) { used += tokens[to]; to += 1; }
      if (to >= turns.length) break;
      if (to === state.from) to += 1; // one turn larger than the budget is read anyway, as the vendor would
      const piece = turns.slice(state.from, to).map((turn, at) => (at === 0 && state.summary ? { ...turn, providerNote: state.summary } : turn));
      const id = await writeThread(piece);
      const before = Date.now();
      const result = await claude(['--resume', id, '/compact']);
      const file = threadFile(id);
      const summary = file ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => entry.isCompactSummary)
        .map((entry) => (typeof entry.message.content === 'string' ? entry.message.content : entry.message.content.map((part) => part.text ?? '').join(''))).at(-1) : undefined;
      if (!summary) { console.log(`T=${threshold}: /compact wrote no summary (${result.error ?? result.text.slice(0, 200)})`); process.exit(1); }
      const context = summaryTokens + tokens.slice(state.from, to).reduce((sum, value) => sum + value, 0);
      state = { compactions: [...state.compactions, { from: state.from, to, context, summaryChars: summary.length, ms: Date.now() - before, usage: result.usage }], summary, from: to };
      chains[threshold] = state;
      save(tagged('chains.json'), chains);
      console.log(`T=${threshold / 1000}k: compacted turns ${state.compactions.at(-1).from}-${to - 1} (${Math.round(context / 1000)}k) -> ${summary.length} chars`);
    }
    if (!state.summary) { console.log(`T=${threshold / 1000}k: the stretch fits; same as the baseline`); chains[threshold] = state; save(tagged('chains.json'), chains); continue; }
    const tail = turns.slice(state.from).map((turn, at) => (at === 0 ? { ...turn, providerNote: state.summary } : turn));
    const id = await writeThread(tail);
    if (CONDITIONS.includes('compact')) await askAll(id, 'compact', threshold, (probe) => `${PROBE_PREFIX}${probe.question}`);
    // Compaction + recall + contents: the conversation is in ClikCode's store; the context holds what is
    // after the boundary. Recall within its own budget (RECALL_BUDGET_MS), as a turn has it.
    // hindsight: the same, and ClikCode's MCP server too, as a chat in ClikCode has it.
    const boundary = opens[state.from];
    if (CONDITIONS.some((name) => VARIANTS[name]?.ledger)) ledgers[threshold] = await buildLedger(threshold, state, turns, opens);
    for (const condition of CONDITIONS.filter((name) => name in VARIANTS)) {
      const session = await storedSession(messageEnd);
      const variant = VARIANTS[condition];
      const lastAssistant = [...tail].reverse().find((turn) => typeof turn.assistant === 'string' && turn.assistant.trim())?.assistant;
      await askAll(id, condition, threshold, (probe) => variantPrompt(condition, threshold, probe, session, boundary, lastAssistant),
        variant.tools ? toolArgs(`${condition}|${threshold}`, undefined, false, variant.maxTurns ?? 8) : []);
    }
  }
}

/** The conditions after compaction, each the conversation in ClikCode's store with the context
 * holding what is after the boundary; recall within its own budget (RECALL_BUDGET_MS), as a turn has it.
 * - recall: recall + topic contents, no tools.
 * - hindsight: the same and ClikCode's MCP server, as a chat in ClikCode has it (the note as the eval
 *   first built it: contents only).
 * - hs-*: the note as withCompactionNote (turn/compaction-run.ts) builds it, fullRecordNote first
 *   (`record`), and eval-only knobs as environment (topic-contents.ts, recall.ts). */
const NUDGE = { CLIKCODE_EVAL_SEARCH_NUDGE: '1' };
const IDS = { CLIKCODE_EVAL_ID_LIST: '1' };
const VARIANTS = {
  recall: { tools: false },
  hindsight: { tools: true },
  'hs-record': { tools: true, record: true, maxTurns: 16 },
  'hs-nudge': { tools: true, record: true, maxTurns: 16, env: NUDGE },
  'hs-ids': { tools: true, record: true, maxTurns: 16, env: { ...NUDGE, ...IDS } },
  'hs-ledger': { tools: true, record: true, maxTurns: 16, ledger: true },
  ...JSON.parse(process.env.EVAL_VARIANTS ?? '{}'),
};
/** hs-ledger: at each compaction a separate call lists the decisions, rejections (what was ruled out
 * and why) and exact identifiers of the stretch being compacted, one line each with its message number;
 * the lines are appended to a ledger carried unchanged through later compactions (never re-summarised),
 * capped at LEDGER_MAX_CHARS (~2k tokens) by dropping the oldest. ledger.json keeps each stretch's lines
 * and usage, so the extraction is paid once per compaction and counted in the cell's run cost. */
const ledgers = {};
const LEDGER_PROMPT = 'Below is a stretch of a conversation between a user and an AI coding assistant; each message starts with its number in brackets. '
  + 'List what a later reader would need exactly and could not reconstruct from a summary:\n'
  + '- D: each decision made (what was chosen, in a few words, and why if stated)\n'
  + '- R: each rejection (what was ruled out or reverted, and why)\n'
  + '- I: each exact identifier that mattered (commit hash, file path, name, number, setting, URL, error code), copied character for character, with a few words saying what it is\n'
  + 'One item per line, in this form: [message number] D|R|I: text. At most 50 lines, the ones that matter most; no preamble, no headings, nothing else.\n\n';
function ledgerLines(text) { return String(text ?? '').split('\n').map((line) => line.trim()).filter((line) => /^\[\d+\]\s*[DRI]:/.test(line)).map((line) => line.slice(0, 300)); }
async function buildLedger(threshold, state, turns, opens) {
  const store = load('ledger.json', {});
  const stretches = store[threshold] ?? [];
  for (const [index, cut] of state.compactions.entries()) {
    if (stretches[index]?.from === cut.from && stretches[index]?.to === cut.to) continue;
    const body = turns.slice(cut.from, cut.to).map((turn, at) => `[${opens[cut.from + at]}] USER: ${turn.user ?? ''}\n[${Math.min(opens[cut.from + at] + 1, (opens[cut.from + at + 1] ?? Infinity) - 1)}] ASSISTANT: ${typeof turn.assistant === 'string' ? turn.assistant : ''}`).join('\n\n').slice(0, 400_000);
    const result = await claude([], { input: `${LEDGER_PROMPT}${body}` });
    if (result.error) { console.log(`T=${threshold / 1000}k: ledger extraction failed (${result.error.slice(0, 200)})`); process.exit(1); }
    stretches[index] = { from: cut.from, to: cut.to, lines: ledgerLines(result.text), usage: result.usage };
    store[threshold] = stretches;
    save('ledger.json', store);
    console.log(`T=${threshold / 1000}k: ledger for turns ${cut.from}-${cut.to - 1}: ${stretches[index].lines.length} lines`);
  }
  return ledgerText(stretches.slice(0, state.compactions.length));
}
/** The ledger as the context holds it after the last compaction: every stretch's lines in order, the oldest dropped first past the cap. */
function ledgerText(stretches) {
  const LEDGER_MAX_CHARS = Number(process.env.EVAL_LEDGER_MAX_CHARS ?? 8000); // read here: grid runs before module constants below are set
  const all = stretches.flatMap((item) => item.lines);
  let chars = 0;
  const kept = [];
  for (const line of [...all].reverse()) { if (chars + line.length + 1 > LEDGER_MAX_CHARS) break; kept.unshift(line); chars += line.length + 1; }
  return kept.length ? `Ledger of the decisions (D), rejections (R) and identifiers (I) from before your summary, each with its message number; read around a number with hindsight from/to for detail${kept.length < all.length ? ` (the oldest ${all.length - kept.length} lines dropped)` : ''}:\n${kept.join('\n')}` : '';
}
const contentsCache = new Map();
async function withEnv(env, work) {
  const prior = Object.fromEntries(Object.keys(env).map((name) => [name, process.env[name]]));
  Object.assign(process.env, env);
  try { return await work(); } finally { for (const [name, value] of Object.entries(prior)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } }
}
async function variantPrompt(condition, threshold, probe, session, boundary, lastAssistant) {
  const variant = VARIANTS[condition];
  const tools = variant.tools;
  return withEnv(variant.env ?? {}, async () => {
    const cacheKey = `${condition}|${boundary}`;
    if (!contentsCache.has(cacheKey)) {
      const contents = await clik.topicContents(session, tools, { through: boundary });
      const reach = variant.record ? clik.recordReachFor(tools, undefined) : undefined;
      contentsCache.set(cacheKey, [reach ? clik.fullRecordNote(reach) : '', contents ?? '', variant.ledger ? ledgers[threshold] ?? '' : ''].filter(Boolean).join('\n\n'));
    }
    const note = contentsCache.get(cacheKey);
    const request = `${tools ? TOOL_PROBE_PREFIX : PROBE_PREFIX}${probe.question}`;
    const started = Date.now();
    const found = await clik.recall({ sessionId: conv, query: request, boundary, hasHindsight: tools, context: lastAssistant });
    const row = { key: `${threshold}|${probe.id}`, condition, model: MODEL, boundary, ms: Date.now() - started, hits: found.hits.map((hit) => `${hit.position}:${hit.by}:${hit.score}`), skipped: found.skipped, chars: found.note?.length ?? 0, noteChars: note.length };
    appendFileSync(saved('recall-log.jsonl'), `${JSON.stringify(row)}\n`);
    const prompt = `${note ? `${clik.wrapResourceNote(note)}\n\n` : ''}${request}${found.note ? `\n\n${found.note}` : ''}`;
    // One prompt per cell kept beside the answers, to read what the model was given.
    const sample = saved(`prompt-${condition}-${threshold}${TAG}.txt`);
    if (!existsSync(sample)) writeFileSync(sample, prompt);
    return prompt;
  });
}

let stored;
/** The conversation's stretch in this sandbox's ClikCode store, indexed for search. */
async function storedSession(messageEnd) {
  if (stored) return stored;
  const session = sourceSession();
  session.messages = session.messages.slice(0, messageEnd);
  const state = await clik.readState();
  state.sessions = [...state.sessions.filter((item) => item.id !== conv), session];
  await clik.writeState(state);
  const embedder = await clik.embedderWithin(180_000);
  if (embedder) {
    const found = clik.findConversation(await clik.conversationGroups(), conv);
    // The whole conversation is embedded, as it is for a user whose chat was indexed while it ran;
    // kept between runs (each run is a fresh sandbox), so a phase only embeds what is new.
    const live = clik.vectorFilePath(found.group.id);
    const kept = saved('vectors.jsonl');
    if (existsSync(kept) && !existsSync(live)) { mkdirSync(dirname(live), { recursive: true }); copyFileSync(kept, live); }
    let result;
    for (let pass = 0; pass < 8; pass += 1) {
      result = await clik.indexConversation(found.group, embedder, { deadline: Date.now() + 600_000 });
      console.log(`indexed with ${embedder.id}: ${JSON.stringify(result)}`);
      if (!result.pending) break;
    }
    if (result.pending) { console.log('the index did not finish'); process.exit(1); }
    copyFileSync(live, kept);
  } else { console.log(`no embedder: ${existsSync(join(modelsHome, 'servers', 'clikcode-embeddings', 'failed.json')) ? readFileSync(join(modelsHome, 'servers', 'clikcode-embeddings', 'failed.json'), 'utf8') : 'not ready'}`); process.exit(1); }
  stored = session;
  return session;
}

function report() {
  const probesList = load('probes.json', []);
  const keyOf = Object.fromEntries(probesList.map((probe) => [probe.id, probe.answer]));
  const answers = load('answers.json', []).filter((row) => keyOf[row.probe]);
  const chains = load('chains.json', {});
  const seg = load('segment.json');
  const fixed = load('overhead.json')?.tokens ?? 0;
  const rows = [];
  const cell = (condition, threshold) => {
    const set = answers.filter((row) => row.condition === condition && row.threshold === threshold);
    if (!set.length) return undefined;
    for (const row of set) row.correct = grade(row.answer, keyOf[row.probe] ?? ['\u0000']);
    const right = set.filter((row) => row.correct).length;
    const cost = set.reduce((sum, row) => sum + weighted(row.usage), 0) / set.length;
    const part = (letter) => { const some = set.filter((row) => row.probe.startsWith(letter)); return [some.filter((row) => row.correct).length, some.length]; };
    const byPart = { early: part('s'), recent: part('r'), end: part('end') };
    const byKind = {};
    for (const row of set) { byKind[row.kind] ??= [0, 0]; byKind[row.kind][0] += row.correct ? 1 : 0; byKind[row.kind][1] += 1; }
    return { right, total: set.length, cost, byKind, byPart };
  };
  // Tokens per byte of written turn, from the baseline (the whole stretch in context, less the probe call's own).
  const first = answers.find((row) => row.condition === 'baseline');
  const probeFixed = load('probe-overhead.json')?.tokens ?? 0;
  const bytes = seg ? seg.turns.reduce((sum, turn) => sum + turnBytes(turn), 0) : 1;
  const scale = first ? (first.usage.input + first.usage.write + first.usage.read - probeFixed) / bytes : 0.25;
  const model = (threshold) => modelledCost(seg, threshold ? chains[threshold] : undefined, fixed, scale);
  const base = cell('baseline', 0);
  if (base) rows.push({ threshold: 'full', condition: 'baseline', ...base, model: model(0) });
  for (const threshold of thresholds) {
    for (const condition of ['compact', 'recall-words', 'recall']) {
      const value = cell(condition, threshold);
      if (value) rows.push({ threshold: threshold / 1000, condition, ...value, model: model(threshold), compactions: chains[threshold]?.compactions.length });
    }
  }
  console.log(`${conv.slice(0, 8)} ${seg?.title ?? ''}: ${probesList.length} probes, ${seg?.turns.length} turns`);
  for (const row of rows) {
    const pct = ([a, b]) => (b ? `${a}/${b}` : '-');
    console.log(`${String(row.threshold).padEnd(5)} ${row.condition.padEnd(12)} ${row.right}/${row.total} (${Math.round(100 * row.right / row.total)}%)  early ${pct(row.byPart.early)} recent ${pct(row.byPart.recent)} end ${pct(row.byPart.end)}  modelled $ ${row.model.total.toFixed(3)} (${Math.round(100 * row.model.total / rows[0].model.total)}% of full)  compactions ${row.compactions ?? 0}  ${Object.entries(row.byKind).map(([kind, [a, b]]) => `${kind} ${a}/${b}`).join(' ')}`);
  }
  const spent = [...load('answers.json', []), ...load('warm.json', [])].reduce((sum, row) => sum + weighted(row.usage), 0) + Object.values(chains).flatMap((state) => state.compactions).reduce((sum, item) => sum + weighted(item.usage), 0);
  console.log(`spent, at Haiku prices: $${spent.toFixed(2)}`);
  save('report.json', rows);
}

/** Every conversation's answers together (--convs a,b,c, 8-character ids; --model): per threshold and
 * condition, accuracy by category, each probe paired with its own full-context answers (the mean of
 * the baseline's samples), the drop with a 95% interval (a paired bootstrap, probes resampled within
 * their conversation) and an exact McNemar p against the first baseline sample; cost against full
 * context, modelled for running the conversation and measured for the probes themselves; recall's
 * time and what it attached; how often the tools were used. Categories: recent (the last quarter of
 * the conversation by size), older, decision/identifier (decisions, rejections, identifiers, wherever
 * they are), continuity (where the work stands at the end). */
function grid() {
  const convs = option('--convs').split(',');
  const RECENT_SHARE = 0.25;
  const B = 4000;
  const probesBy = {};
  const data = convs.map((dir) => {
    const seg = loadFrom(dir, 'segment.json');
    const sizes = seg.turns.map(turnBytes);
    const total = sizes.reduce((sum, size) => sum + size, 0);
    const after = (to) => sizes.slice(to).reduce((sum, size) => sum + size, 0) / total;
    const list = graded(loadFrom(dir, 'probes.json', []), dir).map((probe) => {
      const cats = ['all'];
      if (probe.kind === 'continuity') cats.push('continuity');
      else cats.push(after(probe.stretch[1]) <= RECENT_SHARE ? 'recent' : 'older');
      if (['decision', 'rejection', 'identifier'].includes(probe.kind)) cats.push('decision/id', ...(cats.includes('recent') ? ['recent d/id'] : []));
      if (probe.kind === 'fact' || probe.kind === 'identifier') cats.push(probe.kind);
      if (probe.kind === 'decision' || probe.kind === 'rejection') cats.push('decision');
      return { ...probe, cats, uid: `${dir}:${probe.id}` };
    });
    for (const probe of list) probesBy[probe.uid] = probe;
    const answers = loadFrom(dir, tagged('answers.json'), []).filter((row) => !row.error);
    const keyOf = Object.fromEntries(list.map((probe) => [probe.id, probe.answer]));
    const judged = judgedIn(dir);
    for (const row of answers) { row.strict = keyOf[row.probe] ? grade(row.answer, keyOf[row.probe]) : undefined; row.correct = keyOf[row.probe] ? verdict(judged, row, keyOf[row.probe]) : undefined; }
    return { dir, seg, list, answers, chains: loadFrom(dir, tagged('chains.json'), {}), fixed: loadFrom(dir, 'overhead.json')?.tokens ?? 0, haikuAnswers: MODEL === 'haiku' ? answers : loadFrom(dir, 'answers.json', []) };
  });
  // Per probe: the baseline's mean score, its first sample, and each cell's answer.
  const base = {};
  const base0 = {};
  const base1 = {};
  const cells = {};
  const costs = {};
  for (const { dir, answers } of data) {
    for (const row of answers) {
      if (row.correct === undefined) continue;
      const uid = `${dir}:${row.probe}`;
      const value = row.correct ? 1 : 0;
      if (row.condition === 'baseline') {
        (base[uid] ??= []).push(value);
        if (row.sample === 0) base0[uid] = value;
        if (row.sample === 1) base1[uid] = value;
      } else if (row.sample === 0) {
        (cells[`${row.condition}|${row.threshold}`] ??= {})[uid] = value;
      }
      const cell = row.condition === 'baseline' ? 'baseline|0' : `${row.condition}|${row.threshold}`;
      (costs[cell] ??= { sum: 0, n: 0, tools: 0 });
      costs[cell].sum += weighted(row.usage); costs[cell].n += 1; costs[cell].tools += (row.turns ?? 1) > 1 ? 1 : 0;
    }
  }
  const mean = (list) => list.reduce((sum, value) => sum + value, 0) / list.length;
  const baseMean = Object.fromEntries(Object.entries(base).map(([uid, list]) => [uid, mean(list)]));
  // Seeded, so a report is the same each time it is made.
  let seed = 12345;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const paired = (scores, reference, category) => {
    const uids = Object.keys(scores).filter((uid) => reference[uid] !== undefined && probesBy[uid]?.cats.includes(category));
    if (!uids.length) return undefined;
    const byConv = {};
    for (const uid of uids) (byConv[uid.split(':')[0]] ??= []).push(scores[uid] - reference[uid]);
    const all = Object.values(byConv).flat();
    const draws = [];
    for (let draw = 0; draw < B; draw += 1) {
      let sum = 0;
      for (const diffs of Object.values(byConv)) for (let index = 0; index < diffs.length; index += 1) sum += diffs[Math.floor(random() * diffs.length)];
      draws.push(sum / all.length);
    }
    draws.sort((left, right) => left - right);
    return { n: uids.length, acc: mean(uids.map((uid) => scores[uid])), ref: mean(uids.map((uid) => reference[uid])), diff: mean(all), low: draws[Math.floor(0.025 * B)], high: draws[Math.floor(0.975 * B)] };
  };
  // Exact McNemar (two-sided) on the discordant pairs against the first baseline sample.
  const mcnemar = (scores, category) => {
    let lost = 0;
    let gained = 0;
    for (const [uid, value] of Object.entries(scores)) {
      if (base0[uid] === undefined || !probesBy[uid]?.cats.includes(category)) continue;
      if (base0[uid] === 1 && value === 0) lost += 1;
      if (base0[uid] === 0 && value === 1) gained += 1;
    }
    const n = lost + gained;
    if (!n) return { lost, gained, p: 1 };
    let tail = 0;
    let choose = 1;
    for (let k = 0; k <= n; k += 1) { if (k > 0) choose = choose * (n - k + 1) / k; if (k <= Math.min(lost, gained)) tail += choose; }
    return { lost, gained, p: Math.min(1, 2 * tail / 2 ** n) };
  };
  const scale = (dir) => {
    const one = data.find((item) => item.dir === dir);
    const first = one.haikuAnswers.find((row) => row.condition === 'baseline');
    const probeFixed = loadFrom(dir, 'probe-overhead.json')?.tokens ?? 0;
    const bytes = one.seg.turns.reduce((sum, turn) => sum + turnBytes(turn), 0);
    return first ? (first.usage.input + first.usage.write + first.usage.read - probeFixed) / bytes : 0.36;
  };
  // A ledger condition carries its ledger after each compaction as the summary is carried, and pays its extraction calls.
  const modelled = (threshold, condition = '') => {
    let cost = 0;
    let full = 0;
    for (const item of data) {
      const k = scale(item.dir);
      full += modelledCost(item.seg, undefined, item.fixed, k).total;
      let chainState = threshold ? item.chains[threshold] : undefined;
      const stretches = condition.includes('ledger') && chainState ? loadFrom(item.dir, 'ledger.json', {})[threshold] ?? [] : [];
      if (stretches.length) {
        chainState = { ...chainState, compactions: chainState.compactions.map((cut, index) => ({ ...cut, summaryChars: cut.summaryChars + ledgerText(stretches.slice(0, index + 1)).length })) };
        cost += stretches.reduce((sum, stretch) => sum + weighted(stretch.usage), 0);
      }
      cost += modelledCost(item.seg, chainState, item.fixed, k).total;
    }
    return cost / full;
  };
  // fact, identifier and decision (with rejection) are the pass rule's kinds.
  const CATS = ['fact', 'identifier', 'decision', 'continuity', 'recent', 'older', 'all'];
  const PASS_KINDS = ['fact', 'identifier', 'decision'];
  const fmt = (cell) => (cell ? `${(100 * cell.acc).toFixed(0).padStart(3)}% ${(100 * cell.diff >= 0 ? '+' : '')}${(100 * cell.diff).toFixed(1)} [${(100 * cell.low).toFixed(1)},${(100 * cell.high).toFixed(1)}]`.padEnd(26) : '-'.padEnd(26));
  const rows = [];
  console.log(`model ${MODEL}; conversations ${convs.join(', ')}; probes ${Object.keys(probesBy).length}; categories: ${CATS.map((cat) => `${cat} ${Object.values(probesBy).filter((probe) => probe.cats.includes(cat)).length}`).join(', ')}`);
  console.log(`cell             ${CATS.map((cat) => cat.padEnd(26)).join('')}cost(run) cost(probe) tools  n`);
  const fullRow = Object.fromEntries(CATS.map((cat) => [cat, paired(baseMean, baseMean, cat)]));
  const noise = Object.fromEntries(CATS.map((cat) => [cat, paired(base1, base0, cat)]));
  const probeCost = (cell) => costs[cell] ? costs[cell].sum / costs[cell].n : undefined;
  console.log(`${'full'.padEnd(17)}${CATS.map((cat) => fmt(fullRow[cat])).join('')}${'100%'.padEnd(10)}${'100%'.padEnd(12)}`);
  console.log(`${'full s1 vs s0'.padEnd(17)}${CATS.map((cat) => fmt(noise[cat])).join('')}   (the noise floor: the same context asked twice)`);
  rows.push({ cell: 'full', ...fullRow }, { cell: 'noise', ...noise });
  const thresholdList = [...new Set(Object.keys(cells).map((key) => Number(key.split('|')[1])))].sort((left, right) => right - left);
  for (const threshold of thresholdList) {
    const conditionList = [...new Set(Object.keys(cells).map((key) => key.split('|')[0]))].filter((name) => name !== 'trace').sort((left, right) => (left === 'compact' ? -1 : right === 'compact' ? 1 : left.localeCompare(right)));
    for (const condition of conditionList) {
      const scores = cells[`${condition}|${threshold}`];
      if (!scores) continue;
      const stats = Object.fromEntries(CATS.map((cat) => [cat, paired(scores, baseMean, cat)]));
      const tests = Object.fromEntries(CATS.map((cat) => [cat, mcnemar(scores, cat)]));
      const run = modelled(threshold, condition);
      const probe = probeCost(`${condition}|${threshold}`) / probeCost('baseline|0');
      const tools = costs[`${condition}|${threshold}`].tools / costs[`${condition}|${threshold}`].n;
      // The pass rule: on each kind the paired 95% interval's lower bound within 3 points of full
      // context, and continuity not lower than full context's on the same probes.
      const holds = PASS_KINDS.every((cat) => stats[cat] && stats[cat].low >= -0.03) && Boolean(stats.continuity) && stats.continuity.diff >= 0;
      rows.push({ cell: `${threshold / 1000}k ${condition}`, threshold, condition, ...stats, tests, run, probe, tools, holds });
      console.log(`${`${threshold / 1000}k ${condition}`.padEnd(17)}${CATS.map((cat) => fmt(stats[cat])).join('')}${`${Math.round(100 * run)}%`.padEnd(10)}${`${Math.round(100 * probe)}%`.padEnd(12)}${`${Math.round(100 * tools)}%`.padEnd(7)}${Object.keys(scores).length}${holds ? '  HOLDS' : ''}`);
    }
  }
  console.log('McNemar exact p, fact / identifier / decision / all, against baseline sample 0 (lost-gained):');
  for (const row of rows.filter((item) => item.tests)) console.log(`  ${row.cell.padEnd(16)} ${[...PASS_KINDS, 'all'].map((cat) => `${cat} ${row.tests[cat].lost}-${row.tests[cat].gained} p=${row.tests[cat].p.toFixed(3)}`).join('  ')}`);
  // Recall: the time it added and what it attached, per condition (this eval's rows carry their time).
  const recallRows = data.flatMap(({ dir }) => lines(dir, 'recall-log.jsonl').filter((row) => row.ms !== undefined && (row.model ?? 'haiku') === MODEL).map((row) => ({ ...row, dir })));
  const pct = (list, share) => list[Math.min(list.length - 1, Math.floor(share * list.length))];
  for (const condition of [...new Set(recallRows.map((row) => row.condition))]) {
    const some = recallRows.filter((row) => row.condition === condition);
    if (!some.length) continue;
    const ms = some.map((row) => row.ms).sort((left, right) => left - right);
    const attached = some.filter((row) => row.hits.length);
    const tokens = attached.map((row) => row.chars * scale(row.dir)).sort((left, right) => left - right);
    const skipped = some.reduce((all, row) => (row.skipped ? { ...all, [row.skipped]: (all[row.skipped] ?? 0) + 1 } : all), {});
    const byMeaning = attached.filter((row) => row.hits.some((hit) => hit.includes(':meaning:'))).length;
    console.log(`recall (${condition}): ${some.length} turns; added ms median ${pct(ms, 0.5)} p95 ${pct(ms, 0.95)} max ${ms.at(-1)}; attached on ${attached.length} (${Math.round(100 * attached.length / some.length)}%), ${byMeaning} by meaning; attached tokens median ${Math.round(pct(tokens, 0.5) ?? 0)} p95 ${Math.round(pct(tokens, 0.95) ?? 0)} max ${Math.round(tokens.at(-1) ?? 0)}; skipped ${JSON.stringify(skipped)}`);
  }
  const toolRows = data.flatMap(({ dir }) => lines(dir, `tool-log${TAG}.jsonl`));
  for (const condition of [...new Set(toolRows.map((row) => String(row.at).split('|')[0]))]) {
    const some = toolRows.filter((row) => String(row.at).split('|')[0] === condition);
    const ms = some.map((row) => row.ms).sort((left, right) => left - right);
    console.log(`  tool calls (${condition}): ${some.length}; ms median ${pct(ms, 0.5)} p95 ${pct(ms, 0.95)}`);
  }
  if (toolRows.length) {
    const byName = toolRows.reduce((all, row) => ({ ...all, [row.name]: (all[row.name] ?? 0) + 1 }), {});
    const ms = toolRows.map((row) => row.ms).sort((left, right) => left - right);
    console.log(`tool calls: ${toolRows.length} ${JSON.stringify(byName)}; ms median ${pct(ms, 0.5)} p95 ${pct(ms, 0.95)}; result chars median ${pct(toolRows.map((row) => row.chars).sort((left, right) => left - right), 0.5)}`);
  }
  const spent = data.reduce((sum, { dir, answers }) => sum + answers.reduce((all, row) => all + weighted(row.usage), 0)
    + loadFrom(dir, tagged('warm.json'), []).reduce((all, row) => all + weighted(row.usage), 0)
    + Object.values(loadFrom(dir, tagged('chains.json'), {})).flatMap((state) => state.compactions).reduce((all, item) => all + (weighted(item.usage) || (item.context + 5 * item.summaryChars / 4) / 1e6), 0)
    + (MODEL === 'haiku' ? Object.values(loadFrom(dir, 'ledger.json', {})).flat().reduce((all, item) => all + weighted(item.usage), 0) : 0)
    + (MODEL === 'haiku' ? lines(dir, 'probe-gen.jsonl').reduce((all, row) => all + weighted(row.usage), 0) : 0), 0);
  console.log(`spent (tokens at the Haiku weights: input 1, write 1.25, read 0.1, output 5 per million): $${spent.toFixed(2)}`);
  for (const condition of [...new Set(rows.filter((row) => row.condition).map((row) => row.condition))]) {
    const lowest = rows.filter((row) => row.holds && row.condition === condition).map((row) => row.threshold).sort((left, right) => left - right)[0];
    console.log(`lowest threshold where ${condition} holds: ${lowest ? `${lowest / 1000}k` : 'none'}`);
  }
  writeFileSync(join(evalsRoot, `grid${TAG}.json`), `${JSON.stringify(rows, null, 1)}\n`);
}

/** A model's verdict on every answer not judged yet (each answers*.json and trace-answers*.json),
 * one call per probe: its question, the key phrases, the passage they were copied from, and every
 * distinct answer given to it. Paraphrase counts; a different value, a missing key fact, or "I don't
 * know" does not. judge.json, by probe and answer text; grid and analyze read it. */
async function judge() {
  const { turns } = segment();
  const list = graded(load('probes.json'));
  const judged = load(JUDGE_FILE, {});
  const files = readdirSync(evalDir).filter((name) => /^(trace-)?answers.*\.json$/.test(name) && !name.includes('-v1'));
  const rows = files.flatMap((name) => load(name, [])).filter((row) => !row.error && typeof row.answer === 'string');
  const plainText = (turn) => `USER: ${turn.user}\nASSISTANT: ${typeof turn.assistant === 'string' ? turn.assistant : ''}`;
  const jobs = list.map((probe) => {
    const fresh = [...new Set(rows.filter((row) => row.probe === probe.id && judged[answerHash(probe.id, row.answer)] === undefined).map((row) => row.answer))];
    return { probe, fresh };
  }).filter((job) => job.fresh.length);
  console.log(`judging ${jobs.reduce((sum, job) => sum + job.fresh.length, 0)} answers over ${jobs.length} probes with ${JUDGE_MODEL}`);
  let spent = 0;
  await pool(jobs, async ({ probe, fresh }) => {
    const body = turns.slice(probe.stretch[0], probe.stretch[1]).map(plainText).join('\n\n');
    // Around each key phrase in its stretch, so the judge sees what the phrase meant.
    const low = body.toLowerCase();
    const spans = probe.answer.map((key) => { const at = low.indexOf(key.toLowerCase()); return at < 0 ? '' : body.slice(Math.max(0, at - 1500), at + key.length + 1500); }).filter(Boolean);
    const passage = (spans.length ? spans.join('\n...\n') : body.slice(0, 6000)).slice(0, 12_000);
    for (let start = 0; start < fresh.length; start += 25) {
      const batch = fresh.slice(start, start + 25);
      const prompt = 'You grade answers to a memory question about a past conversation. Each answer is CORRECT only if it states, in substance, every key fact below as the passage means it; '
        + 'paraphrase and extra detail are fine, but a different number, name, identifier or value, a missing key fact, a contradiction, or a refusal or "I do not know" is WRONG. Judge each answer on its own.\n'
        + (JUDGE_FILE === 'judge.json' ? '' : 'An answer that commits to the right value is CORRECT even with a caveat or hedge ("I believe", "if I recall"). It is WRONG if it declines, names the right value only as one of several candidates without choosing it, or attributes it to a different thing. '
          + 'Equivalent forms of a key count: a full path for a ~/ or relative path, a short hash for a longer one or the reverse, a number written differently, a faithful paraphrase of a phrase.\n')
        + '\n'
        + `<passage>\n${passage}\n</passage>\n\nQuestion: ${probe.question}\nKey facts (quoted from the passage): ${probe.answer.map((key) => JSON.stringify(key)).join('; ')}\n\n`
        + batch.map((answer, index) => `<answer n="${index + 1}">\n${answer.slice(0, 2000)}\n</answer>`).join('\n')
        + `\n\nReturn JSON only: an array of ${batch.length} booleans, the verdicts in order (true = correct).`;
      const result = await claude([], { input: prompt, model: JUDGE_MODEL });
      spent += weighted(result.usage) * (JUDGE_MODEL === 'haiku' ? 1 : 3);
      appendFileSync(saved('judge-log.jsonl'), `${JSON.stringify({ probe: probe.id, n: batch.length, usage: result.usage, costUsd: result.costUsd, error: result.error })}\n`);
      let verdicts;
      // The last flat array of the right length: a judge sometimes corrects itself after a first try.
      for (const match of (result.text ?? '').matchAll(/\[[^[\]]*\]/g)) { try { const value = JSON.parse(match[0]); if (Array.isArray(value) && value.length === batch.length) verdicts = value; } catch { /* not JSON */ } }
      if (!Array.isArray(verdicts) || verdicts.length !== batch.length || verdicts.some((value) => typeof value !== 'boolean')) { console.log(`  ${probe.id}: no usable verdicts (${(result.error ?? result.text).slice(0, 160)})`); continue; }
      const all = load(JUDGE_FILE, {});
      batch.forEach((answer, index) => { all[answerHash(probe.id, answer)] = verdicts[index]; });
      save(JUDGE_FILE, all);
      console.log(`  ${probe.id}: ${verdicts.filter(Boolean).length}/${batch.length} correct`);
    }
  });
  console.log(`judge spend about $${spent.toFixed(2)} (Haiku-equivalent prices x3 for Sonnet)`);
}

/** Where the message holding `keys` ranks by meaning for `query`, among the messages before
 * `boundary`, against the gate semanticMatches applies (MIN_SIMILARITY 0.62, median + LIFT 0.2). */
let vectorRecords;
/** Recall alone, no model: for each graded probe from before the boundary, whether what recall
 * attaches has the key, under each knob set (EVAL_RECALL_SETS, {name: {env}}; "shipped" is {}).
 * Each set is asked twice, the first pass warming the view and embedder; the second is reported.
 * Writes retrieval.json (per set and threshold: probes, attached, key attached, chars, ms). */
async function retrieval() {
  const { turns, opens, messageEnd } = segment();
  const sets = { shipped: {}, ...JSON.parse(process.env.EVAL_RECALL_SETS ?? '{}') };
  const list = graded(load('probes.json')).filter((probe) => probe.kind !== 'continuity');
  const words = (text) => plain(text).split(/[^a-z0-9.]+/).filter((word) => word.length > 2);
  const nearly = (text, keys) => keys.every((key) => { const want = words(key); const have = new Set(words(text)); return want.length && want.filter((word) => have.has(word)).length / want.length >= 0.6; });
  await storedSession(messageEnd);
  const chains = load(tagged('chains.json'), {});
  const results = load('retrieval.json', {});
  for (const threshold of thresholds) {
    const state = chains[threshold];
    if (!state?.summary) continue;
    const boundary = opens[state.from];
    const lastAssistant = [...turns.slice(state.from)].reverse().find((turn) => typeof turn.assistant === 'string' && turn.assistant.trim())?.assistant;
    const before = list.filter((probe) => opens[probe.stretch[1]] !== undefined ? opens[probe.stretch[1]] <= boundary : false);
    for (const [name, env] of Object.entries(sets)) {
      const rows = [];
      for (const pass of [0, 1]) {
        for (const probe of before) {
          const request = `${TOOL_PROBE_PREFIX}${probe.question}`;
          const started = Date.now();
          const found = await withEnv(env, () => clik.recall({ sessionId: conv, query: request, boundary, hasHindsight: true, context: lastAssistant }));
          if (pass) rows.push({ probe: probe.id, kind: probe.kind, ms: Date.now() - started, attached: found.hits.length, key: Boolean(found.note && (grade(found.note, probe.answer) || nearly(found.note, probe.answer))), chars: found.note?.length ?? 0, skipped: found.skipped });
        }
      }
      const ms = rows.map((row) => row.ms).sort((left, right) => left - right);
      const summary = { probes: rows.length, attached: rows.filter((row) => row.attached).length, key: rows.filter((row) => row.key).length, chars: Math.round(rows.reduce((sum, row) => sum + row.chars, 0) / Math.max(1, rows.length)), msMedian: ms[Math.floor(ms.length / 2)], msP95: ms[Math.floor(0.95 * ms.length)], timeouts: rows.filter((row) => row.skipped === 'timeout').length, rows };
      (results[threshold] ??= {})[name] = summary;
      save('retrieval.json', results);
      console.log(`retrieval ${threshold / 1000}k ${name}: key in ${summary.key}/${summary.probes}, attached ${summary.attached}, chars ${summary.chars}, ms ${summary.msMedian}/${summary.msP95}, timeouts ${summary.timeouts}`);
    }
  }
}

async function meaningGate(query, keys, boundary) {
  const { turns, opens } = segment();
  vectorRecords ??= readFileSync(saved('vectors.jsonl'), 'utf8').split('\n').slice(1).filter(Boolean).map((line) => JSON.parse(line)).map((record) => {
    const bytes = Buffer.from(record.vector, 'base64');
    const values = Float32Array.from(bytes, (value) => (value << 24 >> 24) * record.scale);
    const norm = Math.hypot(...values) || 1;
    return { message: record.message, unit: values.map((value) => value / norm) };
  });
  const vector = await clik.queryVector(query, 15_000);
  if (!vector) return { gate: 'no embedder' };
  const best = new Map();
  for (const record of vectorRecords) {
    if (record.message >= boundary || record.unit.length !== vector.vector.length) continue;
    let score = 0;
    for (let index = 0; index < record.unit.length; index += 1) score += record.unit[index] * vector.vector[index];
    if (!(best.get(record.message) >= score)) best.set(record.message, score);
  }
  const ranked = [...best.entries()].sort((left, right) => right[1] - left[1]);
  const median = ranked.length >= 32 ? ranked[Math.floor(ranked.length / 2)][1] : -1;
  const min = Math.max(0.62, median + 0.2);
  const holding = new Set();
  turns.forEach((turn, at) => {
    const text = `${turn.user}\n${typeof turn.assistant === 'string' ? turn.assistant : ''}\n${JSON.stringify(turn.tools ?? '')}`;
    if (keys.every((key) => plain(text).includes(plain(key)))) for (let message = opens[at]; message < (opens[at + 1] ?? opens[at] + 1); message += 1) holding.add(message);
  });
  const rank = ranked.findIndex(([message]) => holding.has(message));
  return { gate: { top: Number(ranked[0]?.[1]?.toFixed(3)), median: Number(median.toFixed(3)), min: Number(min.toFixed(3)), keyScore: rank < 0 ? undefined : Number(ranked[rank][1].toFixed(3)), keyRank: rank < 0 ? undefined : rank + 1, passing: ranked.filter(([, score]) => score >= min).length } };
}

/** Why each answerable probe failed (baseline right at least once; this cell wrong, sample 0), for
 * the compact, recall and hindsight cells of --thresholds. Where the key was: in the verbatim tail,
 * in the compaction summary, in what recall attaches (asked again with its own budget, and with
 * 15 s, which is what it could find given time). Hindsight failures that used a tool are asked once
 * more with each tool result kept (tool-trace.jsonl), to see whether a tool returned the key.
 * A failure whose answer has most words of each key is flagged as a possible grading error.
 * Writes failures.json. */
async function analyze() {
  const { turns, opens, messageEnd } = segment();
  const list = graded(load('probes.json'));
  const byId = Object.fromEntries(list.map((probe) => [probe.id, probe]));
  const answers = load(tagged('answers.json'), []).filter((row) => !row.error && byId[row.probe]);
  const base = {};
  const judged = judgedIn();
  for (const row of answers.filter((item) => item.condition === 'baseline')) (base[row.probe] ??= []).push(verdict(judged, row, byId[row.probe].answer) ? 1 : 0);
  const chains = load(tagged('chains.json'), {});
  const textOf = (part) => part.map((turn) => `${turn.providerNote ?? ''}\n${turn.user}\n${typeof turn.assistant === 'string' ? turn.assistant : ''}\n${JSON.stringify([turn.parts, turn.tools]).replace(/\\n/g, ' ').replace(/\\"/g, '"')}`).join('\n');
  const words = (text) => plain(text).split(/[^a-z0-9.]+/).filter((word) => word.length > 2);
  const nearly = (answer, keys) => keys.every((key) => { const want = words(key); const have = new Set(words(answer)); return want.length && want.filter((word) => have.has(word)).length / want.length >= 0.6; });
  await storedSession(messageEnd);
  const wanted = new Set(thresholds);
  const failures = [];
  const traceJobs = {};
  for (const row of answers) {
    if (row.condition === 'baseline' || row.sample !== 0 || !wanted.has(row.threshold) || verdict(judged, row, byId[row.probe].answer)) continue;
    const probe = byId[row.probe];
    const keys = probe.answer;
    const baseScore = (base[row.probe] ?? []).reduce((sum, value) => sum + value, 0) / Math.max(1, (base[row.probe] ?? []).length);
    const state = chains[row.threshold];
    const from = state?.from ?? 0;
    const item = { threshold: row.threshold, condition: row.condition, probe: row.probe, kind: probe.kind, baseScore, turns: row.turns ?? 1,
      inSummary: Boolean(state?.summary && (grade(state.summary, keys) || nearly(state.summary, keys))), inVerbatim: grade(textOf(turns.slice(from)), keys), inStretch: grade(textOf(turns.slice(probe.stretch[0], probe.stretch[1])), keys),
      nearly: nearly(row.answer, keys), question: probe.question, keys, answer: row.answer };
    if (row.condition !== 'compact' && !item.inVerbatim && state?.summary) {
      const request = `${row.condition === 'hindsight' ? TOOL_PROBE_PREFIX : PROBE_PREFIX}${probe.question}`;
      const input = { sessionId: conv, query: request, boundary: opens[from], hasHindsight: row.condition === 'hindsight' };
      const now = await clik.recall(input);
      const wide = await clik.recall({ ...input, budgetMs: 15_000 });
      Object.assign(item, { attached: Boolean(now.note && (grade(now.note, keys) || nearly(now.note, keys))), attachedAny: Boolean(now.note), skipped: now.skipped, retrievable: Boolean(wide.note && (grade(wide.note, keys) || nearly(wide.note, keys))), wideAny: Boolean(wide.note) });
      if (row.condition === 'hindsight' && item.turns > 1) (traceJobs[row.threshold] ??= new Set()).add(row.probe);
      Object.assign(item, await meaningGate(request, keys, opens[from]), { bare: (await meaningGate(probe.question, keys, opens[from])).gate });
    }
    failures.push(item);
  }
  // Hindsight again for the failures that used a tool, every tool result kept.
  const trace = saved(`tool-trace${TAG}.jsonl`);
  for (const [threshold, only] of Object.entries(traceJobs)) {
    const state = chains[threshold];
    const tail = turns.slice(state.from).map((turn, at) => (at === 0 ? { ...turn, providerNote: state.summary } : turn));
    const id = await writeThread(tail);
    const session = await storedSession(messageEnd);
    const contents = await clik.topicContents(session, true);
    await askAll(id, 'trace', Number(threshold), async (probe) => {
      const request = `${TOOL_PROBE_PREFIX}${probe.question}`;
      const found = await clik.recall({ sessionId: conv, query: request, boundary: opens[state.from], hasHindsight: true });
      return `${contents ? `${clik.wrapResourceNote(contents)}\n\n` : ''}${request}${found.note ? `\n\n${found.note}` : ''}`;
    }, (probe) => toolArgs(`trace|${threshold}|${probe.id}`, trace, true), { file: tagged('trace-answers.json'), only });
  }
  const calls = existsSync(trace) ? readFileSync(trace, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
  const retried = Object.fromEntries(load(tagged('trace-answers.json'), []).map((row) => [`${row.threshold}|${row.probe}`, row]));
  for (const item of failures) {
    if (item.condition !== 'hindsight' || item.turns <= 1 || item.inVerbatim) continue;
    const mine = calls.filter((call) => call.at === `trace|${item.threshold}|${item.probe}`);
    const again = retried[`${item.threshold}|${item.probe}`];
    Object.assign(item, { traceCalls: mine.map((call) => `${call.name}(${JSON.stringify(call.args)})`), toolReturned: mine.some((call) => grade(call.text ?? '', item.keys) || nearly(call.text ?? '', item.keys)), traceCorrect: again ? verdict(judged, again, item.keys) : undefined, traceTurns: again?.turns });
  }
  for (const item of failures) {
    item.bucket = item.baseScore === 0 ? 'unanswerable at full context (probe or grader)'
      : item.inVerbatim ? 'in the verbatim context, missed'
      : item.inSummary ? 'in the summary, missed'
      : item.condition === 'compact' ? 'lost in compaction'
      : item.attached ? 'attached by recall, ignored'
      : item.condition === 'hindsight' && item.toolReturned ? 'tool returned it, ignored'
      : item.retrievable ? 'recall finds it with more time, not attached'
      : item.condition === 'hindsight' && item.turns <= 1 ? 'not retrieved, no tool call'
      : item.condition === 'hindsight' ? 'not retrieved, tool called and missed'
      : 'not retrieved';
  }
  save(tagged('failures.json'), failures);
  const count = {};
  for (const item of failures) { const key = `${item.condition}|${item.bucket}`; count[key] = (count[key] ?? 0) + 1; }
  console.log(JSON.stringify(count, null, 1));
}

/** Running the stretch at `chain`'s threshold (or with nothing compacted): one model call per
 * CALL_STEP tokens of growth, each reading the context from cache and writing what is new; a
 * compaction reads its context and writes its summary; the first call after one writes the summary. */
function modelledCost(seg, chainState, fixed, scale) {
  if (!seg) return { perCall: 0, total: 0 };
  const CALL_STEP = 2000;
  const tokens = seg.turns.map((turn) => Math.ceil(turnBytes(turn) * scale));
  const cuts = new Map((chainState?.compactions ?? []).map((item) => [item.to, item]));
  let context = fixed;
  let cost = 0;
  let calls = 0;
  tokens.forEach((size, at) => {
    const cut = cuts.get(at);
    if (cut) {
      cost += (context * PRICE.read + (cut.summaryChars / 4) * PRICE.output) / 1e6;
      context = fixed + Math.ceil(cut.summaryChars / 4);
      cost += (Math.ceil(cut.summaryChars / 4) * PRICE.write) / 1e6;
    }
    for (let left = size; left > 0; left -= CALL_STEP) {
      const added = Math.min(CALL_STEP, left);
      cost += (context * PRICE.read + added * PRICE.write) / 1e6;
      context += added;
      calls += 1;
    }
  });
  return { perCall: cost / Math.max(1, calls), total: cost, calls };
}

try {
  if (phase === 'prepare') await prepare();
  else if (phase === 'probes') await probes();
  else if (phase === 'baseline') { await probeOverhead(); await baseline(); }
  else if (phase === 'chain') await chain();
  else if (phase === 'analyze') await analyze();
  else if (phase === 'judge') await judge();
  else if (phase === 'retrieval') await retrieval();
  else { console.error(`unknown phase ${phase}`); process.exitCode = 2; }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  // Recall's own lifecycle events (turn.recall: its time, what it attached), kept with the eval.
  try {
    const events = readFileSync(clik.lifecycleLogPath(), 'utf8').split('\n').filter((line) => line.includes('"turn.recall'));
    if (events.length) appendFileSync(saved('lifecycle-recall.jsonl'), `${events.join('\n')}\n`);
  } catch { /* none */ }
  // The embedder this run started (its record is in this sandbox): its supervisor and server, each
  // checked by command line, one process each; never a group.
  const record = join(modelsHome, 'servers', 'clikcode-embeddings', 'supervisor.json');
  if (existsSync(record)) {
    const { supervisorPid, serverPid } = JSON.parse(readFileSync(record, 'utf8'));
    for (const [pid, name] of [[supervisorPid, 'local-model-supervisor'], [serverPid, 'llama-server']]) {
      try { if (pid && readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(name)) process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
    }
  }
  process.exit(process.exitCode ?? 0);
}
