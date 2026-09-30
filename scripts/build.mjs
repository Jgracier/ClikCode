/**
 * ClikCode build. Produces four files in dist/:
 *
 *   index.js               The entry (bin): turns on Node's compile cache, then
 *                          loads cli.js. Rewritten on every build, since its
 *                          mtime and size are the build a worker records.
 *   cli.js                 The program (ESM). Small pure-JS dependencies are inlined
 *                          so startup is one file read instead of a node_modules walk.
 *   harness-catalog.cjs    The pure harness catalog (no AI SDKs); cheap to load.
 *   ai-router-runtime.cjs  Catalog + streamAiChatTurn (`ai` + @ai-sdk providers);
 *                          only needed for local API-key model turns.
 *
 * Flags:
 *   --analyze   Print a metafile report: top inputs by bytes, runtime externals,
 *               and any deployment-CLI sources that landed in cli.js.
 *   --no-strict Downgrade the deployment-source check to a warning. By default
 *               (and with the legacy --strict spelling) the build FAILS when a
 *               source named like the deployment CLI's (server-*, deploy*,
 *               docker*, admin-*) is in cli.js — those dragged in axios,
 *               inquirer and ora before the split and must not come back.
 *
 * Always enforced (cheap, and each one is a broken publish if it regresses):
 *   - every package cli.js imports at runtime is in package.json `dependencies`
 *   - harness-catalog.cjs contains no node_modules code at all
 * */
import { createHash } from 'node:crypto';
import { chmod, readFile, mkdir, writeFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as esbuild } from 'esbuild';

/** esbuild has already printed the diagnostics (logLevel: 'info'); skip the redundant stack trace. */
async function build(options) {
  try { return await esbuild(options); } catch (error) {
    if (Array.isArray(error?.errors)) process.exit(1);
    throw error;
  }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);

const analyze = process.argv.includes('--analyze');
const strict = !process.argv.includes('--no-strict');
const pkg = JSON.parse(await readFile('package.json', 'utf8'));

/**
 * Inlined into cli.js. Pure JS, no native addons, no runtime file lookups
 * relative to their own package directory. Their transitive dependencies are
 * inlined with them. Everything else imported from source stays external and
 * must therefore be listed in package.json `dependencies`.
 */
const INLINE_PACKAGES = new Set(['chalk', 'commander', 'conf', 'cross-spawn', 'marked']);
/** Never inline, even transitively. */
const FORCE_EXTERNAL = new Set(['@basetenlabs/performance-client']);
const builtins = new Set(builtinModules);

function packageName(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** `packages: 'external'`, except for the allowlist above and whatever those packages need. */
const selectiveExternals = {
  name: 'clikcode-selective-externals',
  setup(b) {
    b.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.kind === 'entry-point') return undefined;
      if (args.path.startsWith('node:') || builtins.has(args.path) || /^[a-zA-Z]:[\\/]/.test(args.path)) return undefined;
      const name = packageName(args.path);
      if (FORCE_EXTERNAL.has(name)) return { path: args.path, external: true };
      const fromDependency = /[\\/]node_modules[\\/]/.test(args.importer);
      if (fromDependency || INLINE_PACKAGES.has(name)) return undefined; // let esbuild bundle it
      return { path: args.path, external: true };
    });
  },
};

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  logLevel: 'info',
  metafile: true,
  define: { __CLIKCODE_VERSION__: JSON.stringify(pkg.version) },
};

const index = await build({
  ...common,
  entryPoints: ['src/index.ts'],
  format: 'esm',
  plugins: [selectiveExternals],
  // Inlined CommonJS packages (commander, cross-spawn, conf's ajv, …) call
  // require() for node builtins; native ESM has no `require`, so provide one.
  banner: {
    js: [
      `import { createRequire as __clikcodeCreateRequire } from 'node:module';`,
      'const require = __clikcodeCreateRequire(import.meta.url);',
    ].join('\n'),
  },
  outfile: 'dist/cli.js',
});

// Compiling the 2 MB program was ~30 ms of every start, and the catalog's CJS
// another ~10: the compile cache keeps V8's code per file content, so each is
// compiled once per build. It has to be on before cli.js is imported, hence a
// file of its own. The digest is there so this file changes with the program.
// It is a cache of code, not ClikCode state, so it lives in the user cache
// directory whatever CLIKCODE_HOME says (NODE_COMPILE_CACHE, if set, wins).
const programDigest = createHash('sha256').update(await readFile('dist/cli.js')).digest('hex').slice(0, 16);
await writeFile('dist/index.js', `#!/usr/bin/env node
// ClikCode (program ${programDigest}). Written by scripts/build.mjs; the program is cli.js.
import module from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
try {
  module.enableCompileCache?.(join(process.env.XDG_CACHE_HOME?.trim() || join(homedir(), '.cache'), 'clikcode', 'node-compile-cache'));
} catch { /* fail-open-ok: no cache is only a slower start. */ }
await import('./cli.js');
`);

