/** Shared Agent Client Protocol transport. Providers that publish ACP can use
 * this one lifecycle/stream/approval implementation instead of accumulating
 * another vendor-shaped JSON parser. The existing CLI adapter remains the
 * compatibility fallback for products without ACP. */
import type { AiHarnessPermissionMode, HarnessActivityEvent } from './types.js';
import { spawnPortable as spawn, terminatePortable } from './spawn-portable.js';

type Json = Record<string, any>;

const ACP_ARGV: Readonly<Record<string, readonly string[]>> = {
  cline: ['--acp'],
  copilot: ['--acp', '--stdio'],
  droid: ['exec', '--output-format', 'acp'],
  hermes: ['acp'],
};

export function acpArgvForHarness(command: string): readonly string[] | undefined {
  return ACP_ARGV[command];
}

export interface AcpTurnInput {
  binary: string;
  command: string;
  cwd: string;
  prompt: string;
  nativeSessionId?: string;
  environment: Readonly<Record<string, string>>;
  permissionMode: AiHarnessPermissionMode;
  model?: string | null;
  effort?: string | null;
  signal?: AbortSignal;
  onSessionId?: (id: string) => void | Promise<void>;
  onResponseDelta?: (delta: string) => void;
  onActivity?: (event: HarnessActivityEvent) => void;
  onApproval?: (title: string, detail?: string) => Promise<boolean>;
}

export interface AcpTurnResult { text: string; nativeSessionId: string }

export function acpResponseDelta(update: Json): string | undefined {
  return update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text' && typeof update.content.text === 'string'
    ? update.content.text : undefined;
}

export function acpActivityEvent(update: Json): HarnessActivityEvent | undefined {
  if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return undefined;
  const completed = ['completed', 'failed'].includes(String(update.status));
  const diff = Array.isArray(update.content)
    ? update.content.flatMap((entry: Json) => entry?.type === 'diff'
      ? [{ removed: String(entry.oldText ?? '').split(/\r?\n/), added: String(entry.newText ?? '').split(/\r?\n/) }]
      : [])[0]
    : undefined;
  return {
    kind: completed ? 'tool-done' : 'tool-start',
    label: String(update.title ?? update.name ?? 'tool'),
    ...(typeof update.toolCallId === 'string' ? { id: update.toolCallId } : {}),
    ...(diff ? { diff } : {}),
  };
}

