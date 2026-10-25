/** What an ACP agent says beside its answer: structured notices, status
 * updates, extension notifications, sign-out, questions asked as permissions,
 * and modes kept as a config option. Driven by a real child speaking ACP. */
import { describe, expect, it } from 'vitest';
import { createAcpSession } from './acp-client.js';

type Step = { after?: number; send?: Record<string, unknown>; request?: Record<string, unknown>; nowait?: boolean; until?: number };

/** After session/prompt the fake plays `steps`, then answers with what it
 * saw (initialize params, requests it received, replies to its requests). */
function agent(opts: { steps?: Step[]; initResult?: Record<string, unknown>; sessionResult?: Record<string, unknown>; newError?: Record<string, unknown> } = {}): string {
  return `
    const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
    const o = ${JSON.stringify(opts)}; const seen = { requests: [], replies: {} };
    let buf = '';
    const waiters = {};
    const until = (i) => seen.replies[i] !== undefined ? Promise.resolve() : new Promise((r) => { waiters[i] = r; });
    const play = async (m) => {
      for (const [i, step] of (o.steps ?? []).entries()) {
        if (step.after) await new Promise((r) => setTimeout(r, step.after));
        if (step.send) send(step.send);
        if (step.request) { send({ id: 500 + i, ...step.request }); if (!step.nowait) await until(i); }
        if (step.until !== undefined) await until(step.until);
      }
      send({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(seen) } } } });
      send({ id: m.id, result: { stopReason: 'end_turn' } });
    };
    process.stdin.on('data', (d) => { buf += d; let n; while ((n = buf.indexOf('\\n')) >= 0) { const m = JSON.parse(buf.slice(0, n)); buf = buf.slice(n + 1);
      if (m.id >= 500 && !m.method) { seen.replies[m.id - 500] = m.result ?? m.error; waiters[m.id - 500]?.(); continue; }
      if (m.method) seen.requests.push({ method: m.method, params: m.params });
      if (m.method === 'initialize') { seen.init = m.params; send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: {}, ...(o.initResult ?? {}) } }); }
      else if (m.method === 'session/new') send(o.newError ? { id: m.id, error: o.newError } : { id: m.id, result: { sessionId: 's1', ...(o.sessionResult ?? {}) } });
      else if (m.method === 'session/set_config_option') send({ id: m.id, result: {} });
      else if (m.method === 'session/prompt') play(m);
    } });
  `;
}

interface Seen { init: any; requests: Array<{ method: string; params: any }>; replies: Record<string, any> }

async function run(opts: Parameters<typeof agent>[0], extra: Record<string, unknown> = {}, sessionOptions: Record<string, never> = {}) {
  const session = createAcpSession(sessionOptions);
  const notices: string[] = [];
  const phases: string[] = [];
  try {
    const result = await session.runTurn({
      binary: process.execPath, command: 'fake', argv: ['-e', agent(opts)], cwd: process.cwd(), prompt: 'go',
      environment: {}, permissionMode: 'ask', onNotice: (m: string) => notices.push(m), onPhase: (p: string) => phases.push(p), ...extra,
    } as never);
    return { seen: JSON.parse(result.text) as Seen, notices, phases };
  } finally { await session.close(); }
}

const update = (u: Record<string, unknown>) => ({ send: { method: 'session/update', params: { sessionId: 's1', update: u } } });

describe('ACP client capabilities', () => {
  it('opts in to structured notices only', async () => {
    const { seen } = await run({});
    expect(seen.init.clientCapabilities.session).toEqual({ notices: {} });
    // The form handler exists (elicitation/create below), so claude-agent-acp may send AskUserQuestion as one.
    expect(seen.init.clientCapabilities.elicitation).toEqual({ form: {} });
    expect(seen.init.clientCapabilities._meta).toEqual({ terminal_output: true });
  });
});

