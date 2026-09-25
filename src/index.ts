/**
 * ClikCode — a local-first AI coding runtime.
 *
 * No shebang here on purpose: this file is only ever bundled, and
 * scripts/build.mjs's esbuild banner supplies dist/index.js's shebang
 * alongside the createRequire shim. A second one lands on line 2 of the
 * bundle, which node rejects outright.
 */
import Conf from 'conf';
import { buildBaseProgram, runProgram, CLIKCODE_BANNER } from './cli/program.js';
import { registerClikCodeCommands } from './cli/register.js';
import { aiSessionOpenDefault } from './commands/ai/interactive.js';
import { CLIKCODE_VERSION } from './version.js';

const config = new Conf({ projectName: 'clikcode', configFileMode: 0o600 });
const program = buildBaseProgram(config, { banner: CLIKCODE_BANNER, version: CLIKCODE_VERSION })
  .name('clikcode')
  .description('The terminal harness that logs in all your favorite AI coding providers. Chats you can resume in any of them, and automatic account switching when you hit a usage limit.')
  .option('-c, --continue', 'reopen your latest chat (in this folder, if there is one)')
  .action((options: { continue?: boolean }) => aiSessionOpenDefault(config, options));

registerClikCodeCommands(program, config);
runProgram(program, { showHelpWhenBare: false, banner: CLIKCODE_BANNER });
