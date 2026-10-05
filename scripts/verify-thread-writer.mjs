#!/usr/bin/env node
/** The one-turn proof that a native thread writer works, for any harness.
 *
 *   node scripts/verify-thread-writer.mjs <harness> [--replay-only] [--model <id>] [--link <~/path>]...
 *
 * Inside scripts/vendor-sandbox.mjs (never the user's own vendor history):
 * writes a small conversation -- a codeword, a shell call, an edit -- with the
 * harness's registered writer (registry.ts NATIVE_SESSION_STORES) under a
 * fresh profile, then resumes it the way ClikCode does (ACP `session/load`,
 * or the CLI's resume argv) and asks for the codeword. Exit 0 only when the
 * model's answer contains it: that is what "verified" means for a writer's
 * `testedVersions`, and the version to add is printed.
 *
 * The writer runs even when its versionOk says no (a disabled writer is what
 * this is for). --replay-only stops after ACP `session/load` and reports what
 * the agent replayed -- no model call, no quota. --link passes a sign-in file
 * the catalog does not declare through to the sandbox (Cursor:
 * `--link .config/cursor/auth.json`). */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const command = argv[0];
const option = (name) => { const at = argv.indexOf(name); return at > 0 ? argv[at + 1] : undefined; };
const links = argv.flatMap((value, index) => (value === '--link' && argv[index + 1] ? [argv[index + 1]] : []));
if (!command || command.startsWith('-')) {
  console.error('usage: node scripts/verify-thread-writer.mjs <harness> [--replay-only] [--model <id>] [--link <~/path>]...');
  process.exit(2);
}

if (!process.env.VERIFY_THREAD_WRITER_INSIDE) {
  const result = spawnSync(process.execPath, [
    join(root, 'scripts', 'vendor-sandbox.mjs'), '--auth', command, ...links.flatMap((path) => ['--link', path]),
    '--', process.execPath, fileURLToPath(import.meta.url), ...argv,
  ], { stdio: 'inherit', env: { ...process.env, VERIFY_THREAD_WRITER_INSIDE: '1' } });
  process.exit(result.status ?? 1);
}

// ------------------------------------------------- inside the sandbox ----
const home = process.env.HOME;
const { build } = await import('esbuild');
const bundle = join(home, 'writers.mjs');
await build({
  stdin: {
    contents: "export { NATIVE_SESSION_STORES } from './src/session/discovery/registry.ts';\nexport { AI_LOCAL_HARNESSES } from '@clikcode/router/ai-local-harness';",
    resolveDir: root, loader: 'ts',
  },
  bundle: true, platform: 'node', format: 'esm', outfile: bundle, logLevel: 'error',
  define: { __CLIKCODE_VERSION__: '"verify"' },
  banner: { js: "import { createRequire as __r } from 'node:module'; const require = __r(import.meta.url);" },
});
const { NATIVE_SESSION_STORES, AI_LOCAL_HARNESSES } = await import(pathToFileURL(bundle).href);
const harness = AI_LOCAL_HARNESSES.find((item) => item.command === command);
const writer = NATIVE_SESSION_STORES[command]?.writer;
if (!harness || !writer) { console.error(`${command}: ${harness ? 'no thread writer registered' : 'no such harness'}`); process.exit(2); }

// A profile the way ClikCode gives an account one: a redirected HOME with its
// XDG directories, plus the harness's own profile variable.
const profile = join(home, 'profile');
const environment = {
  HOME: profile,
  XDG_CONFIG_HOME: join(profile, '.config'), XDG_DATA_HOME: join(profile, '.local', 'share'),
  XDG_STATE_HOME: join(profile, '.local', 'state'), XDG_CACHE_HOME: join(profile, '.cache'),
  ...(harness.profileEnv && harness.profileEnv !== 'HOME' ? { [harness.profileEnv]: join(profile, `.${command}-profile`) } : {}),
};
const expand = (path, base, env) => path
  .replace(/\$\{(\w+):-([^}]*)\}/g, (_, name, fallback) => env[name] ?? fallback)
  .replace(/^~/, base);
for (const path of [...(harness.authFiles ?? []).map((file) => file.path), ...links.map((path) => (path.startsWith('~') ? path : `~/${path}`))]) {
  const from = expand(path, home, {});
  const to = expand(path, profile, environment);
  if (!existsSync(from) || existsSync(to)) continue;
  mkdirSync(dirname(to), { recursive: true });
  symlinkSync(from, to);
}
for (const directory of Object.values(environment)) mkdirSync(directory, { recursive: true });