describe('ACP status updates and extension notifications', () => {
  it('shows notices, compaction, background tasks and sub-agents instead of dropping them', async () => {
    const { notices, phases } = await run({ steps: [
      update({ sessionUpdate: 'notice', severity: 'warning', title: 'Rate limit near', description: '80% of the window' }),
      update({ sessionUpdate: 'compaction_update', compactionId: 'c', status: 'in_progress' }),
      update({ sessionUpdate: 'compaction_summary_chunk', compactionId: 'c', content: { type: 'text', text: 'x' } }),
      update({ sessionUpdate: 'compaction_update', compactionId: 'c', status: 'completed' }),
      update({ sessionUpdate: 'async_task_spawned', asyncTaskId: 't', name: 'dev server' }),
      update({ sessionUpdate: 'subagent_spawned', name: 'reviewer' }),
      update({ sessionUpdate: 'config_option_update', configOptions: [] }),
    ] });
    expect(notices).toEqual(['Rate limit near: 80% of the window', 'Conversation compacted to fit the context window']);
    expect(phases).toEqual(['compacting the conversation', 'compacting the conversation', 'background task: dev server', 'sub-agent: reviewer']);
  });

  it("keeps a background Agent's row running past its launch call, until its own task_notification", async () => {
    const raw = (message: Record<string, unknown>) => ({ send: { method: '_claude/sdkMessage', params: { sessionId: 's1', message: { type: 'system', ...message } } } });
    const events: Array<Record<string, unknown>> = [];
    await run({ steps: [
      update({ sessionUpdate: 'tool_call', toolCallId: 'a1', title: 'Agent', kind: 'other', status: 'in_progress', rawInput: { description: 'scan', subagent_type: 'general-purpose' } }),
      raw({ subtype: 'task_started', task_id: 'T', tool_use_id: 'a1', subagent_type: 'general-purpose', is_backgrounded: true }),
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'a1', status: 'completed' }),
      raw({ subtype: 'task_progress', task_id: 'T', tool_use_id: 'a1', usage: { total_tokens: 900, tool_uses: 3, duration_ms: 4000 } }),
      raw({ subtype: 'task_notification', task_id: 'T', tool_use_id: 'a1', status: 'completed', usage: { total_tokens: 1200, tool_uses: 4, duration_ms: 9000 } }),
    ] }, { onActivity: (event: Record<string, unknown>) => events.push(event) });
    expect(events.map((event) => [event.kind, event.childTools, event.childTokens, event.durationMs])).toEqual([
      ['tool-start', undefined, undefined, undefined],
      ['tool-start', undefined, undefined, undefined],
      ['tool-start', 3, 900, undefined],
      ['tool-done', 4, 1200, 9000],
    ]);
    expect(events.every((event) => event.agent === true && event.id === 'a1')).toBe(true);
    expect(events.slice(1).every((event) => event.agentId === 'T')).toBe(true);
  });

  it("Cursor: a sub-agent's spawning call row runs until subagent_state_update, though the call returns first", async () => {
    const events: Array<Record<string, unknown>> = [];
    await run({ steps: [
      update({ sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'Task', kind: 'other', status: 'in_progress', rawInput: { description: 'audit', subagent_type: 'explore' } }),
      update({ sessionUpdate: 'subagent_spawned', subagentSessionId: 'child', name: 'audit', _meta: { cursor: { toolCallId: 'c1' } } }),
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed' }),
      update({ sessionUpdate: 'subagent_state_update', subagentSessionId: 'child', state: 'completed' }),
    ] }, { onActivity: (event: Record<string, unknown>) => events.push(event) });
    expect(events.map((event) => event.kind)).toEqual(['tool-start', 'tool-done']);
    expect(events.every((event) => event.id === 'c1' && event.agent === true)).toBe(true);
  });

  it('hides only Claude cross-organization thinking notices in both adapter formats', async () => {
    const streamed: string[] = [];
    const { notices, seen } = await run({ steps: [
      update({ sessionUpdate: 'notice', severity: 'warning', title: "Claude can't use thinking from another organization", description: 'Preserved thinking is account-bound' }),
      update({ sessionUpdate: 'notice', severity: 'warning', title: 'Rate limit near', description: '80% of the window' }),
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: "**Warning:** Claude can't use thinking from another organization\nAn old warning" }, _meta: { claudeCode: { kind: 'informational', level: 'warning' } } }),
    ] }, { onResponseDelta: (delta: string) => streamed.push(delta) });
    expect(notices).toEqual(['Rate limit near: 80% of the window']);
    expect(streamed.join('')).toBe(JSON.stringify(seen));
  });

  it('counts extension notifications as proof of life for the idle watchdog', async () => {
    const quiet = (method: string) => ({ after: 150, send: { method, params: { sessionId: 's1' } } });
    // 4 x 150ms of nothing but extension traffic against a 400ms budget.
    const { seen } = await run({ steps: ['_claude/sdkMessage', '_session/goal', '_claude/rateLimit', '_session/steering'].map(quiet) }, {}, { idleMs: 400 });
    expect(seen.requests.some((r) => r.method === 'session/prompt')).toBe(true);
  });

  it('fails a signed-out agent at once with the sign-in path', async () => {
    const session = createAcpSession();
    try {
      await expect(session.runTurn({
        binary: process.execPath, command: 'fake', argv: ['-e', agent({ steps: [
          { send: { method: '_auth/status_update', params: { authStatus: { kind: 'none', label: 'Not logged in' } } } },
          { after: 5000 },
        ] })], cwd: process.cwd(), prompt: 'go', environment: {}, permissionMode: 'ask',
      })).rejects.toMatchObject({ message: expect.stringContaining('not signed in'), rpcCode: -32000, statusCode: 401 });
    } finally { await session.close(); }
  });

  it('ignores a signed-in status', async () => {
    const { seen } = await run({ steps: [{ send: { method: '_auth/status_update', params: { authStatus: { kind: 'subscription' } } } }] });
    expect(seen.requests.length).toBeGreaterThan(0);
  });
});

