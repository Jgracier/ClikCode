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
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const phase = argv[0];
const option = (name, fallback) => { const at = argv.indexOf(name); return at > 0 ? argv[at + 1] : fallback; };
const conv = option('--conv');
const thresholds = option('--thresholds', '150,100,80,60,40').split(',').map((value) => Number(value) * 1000);
const samples = Number(option('--samples', '1'));
const MODEL = 'haiku';
/** The conversation stretch: about this many tokens in context with the system prompt. */
const SEGMENT_TOKENS = Number(option('--segment', '150')) * 1000;
/** $ per million tokens, Claude Haiku 4.5: input, 5-minute cache write, cache read, output. */
const PRICE = { input: 1, write: 1.25, read: 0.1, output: 5 };
const CONCURRENCY = 4;

if (!phase || !conv) { console.error('usage: node scripts/compaction-eval.mjs <prepare|probes|baseline|chain|report> --conv <id> --source <dir> --cred <file>'); process.exit(2); }
const realHome = process.env.EVAL_REAL_HOME ?? homedir();
const evalDir = join(realHome, '.clikcode', 'evals', 'compaction', conv.slice(0, 8));
mkdirSync(evalDir, { recursive: true });
const saved = (name) => join(evalDir, name);
const load = (name, fallback) => (existsSync(saved(name)) ? JSON.parse(readFileSync(saved(name), 'utf8')) : fallback);
const save = (name, value) => writeFileSync(saved(name), `${JSON.stringify(value, null, 1)}\n`);

if (phase === 'report') { report(); process.exit(0); }

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
      "export { claudeCompactSettings } from './src/turn/compaction.ts';",
      "export { conversationGroups, findConversation } from './src/search/conversations.ts';",
      "export { indexConversation } from './src/search/vectors.ts';",
      "export { embedderWithin } from './src/search/embedder.ts';",
      "export { AI_LOCAL_HARNESSES } from '@clikcode/router/ai-local-harness';",
    ].join('\n'),
    resolveDir: root, loader: 'ts',
  },
  bundle: true, platform: 'node', format: 'esm', outfile: bundle, logLevel: 'error',
  define: { __CLIKCODE_VERSION__: '"eval"' },
  banner: { js: "import { createRequire as __r } from 'node:module'; const require = __r(import.meta.url);" },
});
// The embedder's supervisor is found beside the code that starts it (local-models/lifecycle.ts).
if (!existsSync(join(home, 'local-model-supervisor.cjs'))) symlinkSync(join(root, 'dist', 'local-model-supervisor.cjs'), join(home, 'local-model-supervisor.cjs'));
const clik = await import(pathToFileURL(bundle).href);
const harness = clik.AI_LOCAL_HARNESSES.find((item) => item.command === 'claude');
const writer = clik.NATIVE_SESSION_STORES.claude.writer;
const settingsJson = JSON.stringify(clik.claudeCompactSettings());
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
function claude(args, { input, timeoutMs = 600_000 } = {}) {
  return new Promise((done) => {
    const child = spawn('claude', ['-p', '--model', MODEL, '--output-format', 'json', '--tools', '', '--strict-mcp-config', '--settings', settingsJson, ...args], { cwd: workspace, env: vendorEnv, stdio: ['pipe', 'pipe', 'pipe'] });
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
      const usage = json?.usage ?? {};
      done({
        code, text: json?.result ?? '', sessionId: json?.session_id, error: json?.is_error ? json?.result : code ? err.slice(-500) : undefined,
        usage: { input: usage.input_tokens ?? 0, write: usage.cache_creation_input_tokens ?? 0, read: usage.cache_read_input_tokens ?? 0, output: usage.output_tokens ?? 0 },
        costUsd: json?.total_cost_usd ?? 0,
      });
    });
  });
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

