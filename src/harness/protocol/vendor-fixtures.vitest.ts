/** One minimal vendor harness definition, shared by the parsing suites so a
 * change to the shape it models lands in one place. */

import type { AiLocalHarnessDefinition } from '../definition.js';

export const codex = {
  command: 'codex',
  provider: 'codex',
  displayName: 'Codex',
  surface: 'terminal',
  tier: 'primary',
  transport: 'structured-cli',
  parser: 'codex-items',
  memoryFile: 'AGENTS.md',
  nativeSlashPassthrough: false,
  localAuth: ['vendor-cli'],
  binary: 'codex',
  turn: {
    startArgv: [],
    output: 'json-lines',
    responseFields: ['text'],
  },
} satisfies AiLocalHarnessDefinition;