describe('a vendor error keeps its JSON-RPC code and data', () => {
  it('attaches rpcCode and data for the classifier', async () => {
    const session = createAcpSession();
    try {
      await expect(session.runTurn({
        binary: process.execPath, command: 'fake', argv: ['-e', agent({ newError: { code: -32000, message: 'Authentication required', data: { authMethods: ['x'] } } })],
        cwd: process.cwd(), prompt: 'go', environment: {}, permissionMode: 'ask',
      })).rejects.toMatchObject({ rpcCode: -32000, data: { authMethods: ['x'] } });
    } finally { await session.close(); }
  });
});

describe('a question asked as a permission request (Cursor)', () => {
  const question = {
    request: {
      method: 'session/request_permission',
      params: {
        sessionId: 's1',
        toolCall: { toolCallId: 'ask_1_q0', title: 'Which database?', kind: 'other', status: 'pending' },
        options: [
          { optionId: 'pg', name: 'Postgres', kind: 'allow_once' },
          { optionId: 'my', name: 'MySQL', kind: 'allow_once' },
          { optionId: '__ask_question_skip__', name: 'Skip', kind: 'reject_once' },
        ],
      },
    },
  };

  it('puts the real options to the user and answers with the pick, even in bypass', async () => {
    for (const mode of ['bypass', 'auto', 'ask'] as const) {
      const asked: string[] = [];
      const questions: any[] = [];
      const { seen } = await run({ steps: [question] }, {
        permissionMode: mode, onApproval: async (title: string) => { asked.push(title); return true; },
        onQuestion: async (request: any) => { questions.push(request); return { kind: 'answered', answers: { answer: ['MySQL'] } }; },
      });
      expect(seen.replies[0], mode).toEqual({ outcome: { outcome: 'selected', optionId: 'my' } });
      expect(asked, mode).toEqual([]);
      expect(questions[0].questions[0].prompt).toBe('Which database?');
      expect(questions[0].questions[0].options.map((o: any) => o.label)).toEqual(['Postgres', 'MySQL']);
    }
  });

  it('skips only when the user skips', async () => {
    const { seen } = await run({ steps: [question] }, { permissionMode: 'bypass', onQuestion: async () => ({ kind: 'answered', answers: {} }) });
    expect(seen.replies[0]).toEqual({ outcome: { outcome: 'selected', optionId: '__ask_question_skip__' } });
  });

  it('is cancelled when the user dismisses it', async () => {
    const { seen } = await run({ steps: [question] }, { onQuestion: async () => ({ kind: 'cancelled' }) });
    expect(seen.replies[0]).toEqual({ outcome: { outcome: 'cancelled' } });
  });

  it('with no question surface it is skipped, said so, and never approved', async () => {
    const asked: string[] = [];
    const { seen, notices } = await run({ steps: [question] }, { permissionMode: 'bypass', onApproval: async (title: string) => { asked.push(title); return true; } });
    expect(seen.replies[0]).toEqual({ outcome: { outcome: 'selected', optionId: '__ask_question_skip__' } });
    expect(asked).toEqual([]);
    expect(notices.join()).toContain('cannot show it');
  });

  it('leaves an ordinary permission request on its plan', async () => {
    const ordinary = { request: { method: 'session/request_permission', params: { sessionId: 's1', toolCall: { toolCallId: 't', title: 'Run ls', kind: 'execute' }, options: [{ optionId: 'ok', name: 'Allow', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }] } } };
    const { seen } = await run({ steps: [ordinary] }, { permissionMode: 'bypass' });
    expect(seen.replies[0]).toEqual({ outcome: { outcome: 'selected', optionId: 'ok' } });
  });
});

