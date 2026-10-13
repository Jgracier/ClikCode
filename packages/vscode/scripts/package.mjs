/** `pnpm run package`: the .vsix, built for production.
 *
 * vsce runs `vscode:prepublish` through npm, and pnpm hands its own
 * npm_config_* settings to every script it runs -- which npm then warns
 * about ("Unknown env config"). They mean nothing to npm, so they are left
 * out of vsce's environment and the package builds without warnings.
 * Extra arguments are passed to vsce (e.g. `--out <path>`).
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const repo = join(root, '..', '..');

/** The ClikCode that ships inside the extension, so one Marketplace install works with nothing
 * else on the machine (src/runtime.ts uses it only when no ClikCode is installed).
 *
 *   bundled/clikcode/dist/                         the CLI build (pnpm build:strict output)
 *   bundled/clikcode/package.json                  "type": "module", so dist/index.js loads as ESM
 *   bundled/clikcode/node_modules/<name>/index.mjs each package dist/ imports at runtime, bundled
 *                                                  with its own dependencies into ONE file
 *
 * One file per package, not the package: vsce warns past 100 JavaScript files, and the ones dist
 * needs (yaml, @huggingface/gguf and its @huggingface/tasks) are over 350 of them, half of those
 * browser or ESM duplicates Node never loads. The export names are read from the real package, so
 * the wrapper is a static ESM module (`import { parse } from 'yaml'` needs that) and cannot drift
 * from what the package offers.
 */
async function stageClikcode() {
  const rootPackage = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  if (!existsSync(join(repo, 'dist', 'index.js'))) {
    const built = spawnSync(process.execPath, [join(repo, 'scripts', 'build.mjs')], { cwd: repo, stdio: 'inherit' });
    if (built.status !== 0) process.exit(built.status ?? 1);
  }
  const target = join(root, 'bundled', 'clikcode');
  rmSync(join(root, 'bundled'), { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  cpSync(join(repo, 'dist'), join(target, 'dist'), { recursive: true });
  writeFileSync(join(target, 'package.json'), `${JSON.stringify({
    name: rootPackage.name, version: rootPackage.version, type: 'module', engines: rootPackage.engines,
    dependencies: rootPackage.dependencies,
  }, null, 2)}\n`);

  const rootRequire = createRequire(join(repo, 'package.json'));
  const esbuild = rootRequire('esbuild');
  const staged = [];
  for (const name of Object.keys(rootPackage.dependencies ?? {})) {
    const entry = rootRequire.resolve(name);
    const exported = rootRequire(name);
    const names = Object.keys(exported).filter((key) => key !== 'default' && key !== '__esModule' && /^[A-Za-z_$][\w$]*$/.test(key));
    const dir = join(target, 'node_modules', name);
    mkdirSync(dir, { recursive: true });
    await esbuild.build({
      stdin: {
        contents: `import * as m from ${JSON.stringify(entry)};\nexport const { ${names.join(', ')} } = m;\nexport default m;\n`,
        resolveDir: repo, sourcefile: `${name}.entry.js`,
      },
      bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile: join(dir, 'index.mjs'), logLevel: 'error',
      // A bundled CommonJS package that requires a Node built-in needs a `require` in an ES module.
      banner: { js: "import { createRequire as __clikcodeCreateRequire } from 'node:module';\nconst require = __clikcodeCreateRequire(import.meta.url);" },
    });
    // Not require.resolve(`${name}/package.json`): a package's `exports` need not offer it.
    let manifestDir = dirname(entry);
    while (!existsSync(join(manifestDir, 'package.json')) || JSON.parse(readFileSync(join(manifestDir, 'package.json'), 'utf8')).name !== name) {
      if (dirname(manifestDir) === manifestDir) throw new Error(`no package.json for ${name} above ${entry}`);
      manifestDir = dirname(manifestDir);
    }
    const manifest = JSON.parse(readFileSync(join(manifestDir, 'package.json'), 'utf8'));
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
      name, version: manifest.version, type: 'module', main: './index.mjs', exports: { '.': './index.mjs', './package.json': './package.json' },
    }, null, 2)}\n`);
    staged.push(`${name} (${names.length} exports)`);
  }
  console.log(`bundled ClikCode ${rootPackage.version}: dist + ${staged.join(', ')}`);
}
await stageClikcode();

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_(config|package|lifecycle)_/i.test(key)));
const vsce = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'vsce.cmd' : 'vsce');
const extra = process.argv.slice(2);
const args = ['package', '--no-dependencies', ...(extra.includes('--out') ? [] : ['--out', `clikcode-${version}.vsix`]), ...extra];
const result = spawnSync(vsce, args, { cwd: root, env, stdio: 'inherit', shell: process.platform === 'win32' });
process.exit(result.status ?? 1);
