/**
 * ClikCode build. Clears dist/, then writes:
 *
 *   index.js               The entry (bin): turns on Node's compile cache, then
 *                          loads cli.js. Rewritten on every build, with a digest of
 *                          cli.js and every chunk, since its mtime and size are the
 *                          build a worker records (src/worker/registry.ts).
 *   cli.js, chunk-*.js     The program (ESM), split: cli.js holds what every command
 *                          needs, and each command's own code (and the node builtins
 *                          it imports) is a chunk loaded when that command runs.
 *                          Small pure-JS dependencies are inlined, so startup is a
 *                          few file reads instead of a node_modules walk. Chunks are
 *                          flat in dist/ so `import.meta.url` siblings resolve the
 *                          same from any of them.
 *   computer-tools.js      The computer tools on their own (hot-tools.ts reloads it).
 *   harness-catalog.cjs    The pure harness catalog (no AI SDKs); cheap to load.
 *   ai-router-runtime.cjs  streamAiChatTurn (`ai` + @ai-sdk providers);
 *                          only needed for local API-key model turns.
 *
 * --analyze prints a metafile report: top inputs by bytes and runtime externals.
 *
 * Always enforced (cheap, and each one is a broken publish if it regresses):
 *   - every package the program imports at runtime is in package.json `dependencies`
 *   - harness-catalog.cjs contains no node_modules code at all
 * */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, readFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** esbuild's native binary where it runs. Where it does not -- it needs a
 * newer OS than some machines ClikCode runs on: macOS 12, for a Mac on 10.15
 * -- the same esbuild compiled to WebAssembly: slower, the same output. */
async function loadEsbuild() {
  const native = await import('esbuild');
  try {
    await native.transform('');
    return native;
  } catch (error) {
    const wasm = await import('esbuild-wasm').catch(() => undefined);
    if (!wasm) throw error;
    const said = String(error?.message ?? error).split('\n').find((line) => line.trim()) ?? '';
    console.log(`esbuild's native binary does not run here (${said.slice(0, 200)}); building with esbuild-wasm ${wasm.version} instead.`);
    return wasm;
  }
}
const { build: esbuild } = await loadEsbuild();

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
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
// The commit this build is of, for ClikCode Remote's version handshake (src/remote): two machines
// on the same commit run the same code. Empty outside a git checkout (a packed tarball).
const commit = (() => {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; }
})();

/**
 * Inlined into cli.js. Pure JS, no native addons, no runtime file lookups
 * relative to their own package directory. Their transitive dependencies are
 * inlined with them. Everything else imported from source stays external and
 * must therefore be listed in package.json `dependencies`.
 */
const INLINE_PACKAGES = new Set(['chalk', 'commander', 'conf', 'cross-spawn', 'marked']);
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
  define: { __CLIKCODE_VERSION__: JSON.stringify(pkg.version), __CLIKCODE_COMMIT__: JSON.stringify(commit) },
};

// Inlined CommonJS packages (commander, cross-spawn, conf's ajv, …) call
// require() for node builtins; native ESM has no `require`, so provide one.
const index_banner = {
  js: [
    `import { createRequire as __clikcodeCreateRequire } from 'node:module';`,
    'const require = __clikcodeCreateRequire(import.meta.url);',
  ].join('\n'),
};

// Whatever an earlier build left (a chunk of an older program, a retired bundle) would be published.
await rm('dist', { recursive: true, force: true });

const index = await build({
  ...common,
  entryPoints: { cli: 'src/index.ts' },
  format: 'esm',
  plugins: [selectiveExternals],
  banner: index_banner,
  splitting: true,
  outdir: 'dist',
  chunkNames: 'chunk-[hash]',
});

// The computer tools on their own, so a rebuilt copy replaces the running one without restarting a
// chat (src/agent/computer/hot-tools.ts reloads this file when its time changes).
await build({
  ...common,
  entryPoints: ['src/agent/computer-tools-entry.ts'],
  format: 'esm',
  plugins: [selectiveExternals],
  banner: index_banner,
  outfile: 'dist/computer-tools.js',
});

// Compiling the program was ~30 ms of every start, and the catalog's CJS
// another ~10: the compile cache keeps V8's code per file content, so each is
// compiled once per build. It has to be on before cli.js is imported, hence a
// file of its own. The digest (of cli.js and every chunk) is there so this file
// changes with the program. It is a cache of code, not ClikCode state, so it
// lives in the user cache directory whatever CLIKCODE_HOME says
// (NODE_COMPILE_CACHE, if set, wins).
const programFiles = Object.keys(index.metafile.outputs).filter((path) => path.endsWith('.js')).sort();
const programHash = createHash('sha256');
for (const path of programFiles) programHash.update(path).update(await readFile(path));
const programDigest = programHash.digest('hex').slice(0, 16);
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

// The local model supervisor: a process of its own that outlives the window that started it
// (src/local-models/lifecycle.ts startSupervisor spawns this file by path).
await build({
  ...common,
  entryPoints: ['src/local-models/supervisor.ts'],
  format: 'cjs',
  outfile: 'dist/local-model-supervisor.cjs',
});

