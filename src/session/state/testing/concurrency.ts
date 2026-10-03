/** Runs real, separate ClikCode processes against one CLIKCODE_HOME, for
 * tests of what many terminals and workers do to the same state at once. */

import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

let bundled: Promise<string> | undefined;

/** The child script, bundled once per test file. */
function childScript(): Promise<string> {
  bundled ??= (async () => {
    const outdir = await mkdtemp(join(tmpdir(), 'clikcode-concurrency-'));
    const outfile = join(outdir, 'child.mjs');
    await build({
      entryPoints: [join(dirname(fileURLToPath(import.meta.url)), 'concurrency-child.ts')],
      bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent',
      banner: { js: "import { createRequire as __childRequire } from 'node:module'; const require = __childRequire(import.meta.url);" },
    });
    return outfile;
  })();
  return bundled;
}

export interface ChildResult { code: number | null; stderr: string }

/** Runs one child scenario to completion (or `timeoutMs`, then kills it). */
export async function runChild(home: string, args: string[], timeoutMs = 60_000): Promise<ChildResult> {
  const script = await childScript();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: { ...process.env, CLIKCODE_HOME: home }, stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    const timer = setTimeout(() => { stderr += '\n[timed out]'; child.kill('SIGKILL'); }, timeoutMs);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stderr }); });
  });
}
