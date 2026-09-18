#!/usr/bin/env node

/** ClikCode — independent, local-first AI coding runtime. */
import Conf from 'conf';
import { buildBaseProgram, runProgram, CLIKCODE_BANNER } from './cli/program-base.js';
import { registerClikCodeCommands } from './cli/register-clikcode.js';
import { aiSessionOpenDefault } from './commands/ai.js';

const config = new Conf({ projectName: 'clikcode', configFileMode: 0o600 });
const program = buildBaseProgram(config, { lifecycleLock: false, banner: CLIKCODE_BANNER, standaloneClikCode: true, version: '1.0.0' })
  .name('clikcode')
  .description('A local-first AI coding runtime. Connect providers locally or optionally connect ClikDeploy Gateway.')
  .action(() => aiSessionOpenDefault(config));

registerClikCodeCommands(program, config);
runProgram(program, { showHelpWhenBare: false, banner: CLIKCODE_BANNER });