const router = await build({
  ...common,
  entryPoints: ['src/runtime/router.ts'],
  format: 'cjs',
  outfile: 'dist/ai-router-runtime.cjs',
});

if (process.platform !== 'win32') await chmod('dist/index.js', 0o755);
// The library that lets a vendor program built for a newer macOS start on an older Intel Mac (src/harness/compat/macos-legacy.ts).
await copyFile('native/macos-compat/libclikcode-compat-x64.dylib', 'dist/libclikcode-compat-x64.dylib');

// ---------------------------------------------------------------- guards ----

const failures = [];

/** cli.js and the chunks it imports statically: what `clikcode --version` reads, and the builtins they import. */
function startupImports(metafile) {
  const seen = new Set();
  const loaded = new Set();
  const visit = (path) => {
    if (seen.has(path) || !metafile.outputs[path]) return;
    seen.add(path);
    for (const item of metafile.outputs[path].imports) {
      if (item.kind !== 'import-statement') continue;
      if (!item.external) visit(item.path);
      else if (item.path.startsWith('node:') || builtins.has(item.path)) loaded.add(item.path);
    }
  };
  visit('dist/cli.js');
  return { bytes: [...seen].reduce((sum, path) => sum + metafile.outputs[path].bytes, 0), builtins: loaded };
}
const warnings = [];
const display = (path) => relative(root, join(root, path)).split('\\').join('/');

/** Packages a bundle imports at runtime; with no outfile, every output of the build (the program's chunks). */
function runtimeExternals(metafile, outfile) {
  const names = new Set();
  const outputs = outfile ? [metafile.outputs[outfile]] : Object.values(metafile.outputs);
  for (const item of outputs.flatMap((output) => output?.imports ?? [])) {
    if (!item.external || item.path.startsWith('node:') || builtins.has(item.path)) continue;
    if (item.path.startsWith('.') || item.path.startsWith('/')) continue;
    names.add(packageName(item.path));
  }
  return [...names].sort();
}

const indexExternals = runtimeExternals(index.metafile);
const routerExternals = runtimeExternals(router.metafile, 'dist/ai-router-runtime.cjs');
for (const name of [...indexExternals, ...routerExternals]) {
  if (!pkg.dependencies?.[name]) failures.push(`dist imports "${name}" at runtime but package.json "dependencies" does not list it`);
}
for (const name of Object.keys(pkg.dependencies ?? {})) {
  if (!indexExternals.includes(name) && !routerExternals.includes(name)) {
    warnings.push(`"${name}" is in package.json "dependencies" but nothing in dist imports it at runtime (bundled or unused: move to devDependencies)`);
  }
}

// What every start loads must stay small: the builtins below cost milliseconds each to load (node:http
// brings undici) and only a few commands use them, so each belongs in a chunk loaded by its command.
const STARTUP_FORBIDDEN = ['node:http', 'node:https', 'node:http2', 'node:zlib', 'node:worker_threads', 'node:net', 'node:tls', 'node:dns', 'node:readline'];
for (const name of startupImports(index.metafile).builtins) {
  if (STARTUP_FORBIDDEN.includes(name.startsWith('node:') ? name : `node:${name}`)) failures.push(`cli.js loads ${name} at every start (reached through a static import); import the module that needs it with await import()`);
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
  const outputs = outfile ? [metafile.outputs[outfile]] : Object.values(metafile.outputs);
  for (const [path, info] of outputs.flatMap((output) => Object.entries(output.inputs))) {
    const marker = path.lastIndexOf('node_modules/');
    const key = marker >= 0
      ? `npm:${packageName(path.slice(marker + 'node_modules/'.length))}`
      : path.includes(':') && !/^[a-zA-Z]:[\\/]/.test(path) ? path : display(path);
    rows.set(key, (rows.get(key) ?? 0) + info.bytesInOutput);
  }
  return [...rows.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

if (analyze) {
  for (const [metafile, outfile, limit] of [[index.metafile, undefined, 30], [catalog.metafile, 'dist/harness-catalog.cjs', 8], [router.metafile, 'dist/ai-router-runtime.cjs', 12]]) {
    const total = outfile ? metafile.outputs[outfile].bytes : Object.values(metafile.outputs).reduce((sum, output) => sum + output.bytes, 0);
    const startup = outfile ? '' : `, ${kb(startupImports(metafile).bytes)} loaded by every start`;
    console.log(`\n${outfile ?? `dist/cli.js + ${programFiles.length - 1} chunks`}  ${kb(total)}${startup}`);
    for (const [name, bytes] of topInputs(metafile, outfile, limit)) {
      console.log(`  ${kb(bytes).padStart(10)}  ${((bytes / total) * 100).toFixed(1).padStart(5)}%  ${name}`);
    }
  }
  console.log(`\nprogram runtime packages: ${indexExternals.join(', ') || '(none)'}`);
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
