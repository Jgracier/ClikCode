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
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const catalogPath = join(root, 'dist', 'harness-catalog.cjs');
if (!existsSync(catalogPath)) throw new Error('no build: run `node scripts/build.mjs` first');
const { AI_LOCAL_HARNESSES, HOME_REDIRECT_ENV_DEFAULTS } = createRequire(import.meta.url)(catalogPath);

const argv = process.argv.slice(2);
const split = argv.indexOf('--');
if (split < 0 || split === argv.length - 1) {
  console.error('usage: node scripts/vendor-sandbox.mjs [--auth <harness>]... -- <command> [args...]');
  process.exit(2);
}
const auth = [];
for (let index = 0; index < split; index += 1) {
  if (argv[index] === '--auth' && argv[index + 1]) auth.push(argv[++index]);
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
  .replace(/^~/, base);
for (const command of auth) {
  const harness = AI_LOCAL_HARNESSES.find((item) => item.command === command);
  if (!harness) { console.error(`no harness named ${command}`); process.exit(2); }
  const files = harness.authFiles ?? [];
  if (!files.length) console.error(`${command} declares no sign-in files; it runs signed out here`);
  for (const { path } of files) {
    const from = expand(path, realHome);
    if (!existsSync(from)) continue;
    const to = expand(path, home);
    mkdirSync(dirname(to), { recursive: true });
    symlinkSync(from, to);
  }
}

mkdirSync(home, { recursive: true });
let status = 1;
try {
  const result = spawnSync(argv[split + 1], argv.slice(split + 2), { stdio: 'inherit', env });
  if (result.error) console.error(result.error.message);
  status = result.status ?? 1;
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
process.exit(status);
