/**
 * ClikCode — a local-first AI coding runtime.
 *
 * Bundled to dist/cli.js, which dist/index.js (written by scripts/build.mjs,
 * with the shebang) loads once Node's compile cache is on.
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
