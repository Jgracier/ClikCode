/** Tests run from source, where there is no dist/: the supervisor is built
 * from src (as scripts/build.mjs builds it) and startSupervisor pointed at it. */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

export async function useSourceSupervisor(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  const cache = join(here, '..', '..', 'node_modules', '.cache');
  mkdirSync(cache, { recursive: true });
  const outfile = join(cache, `clikcode-test-supervisor-${process.pid}.cjs`);
  await build({ entryPoints: [join(here, 'supervisor.ts')], outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'silent' });
  process.env.CLIKCODE_SUPERVISOR_ENTRY = outfile;
  return outfile;
}
