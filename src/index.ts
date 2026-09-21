/**
 * ClikCode — a local-first AI coding runtime.
 *
 * No shebang here on purpose: this file is only ever bundled, and
 * scripts/build.mjs's esbuild banner supplies dist/index.js's shebang
 * alongside the createRequire shim. A second one lands on line 2 of the
 * bundle, which node rejects outright.
 */
import Conf from 'conf';
import { buildBaseProgram, runProgram, CLIKCODE_BANNER } from './cli/program-base.js';
import { registerClikCodeCommands } from './cli/register-clikcode.js';
import { aiSessionOpenDefault } from './commands/ai-interactive.js';
import { CLIKCODE_VERSION } from './version.js';

const config = new Conf({ projectName: 'clikcode', configFileMode: 0o600 });
const program = buildBaseProgram(config, { banner: CLIKCODE_BANNER, version: CLIKCODE_VERSION })
  .name('clikcode')
  .description('A local-first AI coding runtime. Connect providers locally, or optionally connect a hosted gateway.')
  .action(() => aiSessionOpenDefault(config));

registerClikCodeCommands(program, config);
runProgram(program, { showHelpWhenBare: false, banner: CLIKCODE_BANNER });
