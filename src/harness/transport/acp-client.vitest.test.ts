import { describe, expect, it } from 'vitest';
import { acpActivityEvent, acpApprovalDetail, acpModelChoice, acpResponseDelta, acpSpawnArgv, acpVibeResponseChange, runAcpTurn } from './acp-client.js';

describe('shared ACP adapter contract', () => {
  it.each(['session/new', 'session/prompt'])('authenticates once over ACP when %s requires it', async (authAt) => {
    const agent = `
      const authAt = ${JSON.stringify(authAt)};
      const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
      const calls = []; let signedIn = false; let buf = '';
      process.stdin.on('data', (d) => { buf += d; let n; while ((n = buf.indexOf('\\n')) >= 0) {
        const m = JSON.parse(buf.slice(0, n)); buf = buf.slice(n + 1); calls.push(m.method);
        if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [{ id: 'browser', name: 'Browser sign-in' }] } });
        else if (m.method === 'authenticate') { signedIn = true; send({ id: m.id, result: {} }); }
        else if (m.method === authAt && !signedIn) send({ id: m.id, error: { code: -32000, message: 'Authentication is required before this operation can be performed.' } });
        else if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 's1' } });
        else if (m.method === 'session/prompt') {
          send({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(calls) } } } });
          send({ id: m.id, result: { stopReason: 'end_turn' } });
        }
      } });
    `;
    const result = await runAcpTurn({ binary: process.execPath, command: 'agent', argv: ['-e', agent], cwd: process.cwd(),
      prompt: 'check', environment: {}, permissionMode: 'ask', allowAgentAuth: true });
    expect(JSON.parse(result.text)).toEqual(['initialize', 'session/new', ...(authAt === 'session/new' ? ['authenticate', 'session/new', 'session/prompt'] : ['session/prompt', 'authenticate', 'session/prompt'])]);
  });

  it('sets model, permission mode, and effort over ACP before prompting', async () => {
    const agent = `
      const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
      const calls = [];
      let buf = '';
      process.stdin.on('data', (d) => { buf += d; let n; while ((n = buf.indexOf('\\n')) >= 0) {
        const m = JSON.parse(buf.slice(0, n)); buf = buf.slice(n + 1);
        if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: {} } });
        else if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 's1',
          configOptions: [
            { id: 'provider', currentValue: 'openrouter', options: [{ value: 'openrouter' }, { value: 'codex' }] },
            { id: 'model', currentValue: 'old', options: [{ value: 'old' }, { value: 'new' }] },
            { id: 'thinking_effort', currentValue: 'off', options: [{ value: 'off' }, { value: 'high' }] }
          ], modes: { currentModeId: 'auto', availableModes: [{ id: 'auto' }, { id: 'approve' }] } } });
        else if (m.method === 'session/set_config_option' || m.method === 'session/set_mode') {
          calls.push([m.method, m.params]);
          send({ id: m.id, result: m.params.configId === 'provider' ? { configOptions: [
            { id: 'provider', currentValue: 'codex', options: [{ value: 'openrouter' }, { value: 'codex' }] },
            { id: 'model', currentValue: 'old', options: [{ value: 'old' }, { value: 'new' }] },
            { id: 'thinking_effort', currentValue: 'off', options: [{ value: 'off' }, { value: 'high' }] }
          ] } : {} });
        } else if (m.method === 'session/prompt') {
          send({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(calls) } } } });
          send({ id: m.id, result: { stopReason: 'end_turn' } });
        }
      } });
    `;
    const result = await runAcpTurn({
      binary: process.execPath, command: 'goose', argv: ['-e', agent], cwd: process.cwd(),
      prompt: 'check', environment: {}, permissionMode: 'ask', model: 'codex/new', effort: 'high',
      modelRequiresProtocol: true, effortRequiresProtocol: true, effortConfigId: 'thinking_effort',
      providerConfigId: 'provider', modelProviderSeparator: '/',
      permissionModeIds: { ask: 'approve' },
    });
    expect(JSON.parse(result.text)).toEqual([
      ['session/set_config_option', { sessionId: 's1', configId: 'provider', value: 'codex' }],
      ['session/set_config_option', { sessionId: 's1', configId: 'model', value: 'new' }],
      ['session/set_mode', { sessionId: 's1', modeId: 'approve' }],
      ['session/set_config_option', { sessionId: 's1', configId: 'thinking_effort', value: 'high' }],
    ]);
  });

  it('normalizes agent prose and tool lifecycle events', () => {
    expect(acpResponseDelta({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } })).toBe('hello');
    expect(acpActivityEvent({ sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'Read config', status: 'pending' }))
      .toEqual({ kind: 'tool-start', id: 'call-1', label: 'Read config', category: 'read' });
    expect(acpActivityEvent({ sessionUpdate: 'tool_call_update', toolCallId: 'call-1', title: 'Read config', status: 'completed' }))
      .toEqual({ kind: 'tool-done', id: 'call-1', label: 'Read config', category: 'read' });
    expect(acpActivityEvent({ sessionUpdate: 'tool_call_update', toolCallId: 'call-1', title: 'Read config', status: 'failed' }))
      .toEqual({ kind: 'tool-error', id: 'call-1', label: 'Read config', category: 'read' });
  });

  it('replaces rewritten Mistral Vibe message snapshots instead of duplicating them', () => {
    expect(acpVibeResponseChange('The answer is 42.', 'The answer is 43.'))
      .toEqual({ text: 'The answer is 43.', mode: 'replace', current: 'The answer is 43.' });
    expect(acpVibeResponseChange('The answer is', ' 42.'))
      .toEqual({ text: ' 42.', mode: 'append', current: 'The answer is 42.' });
    expect(acpVibeResponseChange('The answer is', 'The answer is 42.'))
      .toEqual({ text: ' 42.', mode: 'append', current: 'The answer is 42.' });
  });

  it('preserves ACP diff content in the provider-neutral activity event', () => {
    expect(acpActivityEvent({
      sessionUpdate: 'tool_call_update', toolCallId: 'edit-1', title: 'Edit file', status: 'completed',
      content: [{ type: 'diff', path: '/repo/a.ts', oldText: 'old', newText: 'new' }],
    })).toMatchObject({ kind: 'tool-done', diff: { removed: ['old'], added: ['new'] } });
  });

  it('renders a new file as added-only and caps very large diffs', () => {
    expect(acpActivityEvent({
      sessionUpdate: 'tool_call', toolCallId: 'w', title: 'Write', status: 'pending',
      content: [{ type: 'diff', path: '/repo/new.ts', oldText: null, newText: 'a\nb\n' }],
    })).toMatchObject({ diff: { removed: [], added: ['a', 'b'] } });
    const big = (tag: string) => Array.from({ length: 500 }, (_, index) => `${tag} ${index}`).join('\n');
    const event = acpActivityEvent({ sessionUpdate: 'tool_call', status: 'pending', content: [{ type: 'diff', oldText: big('old'), newText: big('new') }] })!;
    // The file's diff is bounded and counts the rest; no marker line.
    const file = event.diff!.files![0]!;
    expect(file).toMatchObject({ additions: 500, removals: 500 });
    expect(file.lines.length + file.omitted!).toBe(1000);
    expect(event.diff!.added.some((line) => line.includes('more lines'))).toBe(false);
    // Only what changed: the lines both texts share are not repeated.
    expect(acpActivityEvent({ sessionUpdate: 'tool_call', status: 'pending', content: [{ type: 'diff', oldText: 'a\nb\nc', newText: 'a\nB\nc' }] })!.diff)
      .toMatchObject({ removed: ['b'], added: ['B'] });
  });

  it('carries bounded tool output', () => {
    expect(acpActivityEvent({
      sessionUpdate: 'tool_call_update', toolCallId: 'c', title: 'Run', status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'ok\n2 passed\n' } }],
    })).toEqual({ kind: 'tool-done', id: 'c', label: 'Run', category: 'run', output: ['ok', '2 passed'], outputTail: true });
  });

  it('classifies a command or a sub-agent from the ACP kind, input, or title', () => {
    expect(acpActivityEvent({
      sessionUpdate: 'tool_call', toolCallId: 'sh', title: 'Execute', kind: 'execute', status: 'in_progress',
    })).toMatchObject({ kind: 'tool-start', category: 'run' });
    expect(acpActivityEvent({
      sessionUpdate: 'tool_call', toolCallId: 'sh2', title: 'Shell', status: 'pending', rawInput: { command: 'git status' },
    })).toMatchObject({ kind: 'tool-start', category: 'run' });
    expect(acpActivityEvent({
      sessionUpdate: 'tool_call', toolCallId: 'ag', title: 'Task: review the tests', status: 'in_progress',
    })).toMatchObject({ kind: 'tool-start', agent: true });
  });

  it('describes what is being approved', () => {
    expect(acpApprovalDetail({ rawInput: { command: ['git', 'push'] } })).toBe('$ git push');
    expect(acpApprovalDetail({
      locations: [{ path: '/repo/a.ts' }],
      content: [{ type: 'diff', path: '/repo/a.ts', oldText: 'old', newText: 'new' }],
    })).toBe('/repo/a.ts\n- old\n+ new');
    expect(acpApprovalDetail({ title: 'Mystery' })).toBeUndefined();
  });

  /** The catalog describes an ACP launch -- the mode flag, and the model,
   * effort and permission flags derived from the harness's own entry -- and
   * passes it as `argv`/`extraArgv`. A second copy of those flags used to live
   * in this module as a fallback for callers that passed none, which was only
   * ever this test: production builds the launch from the catalog
   * (harnessAcpLaunch) on every turn. One description of a harness, and it is
   * the catalog. */
  it('assembles the launch the catalog handed it, and refuses without one', () => {
    expect(acpSpawnArgv({ command: 'droid', argv: ['exec', '--output-format', 'acp'], optionPlacement: 'after', extraArgv: ['--model', 'm'] }))
      .toEqual(['exec', '--output-format', 'acp', '--model', 'm']);
    expect(acpSpawnArgv({ command: 'kimi', argv: ['--acp'], extraArgv: ['--model', 'k2'] })).toEqual(['--model', 'k2', '--acp']);
    expect(acpSpawnArgv({ command: 'cursor' }), 'a harness with no catalog ACP launch cannot be spawned').toBeUndefined();
  });

  it('resolves a chosen model to the agent\'s own id', () => {
    const models = { currentModelId: 'openai-codex:gpt-6-astra', availableModels: [
      { modelId: 'openai-codex:gpt-6-astra' }, { modelId: 'opencode-free:nemotron-3-ultra-free' }, { modelId: 'copilot:gpt-5.5' }, { modelId: 'openai-codex:gpt-5.5' },
    ] };
    expect(acpModelChoice(models, 'opencode-free:nemotron-3-ultra-free')).toBe('opencode-free:nemotron-3-ultra-free');
    expect(acpModelChoice(models, 'nemotron-3-ultra-free'), 'a bare id one provider offers').toBe('opencode-free:nemotron-3-ultra-free');
    expect(acpModelChoice(models, 'gpt-5.5'), 'ambiguous: two providers offer it').toBeUndefined();
    expect(acpModelChoice(models, 'unknown')).toBeUndefined();
    expect(acpModelChoice({ availableModels: [{ modelId: 'gpt-5.5[reasoning=high]', name: 'gpt-5.5' }] }, 'gpt-5.5')).toBe('gpt-5.5[reasoning=high]');
    expect(acpModelChoice({ availableModels: [{ modelId: 'default[]', name: 'Auto' }] }, 'auto')).toBe('default[]');
    expect(acpModelChoice({ availableModels: [{ modelId: 'gpt-5.5[reasoning=high]', name: 'gpt-5.5' }, { modelId: 'gpt-5.5[reasoning=low]', name: 'gpt-5.5' }] }, 'gpt-5.5')).toBeUndefined();
    expect(acpModelChoice(models, 'anthropic:claude-sonnet-5'), 'a provider:model id the list leaves out').toBe('anthropic:claude-sonnet-5');
    expect(acpModelChoice({ availableModels: [{ modelId: 'sonnet' }] }, 'x:y'), 'an agent that does not name providers').toBeUndefined();
    expect(acpModelChoice(undefined, 'anything'), 'an agent with no model list').toBeUndefined();
  });

  it('resolves model aliases published as ACP config options', () => {
    expect(acpModelChoice({ configOptions: [{
      id: 'model', currentValue: 'devstral-latest', options: [
        { value: 'devstral-latest', name: 'Devstral Latest' },
        { value: 'mistral-medium', name: 'Mistral Medium' },
      ],
    }] }, 'mistral-medium')).toBe('mistral-medium');
  });
});

