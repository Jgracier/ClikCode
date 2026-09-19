/** Public surface of the ClikCode gateway harness. */
export { runGatewayHarnessTurn, classifyModelError, DEFAULT_MAX_STEPS, NO_PROGRESS_LIMIT } from './run-turn.js';
export type {
  AiHarnessPermissionMode, ConversationItem, GatewayHarnessTurnInput, GatewayHarnessTurnResult, HarnessActivityEvent,
  HarnessErrorKind, HarnessHooks, ModelClient, ModelStepRequest, ModelStepResult, ModelToolCall, NetworkSeams, PinnedResponse,
  PlanEntry, ResolvedAddress, TokenUsage, ToolClass, ToolContext, ToolDefinition, ToolRunResult, ToolSpec, UsageReport,
} from './types.js';
export { defineTool, isTurnCancelled, turnCancelledError, TURN_CANCELLED_CODE } from './types.js';

export { GatewayModelClient, ModelClientError, SseParser, errorKindForCode, errorKindForStatus, parseRetryAfter } from './model-clients/gateway-model-client.js';
export type { GatewayModelClientOptions, SseEvent } from './model-clients/gateway-model-client.js';
export { RouterModelClient, routerUsage } from './model-clients/router-model-client.js';
export type { RouterModelClientOptions, RouterTurnInput, RouterTurnResult } from './model-clients/router-model-client.js';

export { ConversationStore, flattenForTransport, repairDanglingCalls, toStructuredMessages, transcriptPath } from './conversation.js';
export type { FlatMessage, FlattenOptions, StructuredMessage, StructuredPart, TranscriptRecord } from './conversation.js';

export { FileCheckpointStore, BASH_UNDO_CAVEAT, newTurnId } from './file-checkpoints.js';
export type { CheckpointEntry, CheckpointManifest, CheckpointTurnSummary, UndoOptions, UndoResult } from './file-checkpoints.js';

export {
  buildSystemPrompt, compactConversation, elideOldToolResults, estimateContextTokens, estimateItemTokens, estimateTextTokens,
  loadMemoryChain, shouldCompact, COMPACTION_THRESHOLD, DEFAULT_CONTEXT_WINDOW, MEMORY_CAP_BYTES, STATIC_INSTRUCTIONS,
} from './context.js';
export type { CompactionInput, CompactionResult, SystemPromptInput } from './context.js';

export {
  addPermissionAllowRule, buildApprovalPrompt, decidePermission, loadPermissionRules, parsePermissionRule, parsePermissionRules,
  permissionSettingsPath, suggestPermissionRule, visibleTools, NO_RULES,
} from './permissions.js';
export type { ApprovalPrompt, PermissionDecision, PermissionRequest, PermissionRule, PermissionRules, PermissionVerdict } from './permissions.js';

export {
  capHeadTail, classifyCommand, eventOutputPreview, readDenyReason, redactSecrets, resolveConfined, resolvePath, scrubEnvironment,
  toolOutputDir, writeDenyReason, ConfinementError, OUTPUT_CAPS, SCRUBBED_ENV_PATTERN,
} from './security.js';
export type { CommandClassification, CommandTier, PathScope, ResolvedPath } from './security.js';

export { disposeSessionState, sessionState } from './session-state.js';
export type { BackgroundShell, HarnessSessionState } from './session-state.js';
export { defaultTools, mergeTools, toolSpecs } from './tools/registry.js';
export { addUsage, aggregateUsage, emptyLedger, recordUsage } from './usage.js';
export type { UsageLedger, UsageLedgerEntry } from './usage.js';
export { matchGlob, globToRegExp } from './glob-match.js';
export { diffLines, eventDiff, renderDiffPreview } from './line-diff.js';
export { validateAgainstSchema } from './schema-validate.js';