const workspace = join(home, 'work');
mkdirSync(join(workspace, 'src'), { recursive: true });
writeFileSync(join(workspace, 'notes.txt'), 'launch window: Thursday\n');
writeFileSync(join(workspace, 'src', 'app.ts'), 'const x = 1;\n');
const codeword = `PELICAN-${randomBytes(2).toString('hex').toUpperCase()}`;
const origin = { sessionId: 's-1', harness: 'claude', route: 'native', provider: 'anthropic', model: 'claude-sonnet-4-6' };
const shell = {
  id: 'toolu_1', category: 'run', name: 'Bash', input: { command: 'cat notes.txt' }, label: '$ cat notes.txt',
  target: 'cat notes.txt', status: 'done', output: ['launch window: Thursday'], exitCode: 0, files: [],
};
const edit = {
  id: 'toolu_2', category: 'edit', name: 'Edit', input: { file_path: 'src/app.ts', old_string: 'cosnt x = 1;', new_string: 'const x = 1;' },
  label: 'Edit src/app.ts', target: 'src/app.ts', status: 'done', files: ['src/app.ts'],
};
const read = {
  id: 'toolu_3', category: 'read', name: 'Read', input: { file_path: 'src/app.ts' }, label: 'Read src/app.ts',
  target: 'src/app.ts', status: 'done', output: ['const x = 1;'], files: [],
};
const grep = {
  id: 'toolu_4', category: 'search', name: 'Grep', input: { pattern: 'cosnt' }, label: 'Grep cosnt',
  target: 'cosnt', status: 'done', output: ['(no matches)'], files: [],
};
const turn = (index, user, parts) => ({
  index, user, attachments: [], parts, interrupted: false, origin,
  tools: parts.flatMap((part) => (part.type === 'tool' ? [part.call] : [])),
  assistant: parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join(''),
  touchedFiles: parts.flatMap((part) => (part.type === 'tool' ? part.call.files : [])),
});
const record = {
  version: 1, conversationId: 'verify', sessionId: 's-1', workspace, touchedFiles: ['src/app.ts'],
  attachments: [], pendingAttachments: [], openTodos: [],
  turns: [
    turn(0, `Remember the codeword ${codeword}. Then check what is in notes.txt.`, [
      { type: 'text', text: "I'll read the notes." }, { type: 'tool', call: shell },
      { type: 'text', text: `notes.txt says the launch window is Thursday. Codeword ${codeword} noted.` },
    ]),
    turn(1, 'Fix the typo in src/app.ts', [
      { type: 'tool', call: edit }, { type: 'tool', call: read }, { type: 'tool', call: grep },
      { type: 'text', text: 'Fixed the typo in src/app.ts; no other occurrences.' },
    ]),
  ],
};

const binary = harness.binary ?? harness.command;
const version = spawnSync(binary, ['--version'], { encoding: 'utf8', env: { ...process.env, ...environment } }).stdout?.split('\n')[0]?.trim();
const context = { harness, workspace, environment, model: option('--model') ?? null, version };
const enabled = await writer.versionOk(context);
console.log(`${command} ${version ?? '(version unknown)'}: writer ${enabled ? 'enabled' : 'DISABLED for this version (testing anyway)'}`);
const written = await writer.write(record, context);
if (!written) { console.error('the writer wrote nothing'); process.exit(1); }
console.log(`wrote thread ${written.nativeId}${written.transport ? ` (pinned to ${written.transport})` : ''}`);
const question = 'What is the codeword I asked you to remember? Reply with the codeword only.';
const env = { ...process.env, ...environment };
const acp = written.transport ? written.transport === 'acp' : harness.transport === 'acp' && Boolean(harness.acp);
const answer = acp ? await acpTurn() : cliTurn();
const proved = answer.includes(codeword);
console.log(proved
  ? `PROOF: ${command} ${version} recalled ${codeword} -- add '${version}' to the writer's testedVersions`
  : `NOT PROVED: the answer did not contain ${codeword}`);
finish(proved ? 0 : 1);

