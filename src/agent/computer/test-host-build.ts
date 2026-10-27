/** Test helper: builds the browser host entry from source (esbuild) and points the browser at it. */
import { quiet } from '../../runtime/lifecycle-log.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

export async function useSourceBrowserHost(): Promise<string> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  let root = here;
  while (!(await fs.stat(path.join(root, 'node_modules')).catch(quiet('agent/computer/test-host-build')))) {
    const up = path.dirname(root);
    if (up === root) throw new Error('No node_modules above the tests.');
    root = up;
  }
  const outfile = path.join(root, 'node_modules', '.cache', `clikcode-test-host-${process.pid}.mjs`);
  await build({ entryPoints: [path.join(here, 'test-host-entry.ts')], outfile, bundle: true, platform: 'node', format: 'esm', target: 'node22', external: ['playwright-core', 'playwright-core/*'], logLevel: 'silent', banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" } });
  process.env.CLIKCODE_BROWSER_HOST_ENTRY = outfile;
  return outfile;
}
