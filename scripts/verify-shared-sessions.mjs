#!/usr/bin/env node
/** Does a harness's ACP agent and its one-shot CLI share one session store?
 *
 *   node scripts/verify-shared-sessions.mjs <harness> [--direction both|cli-to-acp|acp-to-cli]
 *     [--model <id>] [--mode ask|bypass|auto] [--cli-arg <arg>]...
 *     [--resume-id-prefix "<argv>"] [--discover "<argv>"] [--replay-only] [--link <~/path>]... [--copy <source>=<~/dest>]...
 *
 * The live proof behind a catalog entry's `acp.sharedSessions: true`, run
 * inside scripts/vendor-sandbox.mjs (never the user's own vendor history):
 *
 *   cli-to-acp  the CLI starts a thread the way ClikCode does (a minted id
 *               through turn.createIdPrefix, session.createSessionArgv, or the
 *               id its stream / session list reports) with a "remember this
 *               word" prompt; then ACP session/resume or session/load on that
 *               id, and session/prompt asks for the word.
 *   acp-to-cli  ACP session/new + the remember prompt; then the CLI's resume
 *               argv (nativeHarnessTurnArgv on the ACP id) asks for it.
 *
 * --replay-only is for an account without usage: the CLI records the prompt
 * before the vendor refuses it, and ACP session/load (no model call) shows
 * whether it replays it. Evidence the store is readable, never a pass.
 *
 * Each direction passes only when the answer contains the word, which is
 * fresh per run. Exit 0 only when every direction asked for passed.
 *
 * Sign-in: `--auth <harness>` (the catalog's authFiles) is always linked;
 * --link adds a home-relative file the catalog does not declare (Kiro's
 * `.local/share/kiro-cli/data.sqlite3`, Cursor's `.config/cursor/auth.json`).
 * --copy COPIES a file or directory into the sandbox home -- for a sign-in
 * kept in a ClikCode profile (`~/.clikcode/profiles/gemini/<id>/.gemini/oauth_creds.json=~/.gemini/oauth_creds.json`),
 * or for a store that also holds the user's chats, which must never be
 * linked (a link would write the test thread into it).
 * --cli-arg appends to the CLI argv (a vendor switch ClikCode does not send).
 * Prompts are tiny on purpose: these are paid accounts. */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const command = argv[0];
const option = (name) => { const at = argv.indexOf(name); return at > 0 ? argv[at + 1] : undefined; };
const options = (name) => argv.flatMap((value, index) => (value === name && argv[index + 1] !== undefined ? [argv[index + 1]] : []));
if (!command || command.startsWith('-')) {
  console.error('usage: node scripts/verify-shared-sessions.mjs <harness> [--direction both|cli-to-acp|acp-to-cli] [--model <id>] [--mode ask|bypass|auto] [--cli-arg <arg>]... [--link <~/path>]... [--copy <source>=<~/dest>]...');
  process.exit(2);
}

if (!process.env.VERIFY_SHARED_SESSIONS_INSIDE) {
  const result = spawnSync(process.execPath, [
    join(root, 'scripts', 'vendor-sandbox.mjs'), '--auth', command, ...options('--link').flatMap((path) => ['--link', path]),
    '--', process.execPath, fileURLToPath(import.meta.url), ...argv,
  ], { stdio: 'inherit', env: { ...process.env, VERIFY_SHARED_SESSIONS_INSIDE: '1', VERIFY_SHARED_SESSIONS_REAL_HOME: homedir() } });
  process.exit(result.status ?? 1);
}

// ------------------------------------------------- inside the sandbox ----
const home = process.env.HOME;
const realHome = process.env.VERIFY_SHARED_SESSIONS_REAL_HOME;
for (const pair of options('--copy')) {
  const at = pair.lastIndexOf('=');
  if (at < 0) { console.error(`--copy wants <source>=<~/dest>: ${pair}`); process.exit(2); }
  const from = pair.slice(0, at).replace(/^~/, realHome);
  // The shell may have expanded `=~/x` to the real home: the copy still lands in the sandbox.
  const dest = pair.slice(at + 1);
  const to = dest.startsWith(`${realHome}/`) ? join(home, dest.slice(realHome.length)) : dest.replace(/^~/, home);
  if (!to.startsWith(`${home}/`)) { console.error(`--copy: ${dest} is not under the home`); process.exit(2); }
  if (!existsSync(from)) { console.error(`--copy: ${from} does not exist`); process.exit(2); }
  mkdirSync(dirname(to), { recursive: true });
  // A copy replaces what --auth linked there: the link points at the user's own file.
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true, dereference: true });
}

