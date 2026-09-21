/** ModelClient over the bundled router runtime (`streamLocalAiTurn` →
 * clikrouter's streamAiChatTurn). That transport carries only
 * `{role, content}` string messages and returns tool calls without ids, so
 * the conversation is string-threaded and call ids are synthesized here. */
import { randomUUID } from 'node:crypto';
import { streamLocalAiTurn } from '../../runtime/lazy-bridge.js';
import { flattenForTransport, type FlatMessage } from '../conversation.js';
import type { ModelClient, ModelStepRequest, ModelStepResult, TokenUsage } from '../model-client.js';

/** Mirrors clikrouter's AiChatTurnInput (packages/clikrouter/src/ai-provider-models.ts). */
export interface RouterTurnInput {
  provider: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  credentialSource?: 'oauth' | 'platform-secret' | 'env';
  accountId?: string;
  projectId?: string;
  system?: string;
  cachePrompt?: boolean;
  messages: FlatMessage[];
  tools?: { name: string; description: string; parameters: Record<string, unknown> }[];
  temperature?: number;
  maxOutputTokens?: number;
  abortSignal?: AbortSignal;
  onDelta?: (text: string) => void;
  reasoningEffort?: string;
}

/** Mirrors the parts of AiChatTurnResult this client reads. */
export interface RouterTurnResult {
  text?: string;
  toolCalls?: { name: string; args: Record<string, unknown> }[];
  usage?: {
    inputTokens?: number; outputTokens?: number; uncachedInputTokens?: number;
    cachedInputTokens?: number; cacheWriteInputTokens?: number; reasoningTokens?: number;
  };
  stopReason?: string;
  costMicroUsd?: number;
  servedModel?: string;
  warnings?: { type: string; feature?: string; details?: string }[];
}

export interface RouterModelClientOptions {
  provider: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  credentialSource?: 'oauth' | 'platform-secret' | 'env';
  accountId?: string;
  projectId?: string;
  reasoningEffort?: string;
  maxOutputTokens?: number;
  contextWindow?: number;
  /** An agent loop re-sends the same prefix every step, which is exactly the
   * case explicit prompt caching pays for. Default true. */
  cachePrompt?: boolean;
  /** Injected for tests; defaults to the real router bridge. */
  streamTurn?: (input: RouterTurnInput) => Promise<RouterTurnResult>;
  newId?: () => string;
}

const TOOL_PROTOCOL_NOTE = `\n\n# Tool transcript format
Earlier tool activity appears in the conversation as text: lines starting with "[tool call <id>]" are calls you made, and user messages starting with "Tool result for" are their outputs from the harness. Never write either form yourself — to use a tool, make a real tool call.`;

export function routerUsage(result: RouterTurnResult): TokenUsage {
  const usage = result.usage ?? {};
  const out: TokenUsage = {};
  if (typeof usage.inputTokens === 'number') out.input = usage.inputTokens;
  if (typeof usage.outputTokens === 'number') out.output = usage.outputTokens;
  if (typeof usage.cachedInputTokens === 'number') out.cached = usage.cachedInputTokens;
  if (typeof usage.cacheWriteInputTokens === 'number') out.cacheWrite = usage.cacheWriteInputTokens;
  if (typeof usage.reasoningTokens === 'number') out.reasoning = usage.reasoningTokens;
  if (typeof result.costMicroUsd === 'number') out.costMicroUsd = result.costMicroUsd;
  return out;
}

export class RouterModelClient implements ModelClient {
  constructor(private readonly options: RouterModelClientOptions) {}

  async step(request: ModelStepRequest): Promise<ModelStepResult> {
    const { options } = this;
    const stream = options.streamTurn ?? ((input: RouterTurnInput) => streamLocalAiTurn(input as unknown as Record<string, unknown>) as Promise<RouterTurnResult>);
    const result = await stream({
      provider: options.provider,
      model: options.model,
      ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
      ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
      ...(options.credentialSource !== undefined ? { credentialSource: options.credentialSource } : {}),
      ...(options.accountId !== undefined ? { accountId: options.accountId } : {}),
      ...(options.projectId !== undefined ? { projectId: options.projectId } : {}),
      ...(options.reasoningEffort !== undefined ? { reasoningEffort: options.reasoningEffort } : {}),
      ...(options.maxOutputTokens !== undefined ? { maxOutputTokens: options.maxOutputTokens } : {}),
      system: request.tools.length ? `${request.system}${TOOL_PROTOCOL_NOTE}` : request.system,
      cachePrompt: options.cachePrompt ?? true,
      messages: flattenForTransport(request.items),
      ...(request.tools.length ? { tools: request.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })) } : {}),
      ...(request.signal ? { abortSignal: request.signal } : {}),
      onDelta: (text: string) => request.onTextDelta(text),
    });
    const newId = options.newId ?? (() => `call_${randomUUID().replace(/-/g, '').slice(0, 16)}`);
    return {
      text: typeof result.text === 'string' ? result.text : '',
      toolCalls: (Array.isArray(result.toolCalls) ? result.toolCalls : []).map((call) => ({
        id: newId(), name: String(call.name), args: call.args && typeof call.args === 'object' ? call.args : {},
      })),
      stopReason: typeof result.stopReason === 'string' ? result.stopReason : 'stop',
      usage: routerUsage(result),
      // Not defaulted to the requested model: "the vendor confirmed X" and "the
      // vendor said nothing" are different facts (see AiChatTurnResult.servedModel).
      ...(typeof result.servedModel === 'string' && result.servedModel ? { servedModel: result.servedModel } : {}),
      ...(options.contextWindow ? { contextWindow: options.contextWindow } : {}),
    };
  }
}
