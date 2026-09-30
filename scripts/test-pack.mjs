/**
 * Smoke-test what would actually be published.
 *
 *  1. `npm pack --dry-run --json` (runs `prepack`, i.e. a fresh build) and assert
 *     the tarball contains exactly dist/*, README.md, LICENSE and package.json.
 *  2. Pack for real, `npm install -g` the tarball into an empty prefix — no
 *     workspace, no hoisted node_modules, exactly what `npm install -g clikcode`
 *     does — and run the installed `clikcode` bin (--help, --version,
 *     ide-bridge --help, doctor). This is what catches a runtime import that is
 *     missing from `dependencies`, a `file:`/`workspace:` runtime dependency, a
 *     dist file left out of `files`, or a `bin` npm rewrote or dropped.
 *
 * Needs network access for step 2 (runtime dependencies come from the registry).
 * `--keep` leaves the temp directory behind for inspection.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const keep = process.argv.includes('--keep');
const windows = process.platform === 'win32';
const npm = windows ? 'npm.cmd' : 'npm';

// pnpm hands its npm_config_* settings to the scripts it runs; npm does not know them and
// warns ("Unknown env config"), so npm here runs without them.
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_(config|package|lifecycle)_/i.test(key)));

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], shell: windows, env: cleanEnv, ...options });
}

/** npm prints lifecycle-script output before the JSON document; take the trailing JSON array. */
function parsePackJson(stdout) {
  const start = stdout.lastIndexOf('\n[');
  return JSON.parse(start >= 0 ? stdout.slice(start + 1) : stdout.slice(stdout.indexOf('[')));
}

function fail(message) {
  console.error(`test:pack FAILED: ${message}`);
  process.exit(1);
}

// 1. File list -----------------------------------------------------------------
const [dryRun] = parsePackJson(run(npm, ['pack', '--dry-run', '--json'], { cwd: root }));
const files = dryRun.files.map((file) => file.path.split('\\').join('/')).sort();
const REQUIRED = ['LICENSE', 'README.md', 'package.json', 'dist/index.js', 'dist/cli.js', 'dist/harness-catalog.cjs', 'dist/ai-router-runtime.cjs'];
const allowed = (path) => path === 'LICENSE' || path === 'README.md' || path === 'package.json' || /^dist\/[^/]+$/.test(path);
const unexpected = files.filter((path) => !allowed(path));
const missing = REQUIRED.filter((path) => !files.includes(path));
if (unexpected.length) fail(`unexpected files in the tarball: ${unexpected.join(', ')}`);
if (missing.length) fail(`files missing from the tarball: ${missing.join(', ')}`);
console.log(`tarball: ${files.length} files, ${(dryRun.size / 1024).toFixed(0)} kB packed, ${(dryRun.unpackedSize / 1024).toFixed(0)} kB unpacked`);
for (const path of files) console.log(`  ${path}`);

// A published package cannot resolve these at install time.
for (const [name, spec] of Object.entries(pkg.dependencies ?? {})) {
  if (/^(file|link|workspace|catalog):/.test(String(spec))) fail(`runtime dependency "${name}" uses an unpublishable specifier: ${spec}`);
}

// 2. Install the tarball somewhere clean and run it --------------------------------
const work = mkdtempSync(join(tmpdir(), 'clikcode-pack-'));
try {
  const [packed] = parsePackJson(run(npm, ['pack', '--json', '--pack-destination', work], { cwd: root }));
  const tarball = join(work, packed.filename.replace(/^@/, '').replace('/', '-'));
  const prefix = join(work, 'prefix');
  const home = join(work, 'home');
  mkdirSync(prefix);
  mkdirSync(home);
  run(npm, ['install', '--global', '--prefix', prefix, '--no-audit', '--no-fund', tarball], { cwd: work });

  // npm normalizes the manifest as it packs; a `bin` it had to rewrite (or dropped) shows up here.
  const installedRoot = windows ? join(prefix, 'node_modules', pkg.name) : join(prefix, 'lib', 'node_modules', pkg.name);
  const installed = JSON.parse(readFileSync(join(installedRoot, 'package.json'), 'utf8'));
  if (JSON.stringify(installed.bin) !== JSON.stringify(pkg.bin)) fail(`npm rewrote "bin" while packing: ${JSON.stringify(pkg.bin)} became ${JSON.stringify(installed.bin)} (run \`npm pkg fix\`)`);

  const bin = windows ? join(prefix, 'clikcode.cmd') : join(prefix, 'bin', 'clikcode');
  // Isolated HOME: the smoke test must not read or write the developer's ~/.clikcode or config.
  const env = { ...cleanEnv, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'), APPDATA: join(home, 'AppData'), NO_COLOR: '1' };
  const help = run(bin, ['--help'], { cwd: work, env });
  if (!help.includes('Usage: clikcode')) fail('`clikcode --help` did not print usage');
  const version = run(bin, ['--version'], { cwd: work, env }).trim();
  if (version !== pkg.version) fail(`\`clikcode --version\` printed ${version}, expected ${pkg.version}`);
  const bridgeHelp = run(bin, ['ide-bridge', '--help'], { cwd: work, env });
  if (!bridgeHelp.includes('Usage: clikcode ide-bridge')) fail('`clikcode ide-bridge --help` did not print usage');
  const doctor = JSON.parse(run(bin, ['doctor'], { cwd: work, env }));
  if (!Array.isArray(doctor.harnesses) || doctor.harnesses.length === 0) fail('`clikcode doctor` returned no harness catalog');
  console.log(`installed clikcode ${version}: --help, --version, ide-bridge --help and doctor (${doctor.harnesses.length} harnesses) OK`);
} finally {
  if (keep) console.log(`kept ${work}`);
  else rmSync(work, { recursive: true, force: true, maxRetries: 3 });
}
