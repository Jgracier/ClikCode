/** The bridge protocol, taken from ClikCode's own source at build time (types
 * only; nothing of it is bundled), so the extension and the CLI cannot
 * disagree about a message's shape without the type-check failing. */
export type {
  ClientCommand, IdeAccount, IdeAccounts, IdeChatSettings, IdeChoice, IdeConversation, IdeEvent, IdeGateway, IdeModel, IdeModels,
  IdePickItem, IdeProvider, IdeQueryName, IdeRequest, IdeSlashCommand, IdeUiRequest, IdeUiResult, IdeUsageWindow, WorkerEvent,
} from '../../../src/ide/protocol.js';
export type { HarnessSession } from '../../../src/session/model.js';
export type { HarnessActivityEvent } from '../../../src/harness/prompter.js';
