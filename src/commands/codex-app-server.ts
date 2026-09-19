import { spawnPortable as spawn, terminatePortable } from './spawn-portable.js';
import type { AiHarnessPermissionMode, HarnessActivityEvent } from './types.js';

type JsonObject = Record<string, unknown>;

export interface CodexAppServerTurnInput {
  binary: string;
  prompt: string;
  nativeSessionId?: string;
  cwd: string;
  model?: string | null;
  effort?: string;
  permissionMode: AiHarnessPermissionMode;
  images?: readonly string[];
  environment?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
  onSessionId?: (id: string) => Promise<void> | void;
  onResponseDelta?: (delta: string) => void;
  onActivity?: (event: HarnessActivityEvent) => void;
  onPhase?: (phase: string) => void;
  onApproval?: (title: string, detail?: string) => Promise<boolean>;
  /** Published only while a real active turn id exists. */
  onSteerReady?: (handler?: (text: string) => Promise<void>) => void;
}

export interface CodexAppServerTurnResult {
  text: string;
  nativeSessionId: string;
  isError?: boolean;
  statusCode?: number;
}

export function codexSteerParams(threadId: string, turnId: string, text: string): JsonObject {
  return {
    threadId, expectedTurnId: turnId,
    input: [{ type: 'text', text, text_elements: [] }],
  };
}

export function codexActivityForItem(item: JsonObject, completed: boolean): HarnessActivityEvent | undefined {
  const type = String(item.type ?? '');
  const id = typeof item.id === 'string' ? item.id : undefined;
  if (type === 'commandExecution') {
    return { kind: completed ? 'tool-done' : 'tool-start', label: String(item.command ?? 'command'), ...(id ? { id } : {}) };
  }
  if (type === 'fileChange') return { kind: completed ? 'tool-done' : 'tool-start', label: 'files updated', ...(id ? { id } : {}) };
  if (type === 'mcpToolCall' || type === 'dynamicToolCall' || type === 'collabAgentToolCall') {
    return { kind: completed ? 'tool-done' : 'tool-start', label: String(item.tool ?? item.server ?? 'tool'), ...(id ? { id } : {}) };
  }
  if (type === 'webSearch') return { kind: completed ? 'tool-done' : 'tool-start', label: 'web search', ...(id ? { id } : {}) };
  if (type === 'reasoning' && completed) {
    const summary = Array.isArray(item.summary) ? item.summary.filter((part): part is string => typeof part === 'string').join(' ') : '';
    if (summary) return { kind: 'thinking', label: summary.replace(/\s+/g, ' ').slice(0, 140) };
  }
  return undefined;
}

export function codexPermissionSettings(mode: AiHarnessPermissionMode): {
  approvalPolicy: 'never' | 'on-request'; sandbox: 'danger-full-access' | 'workspace-write'; approvalsReviewer: 'user' | 'auto_review';
} {
  return mode === 'bypass'
    ? { approvalPolicy: 'never', sandbox: 'danger-full-access', approvalsReviewer: 'user' }
    : { approvalPolicy: 'on-request', sandbox: 'workspace-write', approvalsReviewer: mode === 'auto' ? 'auto_review' : 'user' };
}

/** One Codex turn over the documented app-server JSONL protocol. Unlike
 * `codex exec --json`, app-server publishes real agent-message deltas and
 * server-initiated approval requests, both of which a rich terminal client
 * must handle to preserve streaming and permission semantics together. */