export function runAcpTurn(input: AcpTurnInput): Promise<AcpTurnResult> {
  const argv = acpArgvForHarness(input.command);
  if (!argv) return Promise.reject(new Error(`${input.command} has no ACP adapter`));
  return new Promise((resolve, reject) => {
    const configuredOptions = [
      ...(input.model ? ['--model', input.model] : []),
      ...(input.effort && input.command === 'cline' ? ['--thinking', input.effort] : []),
      ...(input.effort && input.command === 'copilot' ? ['--effort', input.effort] : []),
      ...(input.effort && input.command === 'droid' ? ['--reasoning-effort', input.effort] : []),
      ...(input.effort && input.command === 'hermes' ? ['--reasoning', input.effort] : []),
      ...(input.permissionMode === 'bypass' ? input.command === 'cline' ? ['--auto-approve', 'true'] : input.command === 'cursor' ? ['--force'] : input.command === 'copilot' ? ['--allow-all'] : input.command === 'droid' ? ['--skip-permissions-unsafe'] : input.command === 'hermes' ? ['--yolo'] : [] : []),
      ...(input.permissionMode === 'auto' && input.command === 'droid' ? ['--auto', 'low'] : []),
      ...(input.permissionMode === 'auto' ? input.command === 'cline' ? ['--auto-approve', 'true'] : input.command === 'cursor' ? ['--auto-review'] : [] : []),
    ];
    // Droid's model/autonomy flags belong to the `exec` subcommand. Other ACP
    // harnesses publish root-level configuration flags before their ACP mode.
    const configuredArgv = input.command === 'droid' ? [...argv, ...configuredOptions] : [...configuredOptions, ...argv];
    const child = spawn(input.binary, configuredArgv, { cwd: input.cwd, env: { ...process.env, ...input.environment }, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let pendingText = '';
    let stderr = '';
    let nextId = 1;
    let settled = false;
    let sessionId = input.nativeSessionId;
    let promptStarted = false;
    let stdoutNoise = '';
    const pending = new Map<number, { resolve: (value: Json) => void; reject: (error: Error) => void }>();
    const send = (message: Json): void => { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`); };
    const request = (method: string, params: Json): Promise<Json> => new Promise((resolveRequest, rejectRequest) => {
      const id = nextId++;
      pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
      send({ id, method, params });
    });
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      input.signal?.removeEventListener('abort', abort);
      terminatePortable(child);
      if (error) {
        Object.assign(error, { acpSafeToFallback: !promptStarted });
        reject(error);
      }
      else if (!sessionId || !pendingText.trim()) reject(new Error(`${input.command} ACP returned no assistant text`));
      else resolve({ text: pendingText.trim(), nativeSessionId: sessionId });
    };
    const abort = (): void => {
      if (sessionId) send({ method: 'session/cancel', params: { sessionId } });
      finish(Object.assign(new Error('Stopped'), { code: 'ERR_TURN_CANCELLED' }));
    };
    const respondToPermission = async (message: Json): Promise<void> => {
      const params = message.params ?? {};
      const options: Json[] = Array.isArray(params.options) ? params.options : [];
      const allow = options.find((option) => String(option.kind).startsWith('allow'));
      const rejectOption = options.find((option) => String(option.kind).startsWith('reject'));
      const title = String(params.toolCall?.title ?? params.toolCall?.name ?? 'Approve tool');
      const accepted = input.permissionMode !== 'ask' || await input.onApproval?.(title) === true;
      const selected = accepted ? allow : rejectOption;
      send({ id: message.id, result: selected ? { outcome: { outcome: 'selected', optionId: selected.optionId } } : { outcome: { outcome: 'cancelled' } } });
    };
    const serverMessage = async (message: Json): Promise<void> => {
      if (message.method === 'session/request_permission' && message.id !== undefined) return respondToPermission(message);
      if (message.id !== undefined && message.method) {
        send({ id: message.id, error: { code: -32601, message: `Unsupported client method: ${message.method}` } });
        return;
      }
      if (message.method !== 'session/update') return;
      const update = message.params?.update ?? {};
      const delta = promptStarted ? acpResponseDelta(update) : undefined;
      if (delta) { pendingText += delta; input.onResponseDelta?.(delta); }
      const activity = acpActivityEvent(update);
      if (activity) input.onActivity?.(activity);
    };
    const handleLine = (line: string): void => {
      let message: Json;
      try { message = JSON.parse(line) as Json; } catch { stdoutNoise = `${stdoutNoise}${line}\n`.slice(-8000); return; }
      if (typeof message.id === 'number' && !message.method) {
        const waiting = pending.get(message.id);
        if (!waiting) return;
        pending.delete(message.id);
        if (message.error) waiting.reject(new Error(String(message.error.message ?? 'ACP request failed')));
        else waiting.resolve(message.result ?? {});
      } else void serverMessage(message).catch((error) => finish(error instanceof Error ? error : new Error(String(error))));
    };
    child.stdout.on('data', (chunk: string) => {
      const lines = (pendingTextBuffer + chunk).split(/\r?\n/);
      pendingTextBuffer = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) handleLine(line);
    });
    let pendingTextBuffer = '';
    child.stderr.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-8000); });
    child.once('error', finish);
    child.once('exit', (code) => { if (!settled) finish(new Error(stderr.trim() || stdoutNoise.trim() || `${input.command} ACP exited ${code ?? 1}`)); });
    input.signal?.addEventListener('abort', abort, { once: true });

    void (async () => {
      const initialized = await request('initialize', {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: 'clikcode', title: 'ClikCode', version: '1' },
      });
      const capabilities = initialized.agentCapabilities ?? {};
      if (sessionId) {
        if (capabilities.sessionCapabilities?.resume) await request('session/resume', { sessionId, cwd: input.cwd, mcpServers: [] });
        else if (capabilities.loadSession) await request('session/load', { sessionId, cwd: input.cwd, mcpServers: [] });
        else throw new Error(`${input.command} ACP cannot load sessions`);
      } else {
        const created = await request('session/new', { cwd: input.cwd, mcpServers: [] });
        sessionId = String(created.sessionId ?? '');
        if (!sessionId) throw new Error(`${input.command} ACP did not return a session id`);
        await input.onSessionId?.(sessionId);
      }
      promptStarted = true;
      const completed = await request('session/prompt', { sessionId, prompt: [{ type: 'text', text: input.prompt }] });
      if (completed.stopReason === 'cancelled') throw Object.assign(new Error('Stopped'), { code: 'ERR_TURN_CANCELLED' });
      finish();
    })().catch((error) => finish(error instanceof Error ? error : new Error(String(error))));
  });
}