describe('an agent that is retrying a rate-limited call', () => {
  /** A real child speaking ACP the way Mistral Vibe does after a 429: it
   * echoes the prompt as a user chunk, says `_session/retrying` once, and
   * then (with PROGRESS set) either answers or stays silent. */
  const agent = (progress: 'answer' | 'silent') => `
    const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
    let buf = '';
    process.stdin.on('data', (d) => { buf += d; let n; while ((n = buf.indexOf('\\n')) >= 0) { const m = JSON.parse(buf.slice(0, n)); buf = buf.slice(n + 1);
      if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: {} } });
      else if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 's1' } });
      else if (m.method === 'session/prompt') {
        send({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'PONG?' } } } });
        send({ method: '_session/retrying', params: { sessionId: 's1', category: 'rate_limited', detail: 'HTTP 429' } });
        if (${JSON.stringify(progress)} === 'answer') setTimeout(() => {
          send({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'PONG' } } } });
          send({ id: m.id, result: { stopReason: 'end_turn' } });
        }, 150);
      } } });
  `;
  const input = (progress: 'answer' | 'silent', phases: string[]) => ({
    binary: process.execPath, command: 'vibe', argv: ['-e', agent(progress)], cwd: process.cwd(), prompt: 'PONG?',
    environment: {}, permissionMode: 'ask' as const, rateLimitGraceMs: 400, onPhase: (phase: string) => phases.push(phase),
  });

  it('gives the turn up as a 429 when the agent makes no progress', async () => {
    const phases: string[] = [];
    const failure = await runAcpTurn(input('silent', phases)).catch((error: Error & { statusCode?: number }) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('vibe: rate limited (HTTP 429), still retrying after 0s');
    expect((failure as { statusCode?: number }).statusCode).toBe(429);
    expect(phases).toEqual(['vibe is retrying (HTTP 429)']);
  });

  it('keeps the turn when the retry succeeds, and never takes the echoed prompt as the answer', async () => {
    const result = await runAcpTurn(input('answer', []));
    expect(result.text).toBe('PONG');
  });
});