/** Exits once nothing started under the profile is left running: an agent
 *  may leave a daemon behind (cursor-agent's `worker-server`), which would
 *  outlive the sandbox and keep writing into it. Found by its HOME (Linux
 *  /proc; elsewhere nothing to scan). */
function finish(status) {
  for (const pid of existsSync('/proc') ? readdirSync('/proc').filter((name) => /^\d+$/.test(name)) : []) {
    if (Number(pid) === process.pid) continue;
    try {
      if (readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(`HOME=${profile}`)) process.kill(Number(pid), 'SIGKILL');
    } catch { /* gone, or not ours */ }
  }
  process.exit(status);
}

function cliTurn() {
  if (argv.includes('--replay-only')) { console.error('--replay-only needs an ACP agent'); process.exit(2); }
  const turnSpec = harness.turn ?? {};
  const model = option('--model');
  const args = [
    ...(turnSpec.resumeArgv ?? turnSpec.startArgv ?? []), ...(turnSpec.resumeIdPrefix ?? []), written.nativeId,
    ...(model && harness.modelArgvPrefix ? [...harness.modelArgvPrefix, model] : []),
    ...(turnSpec.promptArgvPrefix ?? (turnSpec.promptGuard === 'double-dash' ? ['--'] : [])), question,
  ];
  const result = spawnSync(binary, args, { cwd: workspace, env, encoding: 'utf8', timeout: 300_000 });
  console.log(`${binary} ${args.join(' ')}\n-> exit ${result.status}\n${(result.stdout ?? '').slice(-2000)}${(result.stderr ?? '').slice(-1000)}`);
  return result.stdout ?? '';
}

async function acpTurn() {
  const child = spawn(binary, harness.acp.argv, { cwd: workspace, env, stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map();
  const updates = [];
  let next = 1;
  let buffer = '';
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
        // A permission request or a client method: refuse, the question needs no tools.
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { outcome: { outcome: 'cancelled' } } })}\n`);
      }
    }
  });
  const request = (method, params, timeoutMs = 120_000) => new Promise((ok, fail) => {
    const id = next++;
    const timer = setTimeout(() => { pending.delete(id); fail(new Error(`${method} timed out`)); }, timeoutMs);
    pending.set(id, { ok: (value) => { clearTimeout(timer); ok(value); }, fail: (error) => { clearTimeout(timer); fail(error); } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const text = (kind) => updates.filter((update) => update.sessionUpdate === kind)
    .map((update) => update.content?.text ?? '').join('');
  try {
    await request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'clikcode-verify', version: '1' } });
    await request('session/load', { sessionId: written.nativeId, cwd: workspace, mcpServers: [] });
    const kinds = updates.reduce((counts, update) => ({ ...counts, [update.sessionUpdate]: (counts[update.sessionUpdate] ?? 0) + 1 }), {});
    const finals = new Map(updates.filter((update) => update.toolCallId).map((update) => [update.toolCallId, update.status]));
    const tools = updates.filter((update) => update.sessionUpdate === 'tool_call').map((update) => `${update.title ?? update.kind} [${finals.get(update.toolCallId) ?? ''}]`);
    const replayed = `${text('user_message_chunk')}\n${text('agent_message_chunk')}`;
    console.log(`session/load replayed: ${JSON.stringify(kinds)}`);
    console.log(`  tool calls: ${tools.join('; ') || '(none)'}`);
    console.log(`  codeword in replay: ${replayed.includes(codeword) ? 'yes' : 'NO'}`);
    if (argv.includes('--replay-only')) {
      console.log(replayed.includes(codeword) && tools.length >= 2 ? 'REPLAYED: the written thread loads; no model turn was run' : 'NOT REPLAYED');
      finish(replayed.includes(codeword) && tools.length >= 2 ? 0 : 1);
    }
    const model = option('--model');
    if (model) await request('session/set_model', { sessionId: written.nativeId, modelId: model }).catch((error) => console.error(`set_model: ${error.message}`));
    updates.length = 0;
    const result = await request('session/prompt', { sessionId: written.nativeId, prompt: [{ type: 'text', text: question }] }, 300_000);
    const reply = text('agent_message_chunk');
    console.log(`session/prompt -> ${result?.stopReason}: ${reply.slice(0, 500)}`);
    return reply;
  } catch (error) {
    console.error(`ACP: ${error.message}`);
    return '';
  } finally {
    child.kill();
  }
}