/** Probes: four early stretches and the end, asked of haiku once; kept when every answer is in the stretch. */
async function probes() {
  // --stretches 300-320,320-340: probes for these turns, added to the ones there are (the recent
  // part, which a lower threshold compacts and a higher one keeps).
  const extra = option('--stretches');
  if (load('probes.json') && !extra) { console.log('probes exist; delete probes.json to make new ones'); return; }
  const { turns } = segment();
  const text = (from, to) => turns.slice(from, to).map((turn) => `[turn ${turn.index}] USER: ${turn.user}\nASSISTANT: ${turn.assistant}`).join('\n\n');
  const n = turns.length;
  const stretches = extra ? extra.split(',').map((range) => range.split('-').map(Number))
    : [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7].map((a) => [a, a + 0.1]).map(([a, b]) => [Math.floor(a * n), Math.floor(b * n)]);
  const kept = [];
  const prefix = extra ? 'r' : 's';
  const ask = async (body, wanted) => {
    const prompt = `Below is part of a long working conversation between a user and an AI coding assistant.\n\n<conversation>\n${body.slice(0, 160_000)}\n</conversation>\n\n`
      + `Write ${wanted} to test whether someone who took part in the WHOLE conversation still remembers this part. Return JSON only: an array of objects {"kind", "question", "answer"}. `
      + '"answer" is an array of 1 to 3 short strings, each copied WORD FOR WORD from the conversation above, that any correct answer must contain: '
      + 'distinctive names, identifiers, file paths, numbers, commands, or two-to-four-word exact phrases; never a whole sentence, never common words, never the conversation\'s own markup. '
      + 'Each question must stand on its own (name the subject so it is unambiguous in a long conversation about many things) and must not contain its answer.';
    const result = await claude([], { input: prompt });
    if (result.error || !result.text) console.log(`probe call: ${result.error ?? 'no text'} (exit ${result.code})`);
    const match = /\[[\s\S]*\]/.exec(result.text);
    try { return JSON.parse(match?.[0] ?? '[]'); } catch { return []; }
  };
  const norm = (value) => value.toLowerCase().replace(/\s+/g, ' ');
  for (const [index, [from, to]] of stretches.entries()) {
    const body = text(from, to);
    const made = await ask(body, 'four questions: kind "fact", "decision" (what was decided and its reason), "rejection" (an option that was turned down), "identifier" (an exact name, path, id or value)');
    for (const probe of made) {
      if (!Array.isArray(probe.answer) || !probe.answer.length || !probe.question) continue;
      if (!probe.answer.every((key) => typeof key === 'string' && key.trim().length >= 3 && norm(body).includes(norm(key.trim())))) continue;
      if (probe.answer.some((key) => norm(probe.question).includes(norm(key)))) continue;
      kept.push({ id: `${prefix}${index}-${kept.length}`, stretch: [from, to], kind: probe.kind, question: probe.question, answer: probe.answer.map((key) => key.trim()) });
    }
  }
  if (extra) {
    save('probes-generated-recent.json', kept);
    console.log(`${kept.length} recent probes, in probes-generated-recent.json; merge the ones to keep into probes.json`);
    return;
  }
  const endBody = text(Math.max(0, n - 6), n);
  const end = await ask(endBody, 'two questions of kind "continuity": what the user asked for most recently, and what the assistant was doing or about to do last');
  for (const probe of end) {
    if (!Array.isArray(probe.answer) || !probe.answer.length || !probe.question) continue;
    if (!probe.answer.every((key) => typeof key === 'string' && key.trim().length >= 3 && norm(endBody).includes(norm(key.trim())))) continue;
    kept.push({ id: `end-${kept.length}`, stretch: [Math.max(0, n - 6), n], kind: 'continuity', question: probe.question, answer: probe.answer.map((key) => key.trim()) });
  }
  save('probes.json', kept);
  console.log(`${kept.length} probes kept`);
}

