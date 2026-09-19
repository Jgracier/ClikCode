/**
 * ClikCode build. Produces three files in dist/:
 *
 *   index.js               ESM entry (bin). Small pure-JS dependencies are inlined
 *                          so startup is one file read instead of a node_modules walk.
 *   harness-catalog.cjs    The pure harness catalog (no AI SDKs); cheap to load.
 *   ai-router-runtime.cjs  Catalog + streamAiChatTurn (`ai` + @ai-sdk providers);
 *                          only needed for local API-key model turns.
 *
 * Flags:
 *   --analyze   Print a metafile report: top inputs by bytes, runtime externals,
 *               and any deployment-CLI sources that landed in index.js.
 *   --strict    With or without --analyze: FAIL when a deployment-CLI source
 *               (basename server-*, deploy*, docker*, admin-*) is in index.js.
 *               Opt-in until commands/ai.ts stops importing api/client.js and
 *               commands/auth.js; then make it the default in package.json.
 *
 * Always enforced (cheap, and each one is a broken publish if it regresses):
 *   - every package index.js imports at runtime is in package.json `dependencies`
 *   - harness-catalog.cjs contains no node_modules code at all
 *   - utils/lifecycle-lock is not in index.js
 */
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
const strict = process.argv.includes('--strict');
const pkg = JSON.parse(await readFile('package.json', 'utf8'));

/**
 * Inlined into index.js. Pure JS, no native addons, no runtime file lookups
 * relative to their own package directory. Their transitive dependencies are
 * inlined with them. Everything else imported from source stays external and
 * must therefore be listed in package.json `dependencies`.
 */
const INLINE_PACKAGES = new Set(['chalk', 'commander', 'conf', 'cross-spawn', 'marked']);
/** Never inline, even transitively. */
const FORCE_EXTERNAL = new Set(['@basetenlabs/performance-client']);
const FORBIDDEN_SOURCE = /^(server-|deploy|docker|admin-)/;
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

/**
 * program-base.ts loads utils/lifecycle-lock with a dynamic import, only when
 * the lock is enabled. esbuild inlines dynamic imports when not code-splitting,
 * and ClikCode always passes `lifecycleLock: false`, so swap in a stub.
 */
const stubLifecycleLock = {
  name: 'clikcode-stub-lifecycle-lock',
  setup(b) {
    b.onResolve({ filter: /[\\/]utils[\\/]lifecycle-lock(\.js|\.ts)?$/ }, () => ({ path: 'lifecycle-lock', namespace: 'clikcode-stub' }));
    b.onLoad({ filter: /.*/, namespace: 'clikcode-stub' }, () => ({
      contents: `export function acquireLifecycleLock() { throw new Error('The lifecycle lock is not part of ClikCode.'); }`,
      loader: 'js',
    }));
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
  plugins: [stubLifecycleLock, selectiveExternals],
  // Inlined CommonJS packages (commander, cross-spawn, conf's ajv, …) call
  // require() for node builtins; native ESM has no `require`, so provide one.
  banner: {
    js: [
      '#!/usr/bin/env node',
      `import { createRequire as __clikcodeCreateRequire } from 'node:module';`,
      'const require = __clikcodeCreateRequire(import.meta.url);',
    ].join('\n'),
  },
  outfile: 'dist/index.js',
});

const catalog = await build({
  ...common,
  entryPoints: ['../cli/src/harness-catalog-runtime.ts'],
  format: 'cjs',
  outfile: 'dist/harness-catalog.cjs',
});

const router = await build({
  ...common,
  entryPoints: ['../cli/src/ai-router-runtime.ts'],
  format: 'cjs',
  external: [...FORCE_EXTERNAL],
  outfile: 'dist/ai-router-runtime.cjs',
});

if (process.platform !== 'win32') await chmod('dist/index.js', 0o755);

// ---------------------------------------------------------------- guards ----

const failures = [];
const warnings = [];
const display = (path) => relative(join(root, '..', '..'), join(root, path)).split('\\').join('/');

function runtimeExternals(metafile, outfile) {
  const names = new Set();
  for (const item of metafile.outputs[outfile]?.imports ?? []) {
    if (!item.external || item.path.startsWith('node:') || builtins.has(item.path)) continue;
    if (item.path.startsWith('.') || item.path.startsWith('/')) continue;
    names.add(packageName(item.path));
  }
  return [...names].sort();
}

const indexExternals = runtimeExternals(index.metafile, 'dist/index.js');
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

const indexInputs = Object.entries(index.metafile.outputs['dist/index.js'].inputs);
if (indexInputs.some(([path]) => /utils\/lifecycle-lock\.ts$/.test(path))) failures.push('utils/lifecycle-lock.ts was inlined into index.js');

const forbidden = indexInputs
  .filter(([path]) => !path.includes('node_modules/') && FORBIDDEN_SOURCE.test(path.split('/').pop() ?? ''))
  .map(([path, info]) => ({ path: display(path), bytes: info.bytesInOutput }))
  .sort((a, b) => b.bytes - a.bytes);
if (forbidden.length) {
  const total = forbidden.reduce((sum, item) => sum + item.bytes, 0);
  const message = `${forbidden.length} deployment-CLI source file(s) are in index.js (${kb(total)}): ${forbidden.slice(0, 6).map((item) => item.path.split('/').pop()).join(', ')}${forbidden.length > 6 ? ', …' : ''}`;
  (strict ? failures : warnings).push(message);
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
  for (const [metafile, outfile, limit] of [[index.metafile, 'dist/index.js', 30], [catalog.metafile, 'dist/harness-catalog.cjs', 8], [router.metafile, 'dist/ai-router-runtime.cjs', 12]]) {
    const total = metafile.outputs[outfile].bytes;
    console.log(`\n${outfile}  ${kb(total)}`);
    for (const [name, bytes] of topInputs(metafile, outfile, limit)) {
      console.log(`  ${kb(bytes).padStart(10)}  ${((bytes / total) * 100).toFixed(1).padStart(5)}%  ${name}`);
    }
  }
  console.log(`\nindex.js runtime packages: ${indexExternals.join(', ') || '(none)'}`);
  console.log(`ai-router-runtime.cjs runtime packages: ${routerExternals.join(', ') || '(none)'}`);
  if (forbidden.length) {
    console.log('\nDeployment-CLI sources in index.js:');
    for (const item of forbidden) console.log(`  ${kb(item.bytes).padStart(10)}  ${item.path}`);
  }
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
