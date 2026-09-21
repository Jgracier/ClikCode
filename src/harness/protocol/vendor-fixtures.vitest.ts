/** One minimal vendor harness definition, shared by the parsing suites so a
 * change to the shape it models lands in one place. */

import type { AiLocalHarnessDefinition } from '../types.js';

export const codex = {
  command: 'codex',
  provider: 'codex',
  displayName: 'Codex',
  surface: 'terminal',
  localAuth: ['vendor-cli'],
  binary: 'codex',
  turn: {
    startArgv: [],
    output: 'json-lines',
    responseFields: ['text'],
  },
} satisfies AiLocalHarnessDefinition;