const { build } = await import('esbuild');
const bundle = join(home, 'catalog.mjs');
await build({
  stdin: {
    contents: [
      "export { AI_LOCAL_HARNESSES, nativeHarnessTurnArgv, harnessAcpLaunch } from '@clikcode/router/ai-local-harness';",
      "export { parseHarnessLine, createStreamState } from './src/harness/events/adapters.ts';",
      "export { nativeTurnResult } from './src/harness/protocol/turn-result.ts';",
    ].join('\n'),
    resolveDir: root, loader: 'ts',
  },
  bundle: true, platform: 'node', format: 'esm', outfile: bundle, logLevel: 'error',
  define: { __CLIKCODE_VERSION__: '"verify"' },
  banner: { js: "import { createRequire as __r } from 'node:module'; const require = __r(import.meta.url);" },
});
const catalog = await import(pathToFileURL(bundle).href);
const harness = catalog.AI_LOCAL_HARNESSES.find((item) => item.command === command);
if (!harness) { console.error(`no harness named ${command}`); process.exit(2); }
if (!harness.acp || !harness.turn) { console.error(`${command} needs both an ACP agent and a one-shot CLI turn`); process.exit(2); }

// Trying a catalog change before making it: `--resume-id-prefix "--resume --session-id"`.
if (option('--resume-id-prefix')) harness.turn = { ...harness.turn, resumeIdPrefix: option('--resume-id-prefix').split(' ') };
const binary = harness.binary ?? harness.command;
const model = option('--model');
const askedMode = option('--mode') ?? 'ask';
const mode = harness.permissionModes?.includes(askedMode)
  && (harness.permissionArgv?.[askedMode] || harness.permissionEnv?.[askedMode]) ? askedMode : undefined;
const env = { ...process.env, ...(harness.turnEnv ?? {}), ...(mode ? harness.permissionEnv?.[mode] ?? {} : {}) };
const workspace = join(home, 'work');
mkdirSync(workspace, { recursive: true });
writeFileSync(join(workspace, 'README.md'), 'scratch\n');
spawnSync('git', ['init', '-q'], { cwd: workspace });
const version = spawnSync(binary, ['--version'], { encoding: 'utf8', env, timeout: 30_000 }).stdout?.split('\n')[0]?.trim();
console.log(`${command} ${version ?? '(version unknown)'} -- ACP: ${binary} ${catalog.harnessAcpLaunch(harness, { permissionMode: mode })?.argv.join(' ')}`);

const replayOnly = argv.includes('--replay-only');
const direction = replayOnly ? 'cli-to-acp' : option('--direction') ?? 'both';
const results = [];
if (direction === 'both' || direction === 'cli-to-acp') results.push(['cli-to-acp', await cliToAcp()]);
if (direction === 'both' || direction === 'acp-to-cli') results.push(['acp-to-cli', await acpToCli()]);
console.log('\n=== result');
for (const [name, outcome] of results) console.log(`${command} ${name}: ${outcome.pass ? 'PASS' : 'FAIL'} -- ${outcome.detail}`);
finish(results.every(([, outcome]) => outcome.pass) ? 0 : 1);

function freshWord() { return `ZEBRA-${randomBytes(2).toString('hex').toUpperCase()}`; }
function rememberPrompt(word) { return `Remember the word ${word}. Reply OK.`; }
function recallPrompt() { return 'What word did I ask you to remember? Reply with the word only.'; }

