/** ClikCode's chat, for a client that is not the editor (the ClikDeploy app).
 *
 * The editor's own model: the same reducer over the same bridge events, so a
 * chat reads the same on a phone as in VS Code, and a protocol change reaches
 * both from one place. Nothing here touches Node or VS Code; it is built into
 * one file by scripts/build-chat-client.mjs and vendored by the client. */
export * from '../vscode/src/model.js';
export { SessionDeltaReceiver } from '../../src/ide/session-delta.js';
export { IDE_PROTOCOL } from '../../src/ide/protocol-version.js';
export type {
  IdeAccount, IdeChoice, IdeConversation, IdeEvent, IdeFeature, IdeHostEvent, IdeHostRequest, IdeModelLabel, IdeModels, IdePickItem, IdeProvider,
  IdeQueryName, IdeRequest, IdeSlashCommand, IdeUiRequest, IdeUiResult, WorkerEvent, HarnessSession, FileDiff, HarnessQuestion, HarnessQuestionRequest, HarnessQuestionResult,
} from '../vscode/src/protocol.js';
