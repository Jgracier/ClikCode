#!/usr/bin/env node

/** ClikCode — independent, local-first AI coding runtime. */
import Conf from 'conf';
import { buildBaseProgram, runProgram } from './cli/program-base.js';
import { registerClikCodeCommands } from './cli/register-clikcode.js';

const config = new Conf({ projectName: 'clikcode', configFileMode: 0o600 });
const program = buildBaseProgram(config)
  .name('clikcode')
  .description('A local-first AI coding runtime. Connect providers locally or optionally connect ClikDeploy Gateway.');

registerClikCodeCommands(program, config);
runProgram(program);
