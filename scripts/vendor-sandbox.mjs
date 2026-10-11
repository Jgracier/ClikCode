#!/usr/bin/env node
/** Run a command with every vendor CLI's storage in a throwaway directory.
 *
 *   node scripts/vendor-sandbox.mjs [--auth <harness>]... -- <command> [args...]
 *
 * A live check of a harness (a `session/new`, a PONG turn, `clikcode send`)
 * otherwise writes a real chat into the user's own vendor history, and
 * ClikCode then lists it as one of theirs. Here HOME, the XDG directories,
 * CLIKCODE_HOME and each harness's own profile variable (CODEX_HOME,
 * CLAUDE_CONFIG_DIR, HERMES_HOME, ...) point inside a temporary directory
 * that is deleted afterwards, whatever the command does.
 *
 * --auth links that harness's sign-in files (its catalog `authFiles`) into
 * the sandbox. Linked, not copied: a vendor that refreshes its token in the
 * sandbox would otherwise leave the user's own copy holding a spent one. A
 * harness that declares none keeps its sign-in elsewhere and can only be run
 * signed out, or on a model that needs no sign-in (OpenCode's free models do). Git, npm, gh and the other tools a turn may use keep the
 * user's own configuration (HOME_REDIRECT_ENV_DEFAULTS). */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import os, { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const catalogPath = join(root, 'dist', 'harness-catalog.cjs');
if (!existsSync(catalogPath)) throw new Error('no build: run `node scripts/build.mjs` first');
const { AI_LOCAL_HARNESSES, HOME_REDIRECT_ENV_DEFAULTS } = createRequire(import.meta.url)(catalogPath);

const argv = process.argv.slice(2);
const split = argv.indexOf('--');
if (split < 0 || split === argv.length - 1) {
  console.error('usage: node scripts/vendor-sandbox.mjs [--auth <harness>]... [--link <~/path>]... -- <command> [args...]');
  process.exit(2);
}
const auth = [];
// Extra home-relative files to link in, for a harness whose sign-in the
// catalog does not declare (Cursor's ~/.config/cursor/auth.json, Kiro's
// ~/.local/share/kiro-cli/data.sqlite3, Hermes's ~/.hermes/auth.json).
const links = [];
for (let index = 0; index < split; index += 1) {
  if (argv[index] === '--auth' && argv[index + 1]) auth.push(argv[++index]);
  else if (argv[index] === '--link' && argv[index + 1]) links.push(argv[++index]);
  else { console.error(`unknown option: ${argv[index]}`); process.exit(2); }
}

const realHome = homedir();
const sandbox = mkdtempSync(join(tmpdir(), 'vendor-sandbox-'));
const home = join(sandbox, 'home');
const env = {
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: join(home, '.config'),
  XDG_DATA_HOME: join(home, '.local', 'share'),
  XDG_STATE_HOME: join(home, '.local', 'state'),
  XDG_CACHE_HOME: join(home, '.cache'),
  CLIKCODE_HOME: join(home, '.clikcode'),
  // Vendor CLIs ClikCode installed for the user stay runnable.
  PATH: [join(realHome, '.clikcode', 'tools', 'npm', 'bin'), process.env.PATH].join(':'),
  // The OS keyring is no file under HOME: a key typed into Gemini's,
  // Vibe's or Goose's sign-in here went into the user's own keyring (and
  // replaced the key stored there). Each keeps it in a file instead when
  // told to.
  GEMINI_FORCE_FILE_STORAGE: 'true',
  GOOSE_DISABLE_KEYRING: '1',
  VIBE_TEST_DISABLE_KEYRING: '1',
};
for (const [name, fallback] of Object.entries(HOME_REDIRECT_ENV_DEFAULTS)) {
  if (fallback && env[name] === undefined) env[name] = fallback.replace(/^~/, realHome);
}
for (const harness of AI_LOCAL_HARNESSES) {
  if (harness.profileEnv && harness.profileEnv !== 'HOME') delete env[harness.profileEnv];
}

/** `${VAR:-~/x}/y` or `~/x/y`, resolved once against the real home and once
 * against the sandbox's. */
const expand = (path, base) => path
  .replace(/\$\{(\w+):-([^}]*)\}/g, (_, _name, fallback) => fallback)
  .replace(/^~/, base)
  // A directory is declared with its trailing slash (Kimi's credentials/),
  // which a symlink's own path cannot carry.
  .replace(/\/+$/, '');