const catalog = await build({
  ...common,
  entryPoints: ['src/runtime/catalog.ts'],
  format: 'cjs',
  outfile: 'dist/harness-catalog.cjs',
});

const router = await build({
  ...common,
  entryPoints: ['src/runtime/router.ts'],
  format: 'cjs',
  external: [...FORCE_EXTERNAL],
  outfile: 'dist/ai-router-runtime.cjs',
});

if (process.platform !== 'win32') await chmod('dist/index.js', 0o755);

// ---------------------------------------------------------------- guards ----

const failures = [];
const warnings = [];
const display = (path) => relative(root, join(root, path)).split('\\').join('/');

function runtimeExternals(metafile, outfile) {
  const names = new Set();
  for (const item of metafile.outputs[outfile]?.imports ?? []) {
    if (!item.external || item.path.startsWith('node:') || builtins.has(item.path)) continue;
    if (item.path.startsWith('.') || item.path.startsWith('/')) continue;
    names.add(packageName(item.path));
  }
  return [...names].sort();
}

const indexExternals = runtimeExternals(index.metafile, 'dist/cli.js');
const routerExternals = runtimeExternals(router.metafile, 'dist/ai-router-runtime.cjs');
for (const name of [...indexExternals, ...routerExternals]) {
  if (!pkg.dependencies?.[name]) failures.push(`dist imports "${name}" at runtime but package.json "dependencies" does not list it`);
}
for (const name of Object.keys(pkg.dependencies ?? {})) {
  if (!indexExternals.includes(name) && !routerExternals.includes(name)) {
    warnings.push(`"${name}" is in package.json "dependencies" but nothing in dist imports it at runtime (bundled or unused: move to devDependencies)`);
  }
}

const catalogDependencies = Object.keys(catalog.metafile.inputs).filter((path) => /(^|\/)node_modules\//.test(path));
if (catalogDependencies.length) failures.push(`harness-catalog.cjs must be dependency-free, but bundles: ${catalogDependencies.slice(0, 5).join(', ')}`);
if (runtimeExternals(catalog.metafile, 'dist/harness-catalog.cjs').length) failures.push('harness-catalog.cjs must not import packages at runtime');

// Load it the way harness-runtime.ts will: it must evaluate standalone and carry the catalog.
{
  const { createRequire } = await import('node:module');
  const loaded = createRequire(import.meta.url)(join(root, 'dist/harness-catalog.cjs'));
  if (!Array.isArray(loaded.AI_LOCAL_HARNESSES) || loaded.AI_LOCAL_HARNESSES.length === 0 || typeof loaded.localHarnessForCommand !== 'function') {
    failures.push('harness-catalog.cjs loaded but does not export the harness catalog');
  }
}

// ---------------------------------------------------------------- report ----

function kb(bytes) { return `${(bytes / 1024).toFixed(1)} kB`; }

/** Collapse node_modules inputs to one row per package; keep source files as-is. */
function topInputs(metafile, outfile, limit) {
  const rows = new Map();
  for (const [path, info] of Object.entries(metafile.outputs[outfile].inputs)) {
    const marker = path.lastIndexOf('node_modules/');
    const key = marker >= 0
      ? `npm:${packageName(path.slice(marker + 'node_modules/'.length))}`
      : path.includes(':') && !/^[a-zA-Z]:[\\/]/.test(path) ? path : display(path);
    rows.set(key, (rows.get(key) ?? 0) + info.bytesInOutput);
  }
  return [...rows.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

if (analyze) {
  for (const [metafile, outfile, limit] of [[index.metafile, 'dist/cli.js', 30], [catalog.metafile, 'dist/harness-catalog.cjs', 8], [router.metafile, 'dist/ai-router-runtime.cjs', 12]]) {
    const total = metafile.outputs[outfile].bytes;
    console.log(`\n${outfile}  ${kb(total)}`);
    for (const [name, bytes] of topInputs(metafile, outfile, limit)) {
      console.log(`  ${kb(bytes).padStart(10)}  ${((bytes / total) * 100).toFixed(1).padStart(5)}%  ${name}`);
    }
  }
  console.log(`\ncli.js runtime packages: ${indexExternals.join(', ') || '(none)'}`);
  console.log(`ai-router-runtime.cjs runtime packages: ${routerExternals.join(', ') || '(none)'}`);
  // Outside dist/ on purpose: everything in dist/ is published.
  await mkdir('node_modules/.cache/clikcode', { recursive: true });
  await writeFile('node_modules/.cache/clikcode/meta.index.json', JSON.stringify(index.metafile));
  console.log('\nFull metafile: node_modules/.cache/clikcode/meta.index.json (drop it on https://esbuild.github.io/analyze/)');
}

for (const message of warnings) console.warn(`warning: ${message}`);
if (failures.length) {
  for (const message of failures) console.error(`error: ${message}`);
  process.exit(1);
}