export function runCodexAppServerTurn(input: CodexAppServerTurnInput): Promise<CodexAppServerTurnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.binary, ['app-server', '--stdio'], {
      cwd: input.cwd, env: { ...process.env, ...input.environment }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let stdoutPending = '';
    let stderr = '';
    let settled = false;
    let nextId = 1;
    let threadId = input.nativeSessionId;
    let turnId: string | undefined;
    let lastAgentMessage = '';
    let streamedMessage = '';
    const pending = new Map<number, (message: JsonObject) => void>();
    const send = (message: JsonObject): void => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const request = (method: string, params: JsonObject): Promise<JsonObject> => new Promise((resolveRequest, rejectRequest) => {
      const id = nextId++;
      pending.set(id, (message) => {
        if (message.error) rejectRequest(new Error(String((message.error as JsonObject).message ?? `${method} failed`)));
        else resolveRequest((message.result as JsonObject) ?? {});
      });
      send({ method, id, params });
    });
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      input.onSteerReady?.(undefined);
      input.signal?.removeEventListener('abort', abort);
      terminatePortable(child);
      if (error) reject(error);
      else if (!threadId || !(lastAgentMessage || streamedMessage).trim()) reject(new Error('Codex returned no assistant text'));
      else resolve({ text: (lastAgentMessage || streamedMessage).trim(), nativeSessionId: threadId });
    };
    const abort = (): void => {
      if (threadId && turnId) void request('turn/interrupt', { threadId, turnId }).catch(() => undefined);
      finish(Object.assign(new Error('Stopped'), { code: 'ERR_TURN_CANCELLED' }));
    };
    const approval = async (message: JsonObject): Promise<void> => {
      const method = String(message.method ?? '');
      const params = (message.params as JsonObject) ?? {};
      const title = method.includes('fileChange') ? 'Approve file changes' : 'Approve command';
      const detail = String(params.reason ?? params.command ?? 'Codex requested additional permission');
      const accepted = input.permissionMode === 'bypass' || input.permissionMode === 'auto'
        ? true
        : await input.onApproval?.(title, detail) ?? false;
      send({ id: message.id, result: { decision: accepted ? 'accept' : 'decline' } });
    };
    const notification = async (message: JsonObject): Promise<void> => {
      const method = String(message.method ?? '');
      const params = (message.params as JsonObject) ?? {};
      if (method.endsWith('/requestApproval') && message.id !== undefined) return approval(message);
      if (method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
        streamedMessage += params.delta;
        input.onResponseDelta?.(params.delta);
        input.onPhase?.('generating response');
      } else if (method === 'item/started' || method === 'item/completed') {
        const item = (params.item as JsonObject) ?? {};
        if (item.type === 'agentMessage' && method === 'item/started') {
          if (streamedMessage) input.onResponseDelta?.('\n\n');
          streamedMessage = '';
        }
        if (item.type === 'agentMessage' && method === 'item/completed' && typeof item.text === 'string') lastAgentMessage = item.text;
        const activity = codexActivityForItem(item, method === 'item/completed');
        if (activity) input.onActivity?.(activity);
      } else if (method === 'turn/completed') {
        const turn = (params.turn as JsonObject) ?? {};
        const error = turn.error as JsonObject | undefined;
        if (turn.status === 'failed') return finish(new Error(String(error?.message ?? 'Codex turn failed')));
        finish();
      } else if (method === 'error') {
        const error = (params.error as JsonObject) ?? {};
        if (typeof error.message === 'string') stderr = error.message;
      }
    };
    const handleLine = (line: string): void => {
      let message: JsonObject;
      try { message = JSON.parse(line) as JsonObject; } catch { return; }
      if (typeof message.id === 'number' && !message.method) {
        const resolver = pending.get(message.id);
        if (resolver) { pending.delete(message.id); resolver(message); }
      } else void notification(message).catch((error) => finish(error instanceof Error ? error : new Error(String(error))));
    };
    child.stdout.on('data', (chunk: string) => {
      const lines = (stdoutPending + chunk).split(/\r?\n/);
      stdoutPending = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) handleLine(line);
    });
    child.stderr.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-8000); });
    child.stdin.on('error', (error) => finish(error));
    child.once('error', (error) => finish(error));
    child.once('exit', (code) => { if (!settled) finish(new Error(stderr.trim() || `Codex app-server exited ${code ?? 1}`)); });
    input.signal?.addEventListener('abort', abort, { once: true });
    void (async () => {
      await request('initialize', { clientInfo: { name: 'clikcode', title: 'ClikCode', version: '1' }, capabilities: { experimentalApi: false, requestAttestation: false } });
      send({ method: 'initialized' });
      const params = {
        cwd: input.cwd, model: input.model ?? null, ...codexPermissionSettings(input.permissionMode),
      };
      const threadResult = input.nativeSessionId
        ? await request('thread/resume', { threadId: input.nativeSessionId, ...params })
        : await request('thread/start', params);
      const thread = threadResult.thread as JsonObject;
      threadId = String(thread.id ?? input.nativeSessionId ?? '');
      if (!threadId) throw new Error('Codex app-server did not return a thread id');
      await input.onSessionId?.(threadId);
      const turnResult = await request('turn/start', {
        threadId,
        input: [
          { type: 'text', text: input.prompt, text_elements: [] },
          ...(input.images ?? []).map((path) => ({ type: 'localImage', path })),
        ],
        cwd: input.cwd, model: input.model ?? null, effort: input.effort ?? null,
      });
      turnId = String(((turnResult.turn as JsonObject) ?? {}).id ?? '');
      if (!turnId) throw new Error('Codex app-server did not return a turn id');
      input.onSteerReady?.(async (text) => {
        await request('turn/steer', codexSteerParams(threadId!, turnId!, text));
      });
    })().catch((error) => finish(error instanceof Error ? error : new Error(String(error))));
  });
}