for (const command of auth) {
  const harness = AI_LOCAL_HARNESSES.find((item) => item.command === command);
  if (!harness) { console.error(`no harness named ${command}`); process.exit(2); }
  const files = harness.authFiles ?? [];
  if (!files.length) {
    // The catalog says nothing about where this vendor keeps a sign-in file;
    // its environment variables (authEnv) are inherited as they are.
    const env = harness.authEnv?.length ? ` It also signs in from ${harness.authEnv.join(', ')}, which this run inherits from your environment.` : '';
    console.error(`${command} declares no sign-in files, so --auth links nothing and it runs signed out here.${env} If it keeps a sign-in file under your home, find where in the vendor's own documentation and pass it as --link <~/path> (or a home-relative path such as .config/x).`);
  }
  for (const { path } of files) link(path);
}
// ~/x is expanded by the shell when unquoted, and then arrives as an absolute
// path inside the real home; ~/x quoted, and .config/x, are home-relative.
for (const path of links) link(path.startsWith(`${realHome}/`) ? `~${path.slice(realHome.length)}` : path.startsWith('~') ? path : `~/${path.replace(/^\/+/, '')}`);

/** The paths a catalog entry names: a `*` segment matches every entry of that
 * directory (MiniMax Code's ~/.minimax/auth/prod/<region>/<client>/auth.json). */
function expandGlob(path) {
  if (!path.includes('*')) return [path];
  let found = [''];
  for (const [index, segment] of path.split('/').entries()) {
    if (segment !== '*') { found = found.map((base) => (index === 0 ? segment : `${base}/${segment}`)); continue; }
    found = found.flatMap((base) => {
      try { return readdirSync(base || '/').sort().map((name) => `${base}/${name}`); } catch { return []; }
    });
  }
  return found;
}

/** Link one sign-in path; a catalog may list the same file twice (Cline). */
function link(path) {
  for (const from of expandGlob(expand(path, realHome))) {
    // A match under the real home maps to the same place under the sandbox's.
    const to = from.startsWith(`${realHome}/`) ? join(home, from.slice(realHome.length)) : expand(path, home);
    if (!existsSync(from) || existsSync(to)) continue;
    mkdirSync(dirname(to), { recursive: true });
    symlinkSync(from, to);
  }
}

mkdirSync(home, { recursive: true });

/** Processes started with CLIKCODE_HOME inside this sandbox (session workers,
 * which outlive the command that started them) -- found by their own
 * environment, and only those. */
function sandboxWorkers() {
  const found = [];
  let pids = [];
  try { pids = readdirSync('/proc').filter((name) => /^\d+$/.test(name)); } catch { return found; }
  for (const pid of pids) {
    if (Number(pid) === process.pid) continue;
    try {
      const entry = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').find((item) => item.startsWith('CLIKCODE_HOME='));
      const value = entry?.slice('CLIKCODE_HOME='.length);
      if (value && (value === env.CLIKCODE_HOME || value.startsWith(`${sandbox}/`))) found.push(Number(pid));
    } catch { /* gone, or not ours to read */ }
  }
  return found;
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

let cleaned = false;
/** Stop the sandbox's workers (SIGTERM first, so each closes its vendor), then
 * delete the directory. Safe to call twice. */
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  const workers = sandboxWorkers();
  for (const pid of workers) { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } }
  for (let waited = 0; waited < 5000 && workers.some(alive); waited += 100) await new Promise((r) => setTimeout(r, 100));
  for (const pid of workers.filter(alive)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  rmSync(sandbox, { recursive: true, force: true });
}

// Its own process group when there is no terminal, so a signal can take the
// command's whole tree; with a terminal the command must stay in the
// foreground group to read it.
const detached = !process.stdin.isTTY;
const child = spawn(argv[split + 1], argv.slice(split + 2), { stdio: 'inherit', env, detached });
const signalChild = (signal) => {
  try { process.kill(detached ? -child.pid : child.pid, signal); } catch { /* already gone */ }
};
let interrupted;
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    interrupted ??= signal;
    signalChild(signal);
    // A command that ignores the signal does not hold the sandbox.
    setTimeout(() => signalChild('SIGKILL'), 5000).unref();
  });
}
const status = await new Promise((resolveStatus) => {
  child.on('error', (error) => { console.error(error.message); resolveStatus(1); });
  child.on('close', (code, signal) => resolveStatus(code ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : 1)));
});
// The command is done; whatever it left in its group goes with it.
if (detached) signalChild('SIGTERM');
await cleanup();
process.exit(interrupted ? 128 + os.constants.signals[interrupted] : status);
