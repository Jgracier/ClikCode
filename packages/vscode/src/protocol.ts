/** The bridge protocol, taken from ClikCode's own source at build time (types
 * only; nothing of it is bundled), so the extension and the CLI cannot
 * disagree about a message's shape without the type-check failing. */
export type {
  IdeAccount, IdeAccounts, IdeChatSettings, IdeChoice, IdeConversation, IdeEvent, IdeFeature, IdeGateway, IdeModelLabel, IdeModels,
  IdePickItem, IdeProvider, IdeQueryName, IdeRequest, IdeSearchFocus, IdeSlashCommand, IdeUiRequest, IdeUiResult, WorkerEvent,
} from '../../../src/ide/protocol.js';
export type { HarnessSession } from '../../../src/session/model.js';
export type { HarnessActivityEvent } from '../../../src/harness/prompter.js';
export type { FileDiff } from '../../../src/agent/line-diff.js';
export type { HarnessQuestion, HarnessQuestionRequest, HarnessQuestionResult } from '../../../src/harness/events/question.js';
