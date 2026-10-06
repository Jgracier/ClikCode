/** Deterministic ModelClient for tests of the loop and of callers that wire
 * the harness in. No test-framework imports, so it is safe to ship. */
import type { ModelClient, ModelStepRequest, ModelStepResult, ModelToolCall, TokenUsage } from './model-client.js';

export interface ScriptedStep {
  text?: string;
  /** Streamed through onTextDelta chunk by chunk; defaults to one chunk of `text`. */
  deltas?: readonly string[];
  reasoning?: string;
  toolCalls?: readonly (Omit<ModelToolCall, 'id'> & { id?: string })[];
  usage?: TokenUsage;
  stopReason?: string;
  contextWindow?: number;
  servedModel?: string;
  error?: unknown;
  /** Runs before the step resolves (e.g. to steer or abort mid-step). */
  before?: (request: ModelStepRequest) => Promise<void> | void;
}

export type ScriptEntry = ScriptedStep | ((request: ModelStepRequest, index: number) => ScriptedStep | Promise<ScriptedStep>);

export class ScriptedModelClient implements ModelClient {
  readonly requests: ModelStepRequest[] = [];
  private index = 0;

  /** When the script runs out, `fallback` repeats; without one the step throws. */
  constructor(private readonly script: readonly ScriptEntry[], private readonly fallback?: ScriptEntry) {}

  async step(request: ModelStepRequest): Promise<ModelStepResult> {
    const position = this.index++;
    // Snapshot: the loop mutates its item array between steps.
    this.requests.push({ ...request, items: [...request.items], tools: [...request.tools] });
    const entry = this.script[position] ?? this.fallback;
    if (!entry) throw new Error(`ScriptedModelClient: no step scripted for call ${position + 1}`);
    const scripted = typeof entry === 'function' ? await entry(request, position) : entry;
    await scripted.before?.(request);
    if (scripted.error !== undefined) throw scripted.error;
    // A server names the model before it says anything.
    if (scripted.servedModel) request.onServedModel?.(scripted.servedModel, scripted.contextWindow);
    const text = scripted.text ?? (scripted.deltas ? scripted.deltas.join('') : '');
    for (const delta of scripted.deltas ?? (text ? [text] : [])) request.onTextDelta(delta);
    if (scripted.reasoning) request.onReasoningDelta?.(scripted.reasoning);
    const toolCalls = (scripted.toolCalls ?? []).map((call, offset): ModelToolCall => ({
      id: call.id ?? `call_${position + 1}_${offset + 1}`, name: call.name, args: call.args,
      ...(call.argumentsError ? { argumentsError: call.argumentsError } : {}),
    }));
    // Each call as a streaming server sends it: whole, in one delta.
    for (const call of toolCalls) request.onToolCallDelta?.({ id: call.id, name: call.name, arguments: JSON.stringify(call.args) });
    return {
      text,
      toolCalls,
      stopReason: scripted.stopReason ?? (scripted.toolCalls?.length ? 'tool-calls' : 'stop'),
      usage: scripted.usage ?? { input: 100, output: 10 },
      ...(scripted.contextWindow ? { contextWindow: scripted.contextWindow } : {}),
      ...(scripted.servedModel ? { servedModel: scripted.servedModel } : {}),
    };
  }
}