describe('elicitation/create (claude-agent-acp AskUserQuestion)', () => {
  const ask = {
    request: {
      method: 'elicitation/create',
      params: {
        mode: 'form', sessionId: 's1', toolCallId: 'tu1', message: 'Which auth method?',
        requestedSchema: {
          type: 'object',
          properties: {
            question_0: { type: 'string', title: 'Auth', oneOf: [{ const: 'OAuth', title: 'OAuth', description: 'hosted' }, { const: 'API key', title: 'API key' }] },
            question_0_custom: { type: 'string', title: 'Other' },
          },
        },
      },
    },
  };

  it('is put to the user as a question and answered in the form\'s own terms', async () => {
    const requests: any[] = [];
    const { seen } = await run({ steps: [ask] }, {
      permissionMode: 'bypass',
      onQuestion: async (request: any) => { requests.push(request); return { kind: 'answered', answers: { question_0: ['API key'] } }; },
    });
    expect(requests[0].questions[0]).toMatchObject({ id: 'question_0', prompt: 'Which auth method?', header: 'Auth', allowFreeText: true, optional: true });
    expect(requests[0].questions[0].options).toEqual([{ label: 'OAuth', description: 'hosted' }, { label: 'API key' }]);
    expect(seen.replies[0]).toEqual({ action: 'accept', content: { question_0: 'API key' } });
  });

  it('sends typed text to the custom field', async () => {
    const { seen } = await run({ steps: [ask] }, { onQuestion: async () => ({ kind: 'answered', answers: { question_0: ['Passkeys'] } }) });
    expect(seen.replies[0]).toEqual({ action: 'accept', content: { question_0_custom: 'Passkeys' } });
  });

  it('cancels when dismissed, and when there is no question surface (with a notice)', async () => {
    const dismissed = await run({ steps: [ask] }, { onQuestion: async () => ({ kind: 'cancelled' }) });
    expect(dismissed.seen.replies[0]).toEqual({ action: 'cancel' });
    const none = await run({ steps: [ask] }, {});
    expect(none.seen.replies[0]).toEqual({ action: 'cancel' });
    expect(none.notices.join()).toContain('cannot show it');
  });

  it('closes the prompt when the agent withdraws the request', async () => {
    let aborted = false;
    const { seen } = await run({ steps: [{ ...ask, nowait: true }, { after: 50, send: { method: '$/cancel_request', params: { requestId: 500 } } }, { until: 0 }] }, {
      onQuestion: (_request: any, signal?: AbortSignal) => new Promise((resolve) => { signal?.addEventListener('abort', () => { aborted = true; resolve({ kind: 'cancelled' }); }); }),
    });
    expect(aborted).toBe(true);
    expect(seen.replies[0]).toEqual({ action: 'cancel' });
  });

  it('declines a url-mode request it did not advertise', async () => {
    const { seen } = await run({ steps: [{ request: { method: 'elicitation/create', params: { mode: 'url', sessionId: 's1', message: 'm', url: 'https://x', elicitationId: 'e' } } }] }, {});
    expect(seen.replies[0]).toEqual({ action: 'decline' });
  });
});

