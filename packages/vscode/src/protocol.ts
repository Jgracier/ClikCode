/** The bridge protocol, taken from ClikCode's own source at build time (types
 * only; nothing of it is bundled), so the extension and the CLI cannot
 * disagree about a message's shape without the type-check failing. */
export type {
  ClientCommand, IdeEvent, IdePickItem, IdeRequest, IdeSlashCommand, IdeUiRequest, IdeUiResult, WorkerEvent,
} from '../../../src/ide/protocol.js';
export type { HarnessSession } from '../../../src/session/model.js';
export type { HarnessActivityEvent } from '../../../src/harness/prompter.js';