async function cliToAcp() {
  const word = freshWord();
  console.log(`\n=== cli-to-acp (${word})`);
  let id;
  let createdHere = false;
  if (harness.turn.createIdPrefix && harness.session?.idKind === 'uuid') {
    id = randomUUID();
    createdHere = true;
  } else if (harness.session?.createSessionArgv) {
    const made = spawnSync(binary, [...harness.session.createSessionArgv, ...options('--cli-arg')], { cwd: workspace, env, encoding: 'utf8', timeout: 60_000 });
    id = made.stdout?.trim().split(/\s+/)[0];
    console.log(`${binary} ${harness.session.createSessionArgv.join(' ')} -> ${id ?? '(nothing)'} ${made.stderr?.trim().slice(-300) ?? ''}`);
    if (!id) return { pass: false, detail: `${harness.session.createSessionArgv.join(' ')} returned no id` };
  }
  const before = discover();
  const turn = cliTurn(rememberPrompt(word), id, createdHere);
  if (turn.status !== 0 && !replayOnly) return { pass: false, detail: `the CLI's first turn exited ${turn.status}: ${turn.error}` };
  const listed = discoveredIds(before, discover()).filter((token) => !token.includes(word) && !token.startsWith('vendor-sandbox'));
  // `session.idByName` (Goose): the minted id is the session's name; ClikCode
  // keeps the id the listing gives that name (adoptListedNativeId).
  const named = harness.session?.idByName && id ? listedIdForName(id) : undefined;
  const threadId = turn.sessionId ?? named ?? id ?? listed[0];
  console.log(`thread: minted/created ${id ?? '-'}, stream reported ${turn.sessionId ?? '-'}, session list added ${listed.join(' ') || '-'}`);
  if (!threadId) return { pass: false, detail: 'the CLI turn reported no session id and the session list showed none' };
  if (replayOnly) {
    // An account without usage: the CLI still records the prompt before the
    // vendor refuses it. Whether ACP replays it shows only that the store is
    // readable -- not that a model continues the thread, so never a pass.
    const acp = await acpTurn({ load: threadId, loadOnly: true });
    if (acp.error) return { pass: false, detail: `replay-only: ACP ${acp.method ?? ''} of CLI thread ${threadId}: ${acp.error}` };
    return { pass: false, detail: `replay-only (not a proof): ACP ${acp.method} of CLI thread ${threadId} ${acp.replayed.includes(word) ? 'REPLAYED the prompt with' : 'did NOT replay'} ${word}` };
  }
  const acp = await acpTurn({ load: threadId, prompt: recallPrompt() });
  if (acp.error) {
    // Diagnosis only (it is not a pass): does ACP know the thread under the
    // vendor's own id, from its session list, rather than the one ClikCode keeps?
    for (const candidate of [threadId.replace(/^[a-z]+_/, ''), ...listed].filter((token) => token !== threadId && !token.includes(word) && !token.startsWith('vendor-sandbox')).slice(0, 4)) {
      const other = await acpTurn({ load: candidate, prompt: recallPrompt() });
      if (!other.error) {
        return { pass: false, detail: `ACP ${acp.method ?? ''} on the id ClikCode keeps (${threadId}): ${acp.error}; the vendor's listed id ${candidate} loads, and answered "${other.reply.trim().slice(0, 80)}"` };
      }
    }
    return { pass: false, detail: `ACP ${acp.method ?? ''} on the CLI's thread ${threadId}: ${acp.error}` };
  }
  return acp.reply.includes(word)
    ? { pass: true, detail: `CLI thread ${threadId} -> ACP ${acp.method} + prompt answered "${acp.reply.trim().slice(0, 80)}"` }
    : { pass: false, detail: `ACP ${acp.method} of CLI thread ${threadId} answered "${acp.reply.trim().slice(0, 200)}", not ${word}` };
}