describe('ExitPlanMode (claude-agent-acp)', () => {
  const plan = {
    request: {
      method: 'session/request_permission',
      params: {
        sessionId: 's1', toolCall: { toolCallId: 'p', title: 'Ready to code?', kind: 'switch_mode', rawInput: { plan: '1. edit a.ts' } },
        options: [
          { optionId: 'exit-plan-auto', name: 'Yes, and use auto mode', kind: 'allow_always' },
          { optionId: 'exit-plan-default', name: 'Yes, manually approve edits', kind: 'allow_once' },
          { optionId: 'reject', name: 'No, keep planning', kind: 'reject_once' },
        ],
      },
    },
  };

  it('offers every way out and answers with the one the user picked, in every mode', async () => {
    for (const mode of ['bypass', 'ask'] as const) {
      const requests: any[] = [];
      const { seen } = await run({ steps: [plan] }, {
        permissionMode: mode,
        onQuestion: async (request: any) => { requests.push(request); return { kind: 'answered', answers: { plan: ['Yes, and use auto mode'] } }; },
      });
      expect(requests[0].questions[0].prompt, mode).toBe('1. edit a.ts');
      expect(requests[0].questions[0].options.map((o: any) => o.label), mode).toEqual(['Yes, and use auto mode', 'Yes, manually approve edits', 'No, keep planning']);
      expect(seen.replies[0], mode).toEqual({ outcome: { outcome: 'selected', optionId: 'exit-plan-auto' } });
    }
  });

  it('is a plain approval where the surface cannot ask', async () => {
    const { seen } = await run({ steps: [plan] }, { permissionMode: 'bypass' });
    expect(seen.replies[0]).toEqual({ outcome: { outcome: 'selected', optionId: 'exit-plan-default' } });
  });
});

describe('an approval the agent withdraws', () => {
  it('aborts the prompt on screen', async () => {
    let signalSeen: AbortSignal | undefined;
    let aborted = false;
    const ordinary = { request: { method: 'session/request_permission', params: { sessionId: 's1', toolCall: { toolCallId: 't', title: 'Run ls', kind: 'execute' }, options: [{ optionId: 'ok', name: 'Allow', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }] } }, nowait: true };
    await run({ steps: [ordinary, { after: 50, send: { method: '$/cancel_request', params: { requestId: 500 } } }, { until: 0 }] }, {
      onApproval: (_t: string, _d: unknown, _p: unknown, signal?: AbortSignal) => new Promise<boolean>((resolve) => { signalSeen = signal; signal?.addEventListener('abort', () => { aborted = true; resolve(false); }); }),
    });
    expect(signalSeen).toBeDefined();
    expect(aborted).toBe(true);
  });
});

describe('modes kept as a config option', () => {
  const configOptions = [
    { id: 'mode', category: 'mode', type: 'select', currentValue: 'code', options: [{ value: 'code', name: 'Code' }, { value: 'plan', name: 'Plan' }] },
  ];

  it('plan mode goes through session/set_config_option when the agent has no modes object', async () => {
    const { seen } = await run({ sessionResult: { configOptions } }, {
      planMode: true, acp: { permissionModeIds: { ask: 'code' }, planModeId: 'plan' },
    });
    const set = seen.requests.filter((r) => r.method === 'session/set_config_option' || r.method === 'session/set_mode');
    expect(set).toEqual([{ method: 'session/set_config_option', params: { sessionId: 's1', configId: 'mode', value: 'plan' } }]);
  });

  it('sets nothing when the option already holds the mode', async () => {
    const { seen } = await run({ sessionResult: { configOptions } }, { acp: { permissionModeIds: { ask: 'code' } } });
    expect(seen.requests.filter((r) => r.method.startsWith('session/set_'))).toEqual([]);
  });
});
