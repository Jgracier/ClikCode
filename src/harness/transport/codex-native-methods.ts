/** Codex app-server methods ClikCode's transport does not call yet, as helpers over a
 * JSON-RPC peer. Shapes are from the schema `codex app-server generate-json-schema` writes
 * (codex-cli 0.155.1, ClientRequest + v2 definitions), not from memory:
 *
 *   turn/start            approvalPolicy | approvalsReviewer | sandboxPolicy | effort | model |
 *                         summary | cwd, all optional PER TURN -- so a permission, sandbox or
 *                         effort change needs no new app-server (the transport restarts it today
 *                         because it sends these only on thread/start|resume).
 *   thread/compact/start  { threadId } -> {}; the vendor compacts the thread in place and reports
 *                         it with the `thread/compacted` notification the transport already handles.
 *   model/list            { cursor, limit, includeHidden } -> { data: Model[], nextCursor }
 *   thread/list           { cwd, cursor, limit, searchTerm, sortKey, ... } -> { data: Thread[], nextCursor }
 *
 * The transport owner (codex-app-server.ts) wires these in; this file takes only a peer, so it
 * needs nothing from the transport and the transport can import it without a cycle. */
import type { AiHarnessPermissionMode } from '../definition.js';

/** What the helpers need of a JsonRpcPeer (jsonrpc-peer.ts satisfies it as is). */
export interface CodexRpcPeer {
  request(method: string, params: Record<string, any>, options?: { timeoutMs?: number; idleReset?: boolean }): Promise<Record<string, any>>;
}

type JsonObject = Record<string, unknown>;

/** The per-turn permission fields of `turn/start` for a ClikCode permission mode. Same policy as
 * the thread-level `codexPermissionSettings` (bypass: never ask, full access; ask and auto:
 * on-request in the workspace, auto routed to the auto reviewer), spelled the way TurnStartParams
 * does: `sandboxPolicy` is a tagged object, not the thread-level kebab string. */
export function codexTurnPermissionParams(mode: AiHarnessPermissionMode): {
  approvalPolicy: 'never' | 'on-request'; approvalsReviewer: 'user' | 'auto_review'; sandboxPolicy: { type: 'dangerFullAccess' | 'workspaceWrite' };
} {
  return mode === 'bypass'
    ? { approvalPolicy: 'never', approvalsReviewer: 'user', sandboxPolicy: { type: 'dangerFullAccess' } }
    : { approvalPolicy: 'on-request', approvalsReviewer: mode === 'auto' ? 'auto_review' : 'user', sandboxPolicy: { type: 'workspaceWrite' } };
}

/** Complete `turn/start` params, permission mode and effort included, so a change of either is
 * the next turn's parameters. `summary` is the ReasoningSummary the model returns (auto|concise|detailed|none). */
export function codexTurnStartParams(input: {
  threadId: string; prompt: string; images?: readonly string[]; cwd: string; model?: string | null; effort?: string | null;
  permissionMode: AiHarnessPermissionMode; summary?: 'auto' | 'concise' | 'detailed' | 'none';
}): JsonObject {
  return {
    threadId: input.threadId,
    input: [
      { type: 'text', text: input.prompt, text_elements: [] },
      ...(input.images ?? []).map((path) => ({ type: 'localImage', path })),
    ],
    cwd: input.cwd, model: input.model ?? null, effort: input.effort ?? null,
    ...(input.summary ? { summary: input.summary } : {}),
    ...codexTurnPermissionParams(input.permissionMode),
  };
}

/** `/compact` natively: the vendor summarizes and replaces the thread's own history. The answer is
 * empty; completion is the `thread/compacted` notification on the same connection, which the
 * transport turns into its "compacted the conversation" notice. */
export async function compactCodexThread(peer: CodexRpcPeer, threadId: string): Promise<void> {
  await peer.request('thread/compact/start', { threadId });
}

interface CodexModelInfo {
  id: string; model: string; displayName: string; isDefault: boolean; hidden: boolean;
  /** The model's default effort and the efforts it advertises (`supportedReasoningEfforts[].reasoningEffort`). */
  defaultEffort?: string; efforts: string[];
}

/** The account's models from the vendor itself (`model/list`), every page, in place of the private
 * models_cache.json. Hidden models are left out unless asked for. */
export async function listCodexModels(peer: CodexRpcPeer, options: { includeHidden?: boolean } = {}): Promise<CodexModelInfo[]> {
  const models: CodexModelInfo[] = [];
  let cursor: string | null = null;
  do {
    const page: Record<string, any> = await peer.request('model/list', { cursor, limit: 100, includeHidden: options.includeHidden ?? false });
    for (const entry of Array.isArray(page.data) ? page.data : []) {
      const model = typeof entry?.model === 'string' ? entry.model : typeof entry?.id === 'string' ? entry.id : '';
      if (!model) continue;
      const efforts = (Array.isArray(entry.supportedReasoningEfforts) ? entry.supportedReasoningEfforts : [])
        .map((option: { reasoningEffort?: unknown }) => option?.reasoningEffort).filter((effort: unknown): effort is string => typeof effort === 'string');
      models.push({
        id: String(entry.id ?? model), model, displayName: String(entry.displayName ?? model), isDefault: entry.isDefault === true, hidden: entry.hidden === true,
        ...(typeof entry.defaultReasoningEffort === 'string' ? { defaultEffort: entry.defaultReasoningEffort } : {}), efforts,
      });
    }
    cursor = typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : null;
  } while (cursor);
  return models;
}

interface CodexThreadInfo { id: string; name?: string; preview: string; cwd: string; createdAt: number; updatedAt: number }

/** Threads from the vendor (`thread/list`), newest first, in place of reading its session files.
 * `cwd` narrows to one folder; `limit` caps the total. */
export async function listCodexThreads(peer: CodexRpcPeer, options: { cwd?: string; searchTerm?: string; limit?: number } = {}): Promise<CodexThreadInfo[]> {
  const threads: CodexThreadInfo[] = [];
  const limit = options.limit ?? 100;
  let cursor: string | null = null;
  do {
    const page: Record<string, any> = await peer.request('thread/list', {
      cursor, limit: Math.min(100, limit - threads.length), sortKey: 'updated_at', sortDirection: 'desc',
      ...(options.cwd ? { cwd: options.cwd } : {}), ...(options.searchTerm ? { searchTerm: options.searchTerm } : {}),
    });
    for (const entry of Array.isArray(page.data) ? page.data : []) {
      if (typeof entry?.id !== 'string') continue;
      threads.push({
        id: entry.id, ...(typeof entry.name === 'string' && entry.name ? { name: entry.name } : {}), preview: String(entry.preview ?? ''),
        cwd: String(entry.cwd ?? ''), createdAt: Number(entry.createdAt ?? 0), updatedAt: Number(entry.updatedAt ?? 0),
      });
    }
    cursor = threads.length < limit && typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : null;
  } while (cursor);
  return threads;
}