async function acpToCli() {
  const word = freshWord();
  console.log(`\n=== acp-to-cli (${word})`);
  const acp = await acpTurn({ prompt: rememberPrompt(word) });
  if (acp.error) return { pass: false, detail: `ACP session/new + prompt: ${acp.error}` };
  console.log(`ACP session ${acp.sessionId} answered "${acp.reply.trim().slice(0, 80)}"`);
  const turn = cliTurn(recallPrompt(), acp.sessionId, false);
  if (turn.status !== 0) return { pass: false, detail: `CLI resume of ACP thread ${acp.sessionId} exited ${turn.status}: ${turn.error}` };
  const forked = turn.sessionId && turn.sessionId !== acp.sessionId ? ` (the CLI reported thread ${turn.sessionId})` : '';
  return turn.text.includes(word)
    ? { pass: true, detail: `ACP thread ${acp.sessionId} -> CLI resume answered "${turn.text.trim().slice(0, 80)}"${forked}` }
    : { pass: false, detail: `CLI resume of ACP thread ${acp.sessionId} answered "${turn.text.trim().slice(0, 200)}", not ${word}${forked}` };
}

/** One CLI turn exactly as ClikCode builds it. */
function cliTurn(prompt, nativeSessionId, createdHere) {
  const args = [
    ...catalog.nativeHarnessTurnArgv(harness, {
      prompt, ...(nativeSessionId ? { nativeSessionId } : {}), createdHere,
      ...(model ? { model } : {}), ...(mode ? { permissionMode: mode } : {}),
    }),
    ...options('--cli-arg'),
  ];
  const stdin = harness.turn.promptInput === 'stdin'
    ? (harness.turn.stdinFormat === 'stream-json'
      ? `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } })}\n`
      : prompt)
    : undefined;
  const result = spawnSync(binary, args, { cwd: workspace, env, encoding: 'utf8', timeout: 300_000, ...(stdin !== undefined ? { input: stdin } : { stdio: ['ignore', 'pipe', 'pipe'] }) });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const stream = catalog.createStreamState();
  let sessionId;
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    try { sessionId = catalog.parseHarnessLine(harness, line, stream).sessionId ?? sessionId; } catch { /* not a record */ }
  }
  let text = '';
  try { text = catalog.nativeTurnResult(harness, stdout, { exitCode: result.status ?? 1, stderr }).text ?? ''; } catch (error) { text = ''; console.error(`result: ${error.message}`); }
  console.log(`$ ${binary} ${args.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(' ')}\n-> exit ${result.status}${result.error ? ` (${result.error.message})` : ''}, answer "${text.trim().slice(0, 200)}"`);
  if (result.status !== 0) console.log(`stdout tail: ${stdout.slice(-800)}\nstderr tail: ${stderr.slice(-800)}`);
  return { status: result.status, text, sessionId, error: (stderr.trim() || stdout.trim()).slice(-400) };
}

/** The vendor's own session list, for a CLI that does not report its id. */
function discover() {
  // --discover "<argv>": a session list the catalog does not declare (Cline's `history --json`).
  const listArgv = option('--discover')?.split(' ') ?? harness.session?.discoverArgv;
  if (!listArgv) return '';
  return spawnSync(binary, listArgv, { cwd: workspace, env, encoding: 'utf8', timeout: 60_000 }).stdout ?? '';
}
function listedIdForName(name) {
  try {
    const rows = JSON.parse(discover());
    const found = (Array.isArray(rows) ? rows : []).find((row) => row?.name === name);
    return typeof found?.id === 'string' ? found.id : undefined;
  } catch { return undefined; }
}
function discoveredIds(before, after) {
  const old = new Set(before.match(/[\w-]{8,}/g) ?? []);
  return [...new Set((after.match(/[\w-]{8,}/g) ?? []).filter((token) => !old.has(token) && /\d/.test(token)))];
}