const PROBE_PREFIX = 'Answer from what you remember of this conversation; no tools. In one or two sentences, with exact names and values.\n\nQuestion: ';
/** Case, markdown, hyphens and spacing aside, every key in the answer. */
function plain(text) { return text.toLowerCase().replace(/[`*"]/g, '').replace(/[-_\s]+/g, ' '); }
function grade(answer, keys) { return keys.every((key) => plain(answer).includes(plain(key))); }

/** Every probe on thread `id`, as a forked resume; one first to warm the cache, then a few at a time. */
async function askAll(id, condition, threshold, promptFor) {
  const done = new Set(load('answers.json', []).map((row) => row.key));
  const jobs = [];
  for (const probe of load('probes.json')) {
    for (let sample = 0; sample < samples; sample += 1) {
      const key = `${condition}|${threshold}|${probe.id}|${sample}`;
      if (!done.has(key)) jobs.push({ key, probe, sample });
    }
  }
  const run = async ({ key, probe, sample }) => {
    const prompt = await promptFor(probe);
    const result = await claude(['--resume', id, '--fork-session'], { input: prompt });
    const row = { key, condition, threshold, probe: probe.id, kind: probe.kind, sample, correct: grade(result.text, probe.answer), usage: result.usage, costUsd: result.costUsd, promptChars: prompt.length, answer: result.text, ...(result.error ? { error: result.error } : {}) };
    if (result.error) { console.log(`  ${key}: ERROR ${result.error.slice(0, 200)}`); return; }
    const all = load('answers.json', []);
    all.push(row);
    save('answers.json', all);
    console.log(`  ${key}: ${row.correct ? 'ok ' : 'MISS'} read ${result.usage.read} write ${result.usage.write} in ${result.usage.input}`);
  };
  if (!jobs.length) return;
  // Claude Code caches up to a request's last message, so forks that differ only in their question
  // would each write the whole thread again. One plain turn on the thread first leaves an entry
  // ending at the thread; every fork reads it, as a conversation's next turn reads its last.
  const warm = await claude(['--resume', id], { input: 'Reply with OK only.' });
  const warms = load('warm.json', []);
  warms.push({ condition, threshold, usage: warm.usage, costUsd: warm.costUsd });
  save('warm.json', warms);
  console.log(`  warm ${condition}|${threshold}: read ${warm.usage.read} write ${warm.usage.write}`);
  while (jobs.length) await Promise.all(jobs.splice(0, CONCURRENCY).map(run));
}

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
  const chains = load('chains.json', {});
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
      save('chains.json', chains);
      console.log(`T=${threshold / 1000}k: compacted turns ${state.compactions.at(-1).from}-${to - 1} (${Math.round(context / 1000)}k) -> ${summary.length} chars`);
    }
    if (!state.summary) { console.log(`T=${threshold / 1000}k: the stretch fits; same as the baseline`); chains[threshold] = state; save('chains.json', chains); continue; }
    const tail = turns.slice(state.from).map((turn, at) => (at === 0 ? { ...turn, providerNote: state.summary } : turn));
    const id = await writeThread(tail);
    await askAll(id, 'compact', threshold, (probe) => `${PROBE_PREFIX}${probe.question}`);
    // Compaction + recall: the conversation is in ClikCode's store; the context holds what is after the boundary.
    const boundary = opens[state.from];
    const session = await storedSession(messageEnd);
    const contents = await clik.topicContents(session, false);
    await askAll(id, 'recall', threshold, async (probe) => {
      const request = `${PROBE_PREFIX}${probe.question}`;
      const found = await clik.recall({ sessionId: conv, query: request, boundary, hasHindsight: false, budgetMs: 5000 });
      const row = { key: `${threshold}|${probe.id}`, boundary, hits: found.hits.map((hit) => `${hit.position}:${hit.by}:${hit.score}`), skipped: found.skipped, chars: found.note?.length ?? 0 };
      appendFileSync(saved('recall-log.jsonl'), `${JSON.stringify(row)}\n`);
      return `${contents ? `${clik.wrapResourceNote(contents)}\n\n` : ''}${request}${found.note ? `\n\n${found.note}` : ''}`;
    });
  }
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
    const result = await clik.indexConversation(found.group, embedder, { deadline: Date.now() + 600_000 });
    console.log(`indexed with ${embedder.id}: ${JSON.stringify(result)}`);
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
  else { console.error(`unknown phase ${phase}`); process.exitCode = 2; }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
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