/** One ACP session: session/new, or session/resume|load of `load`, then one prompt. */
async function acpTurn({ load, prompt, loadOnly = false }) {
  const launch = catalog.harnessAcpLaunch(harness, { ...(mode ? { permissionMode: mode } : {}), ...(model && harness.acp.inheritCliOptions !== false ? { model } : {}) });
  const child = spawn(launch.binary, launch.argv, { cwd: workspace, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
  const pending = new Map();
  const updates = [];
  let next = 1;
  let buffer = '';
  let exited;
  child.on('exit', (code) => {
    exited = code;
    for (const { fail } of pending.values()) fail(new Error(`agent exited ${code}: ${stderr.trim().slice(-400)}`));
    pending.clear();
  });
  child.stdin.on('error', () => undefined);
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.id !== undefined && pending.has(message.id) && !message.method) {
        const { ok, fail } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) fail(new Error(JSON.stringify(message.error))); else ok(message.result);
      } else if (message.method === 'session/update') {
        updates.push(message.params.update);
      } else if (message.method && message.id !== undefined) {
        // A permission request or a client method: the prompts need no tools.
        const reply = message.method === 'session/request_permission'
          ? { result: { outcome: { outcome: 'cancelled' } } }
          : { error: { code: -32601, message: 'not supported by this probe' } };
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, ...reply })}\n`);
      }
    }
  });
  const request = (method, params, timeoutMs = 120_000) => new Promise((ok, fail) => {
    if (exited !== undefined) { fail(new Error(`agent exited ${exited}: ${stderr.trim().slice(-400)}`)); return; }
    const id = next++;
    const timer = setTimeout(() => { pending.delete(id); fail(new Error(`${method} timed out`)); }, timeoutMs);
    pending.set(id, { ok: (value) => { clearTimeout(timer); ok(value); }, fail: (error) => { clearTimeout(timer); fail(error); } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  let method;
  try {
    const initialized = await request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'clikcode-verify', version: '1' } });
    const capabilities = initialized?.agentCapabilities ?? {};
    let sessionId = load;
    if (load) {
      // The order ClikCode's ACP client uses (acp-client.ts); only load replays.
      method = capabilities.sessionCapabilities?.resume && !loadOnly ? 'session/resume' : capabilities.loadSession ? 'session/load' : undefined;
      if (!method) return { error: 'the agent advertises neither session/resume nor session/load' };
      await request(method, { sessionId: load, cwd: workspace, mcpServers: [] }, 180_000);
      const replayed = updates.filter((update) => update.sessionUpdate === 'user_message_chunk' || update.sessionUpdate === 'agent_message_chunk')
        .map((update) => update.content?.text ?? '').join('');
      console.log(`ACP ${method} ${load}: ok, replayed ${updates.length} updates${replayed ? ` ("${replayed.replace(/\s+/g, ' ').slice(0, 120)}")` : ''}`);
      if (loadOnly) return { sessionId: load, reply: '', replayed, method };
    } else {
      method = 'session/new';
      const started = await request('session/new', { cwd: workspace, mcpServers: [] }, 180_000);
      sessionId = String(started?.sessionId ?? '');
      if (!sessionId) return { error: 'session/new returned no session id' };
    }
    if (model && harness.acp.inheritCliOptions === false) {
      await request('session/set_model', { sessionId, modelId: model }).catch((error) => console.error(`set_model: ${error.message}`));
    }
    updates.length = 0;
    const result = await request('session/prompt', { sessionId, prompt: [{ type: 'text', text: prompt }] }, 300_000);
    const reply = updates.filter((update) => update.sessionUpdate === 'agent_message_chunk').map((update) => update.content?.text ?? '').join('');
    console.log(`ACP session/prompt (${sessionId}) -> ${result?.stopReason}: "${reply.trim().slice(0, 200)}"`);
    return { sessionId, reply, method };
  } catch (error) {
    return { error: error.message.slice(0, 600), method };
  } finally {
    child.kill();
    await new Promise((done) => { if (exited !== undefined) done(); else { child.once('exit', done); setTimeout(done, 5000); } });
  }
}

/** Exits once nothing started under the sandbox home is left running: an
 *  agent may leave a daemon behind (cursor-agent's worker-server), which would
 *  outlive the sandbox and keep writing into it. */
function finish(status) {
  for (const pid of existsSync('/proc') ? readdirSync('/proc').filter((name) => /^\d+$/.test(name)) : []) {
    if (Number(pid) === process.pid) continue;
    try {
      if (readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(`HOME=${home}`)) process.kill(Number(pid), 'SIGKILL');
    } catch { /* gone, or not ours */ }
  }
  process.exit(status);
}
