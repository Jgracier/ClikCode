/** Every ServerRequest codex 0.155 can send is answered in its own schema's
 * shape, and the notifications that used to be dropped end or colour the turn. */
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { createCodexSession } from './codex-app-server.js';

/** After turn/start the fake sends `requests` (id 100+i), collects each
 * response, then completes the turn with the responses as the answer. */
function fakeServer(requests: Array<{ method: string; params: Record<string, unknown> }>, after: unknown[] = []): string {
  return `
    const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
    const requests = ${JSON.stringify(requests)}; const after = ${JSON.stringify(after)};
    const answers = {}; let buf = '';
    process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (m.method === 'initialize') send({ id: m.id, result: {} });
      else if (m.method === 'thread/start') send({ id: m.id, result: { thread: { id: 'T' } } });
      else if (m.method === 'turn/start') {
        send({ id: m.id, result: { turn: { id: 'U1' } } });
        requests.forEach((r, k) => send({ id: 100 + k, method: r.method, params: { threadId: 'T', turnId: 'U1', ...r.params } }));
        for (const a of after) send(JSON.parse(JSON.stringify(a).split('{{turn}}').join('U1')));
        if (!requests.length && !after.some((a) => a.method === 'thread/status/changed')) finish();
      } else if (m.id >= 100 && m.method === undefined) {
        answers[m.id - 100] = m.result ?? { error: m.error };
        if (Object.keys(answers).length === requests.length) finish();
      }
    } });
    function finish() {
      send({ method: 'item/completed', params: { threadId: 'T', turnId: 'U1', item: { type: 'agentMessage', id: 'a', text: JSON.stringify(answers) } } });
      send({ method: 'turn/completed', params: { threadId: 'T', turn: { id: 'U1', status: 'completed' } } });
    }
  `;
}

async function run(requests: Array<{ method: string; params: Record<string, unknown> }>, extra: Record<string, unknown> = {}, after: unknown[] = []) {
  const codex = createCodexSession({ spawn: (_b, _a, o) => spawn(process.execPath, ['-e', fakeServer(requests, after)], o) });
  const notices: string[] = [];
  const phases: string[] = [];
  try {
    const result = await codex.runTurn({
      binary: 'codex', prompt: 'go', cwd: process.cwd(), permissionMode: 'ask',
      onNotice: (m: string) => notices.push(m), onPhase: (p: string) => phases.push(p), ...extra,
    });
    return { answers: JSON.parse(result.text) as Record<string, any>, notices, phases };
  } finally { await codex.close(); }
}

let answersToggle = 0;
describe('Codex server requests', () => {
  it('answers a permissions request with a GrantedPermissionProfile, not a decision', async () => {
    const permissions = { network: { enabled: true } };
    const approved = await run([{ method: 'item/permissions/requestApproval', params: { itemId: 'i', permissions, cwd: '/', reason: 'r' } }], { onApproval: async () => true });
    expect(approved.answers[0]).toEqual({ permissions, scope: 'turn' });
    const denied = await run([{ method: 'item/permissions/requestApproval', params: { itemId: 'i', permissions } }], { onApproval: async () => false });
    expect(denied.answers[0]).toEqual({ permissions: {} });
  });

  it('keeps the decision shape for command and legacy approvals', async () => {
    const { answers } = await run([
      { method: 'item/commandExecution/requestApproval', params: { itemId: 'c', command: 'make' } },
      { method: 'execCommandApproval', params: { callId: 'x', command: ['ls'] } },
    ], { onApproval: async () => true });
    expect(answers[0]).toEqual({ decision: 'accept' });
    expect(answers[1]).toEqual({ decision: 'approved' });
  });

  it('answers the rest in their own schema terms instead of -32601', async () => {
    const { answers, notices } = await run([
      { method: 'item/tool/requestUserInput', params: { itemId: 'q', isBlocking: true, questions: [{ id: 'a', header: 'h', question: 'Which?' }] } },
      { method: 'mcpServer/elicitation/request', params: { serverName: 'docs' } },
      { method: 'item/tool/call', params: { tool: 'lookup', callId: 'k', arguments: {} } },
      { method: 'account/chatgptAuthTokens/refresh', params: { reason: 'unauthorized' } },
      { method: 'attestation/generate', params: {} },
    ]);
    // No question surface here: cancelled, said so, never invented.
    expect(answers[0]).toEqual({ answers: {} });
    expect(answers[1]).toEqual({ action: 'cancel', content: null });
    expect(answers[2]).toMatchObject({ success: false, contentItems: [{ type: 'inputText' }] });
    expect(answers[3].error.code).toBe(-32603);
    expect(answers[4].error.code).toBe(-32603);
    expect(JSON.stringify(answers)).not.toContain('32601');
    expect(notices.join('\n')).toContain('docs');
    expect(notices.join('\n')).toContain('cannot show');
  });

  it('puts request_user_input to the user and answers in the schema\'s terms', async () => {
    const seen: any[] = [];
    const { answers } = await run([
      { method: 'item/tool/requestUserInput', params: { itemId: 'q', isBlocking: true, questions: [
        { id: 'db', header: 'DB', question: 'Which?', isOther: true, options: [{ label: 'pg', description: 'Postgres' }, { label: 'my', description: 'MySQL' }] },
        { id: 'tok', header: 'Token', question: 'Your token?', isSecret: true },
      ] } },
    ], { permissionMode: 'bypass', onQuestion: async (request: any) => { seen.push(request); return { kind: 'answered', answers: { db: ['pg'], tok: ['s3cret'] } }; } });
    expect(answers[0]).toEqual({ answers: { db: { answers: ['pg'] }, tok: { answers: ['s3cret'] } } });
    expect(seen[0].questions[0]).toMatchObject({ id: 'db', prompt: 'Which?', header: 'DB', allowFreeText: true, options: [{ label: 'pg', description: 'Postgres' }, { label: 'my', description: 'MySQL' }] });
    expect(seen[0].questions[1]).toMatchObject({ id: 'tok', secret: true, allowFreeText: true, options: [] });
  });

  it('answers a dismissed question with no answers', async () => {
    const { answers } = await run([{ method: 'item/tool/requestUserInput', params: { itemId: 'q', isBlocking: true, questions: [{ id: 'a', header: 'h', question: 'Which?' }] } }],
      { onQuestion: async () => ({ kind: 'cancelled' }) });
    expect(answers[0]).toEqual({ answers: {} });
  });

  it('answers an MCP form elicitation with its content, and a url elicitation with the user\'s choice', async () => {
    const schema = { type: 'object', properties: { name: { type: 'string', title: 'Name' }, tier: { type: 'string', title: 'Tier', enum: ['free', 'pro'] }, n: { type: 'integer', title: 'Seats' }, ok: { type: 'boolean', title: 'Agree' } }, required: ['name'] };
    const { answers } = await run([
      { method: 'mcpServer/elicitation/request', params: { serverName: 'docs', mode: 'form', message: 'Sign up', requestedSchema: schema } },
      { method: 'mcpServer/elicitation/request', params: { serverName: 'docs', mode: 'url', message: 'Authorize', url: 'https://example.com/auth', elicitationId: 'e1' } },
      { method: 'mcpServer/elicitation/request', params: { serverName: 'docs', mode: 'url', message: 'Authorize', url: 'https://example.com/auth', elicitationId: 'e2' } },
    ], {
      onQuestion: async (request: any) => {
        if (request.url) return { kind: 'answered', answers: { link: [request.questions[0].prompt === 'Authorize' && answersToggle++ === 0 ? 'Continue (I opened the link)' : 'Decline'] } };
        return { kind: 'answered', answers: { name: ['Ada'], tier: ['pro'], n: ['3'], ok: ['Yes'] } };
      },
    });
    expect(answers[0]).toEqual({ action: 'accept', content: { name: 'Ada', tier: 'pro', n: 3, ok: true } });
    expect(answers[1]).toEqual({ action: 'accept', content: null });
    expect(answers[2]).toEqual({ action: 'decline', content: null });
  });

  it('closes a question prompt when Codex resolves the request elsewhere', async () => {
    let aborted = false;
    const { answers } = await run(
      [{ method: 'item/tool/requestUserInput', params: { itemId: 'q', isBlocking: true, questions: [{ id: 'a', header: 'h', question: 'Which?' }] } }],
      { onQuestion: (_request: any, signal?: AbortSignal) => new Promise((resolve) => { signal?.addEventListener('abort', () => { aborted = true; resolve({ kind: 'cancelled' }); }); }) },
      [{ method: 'serverRequest/resolved', params: { threadId: 'T', requestId: 100 } }],
    );
    expect(aborted).toBe(true);
    expect(answers[0]).toEqual({ answers: {} });
  });

  it('gives an approval an abort signal that fires when it is resolved elsewhere', async () => {
    let aborted = false;
    await run(
      [{ method: 'item/commandExecution/requestApproval', params: { itemId: 'c', command: 'make' } }],
      { onApproval: (_t: string, _d: unknown, _p: unknown, signal?: AbortSignal) => new Promise<boolean>((resolve) => { signal?.addEventListener('abort', () => { aborted = true; resolve(false); }); }) },
      [{ method: 'serverRequest/resolved', params: { threadId: 'T', requestId: 100 } }],
    );
    expect(aborted).toBe(true);
  });

  it('ends the wait for an approval answered elsewhere', async () => {
    const { answers } = await run(
      [{ method: 'item/commandExecution/requestApproval', params: { itemId: 'c', command: 'make' } }],
      { onApproval: () => new Promise<boolean>(() => undefined) },
      [{ method: 'serverRequest/resolved', params: { threadId: 'T', requestId: 100 } }],
    );
    expect(answers[0]).toEqual({ decision: 'cancel' });
  });

  it('fails a turn promptly when the thread goes systemError', async () => {
    const codex = createCodexSession({ spawn: (_b, _a, o) => spawn(process.execPath, ['-e', fakeServer([], [
      { method: 'error', params: { threadId: 'T', turnId: 'U1', willRetry: false, error: { message: 'stream broke', codexErrorInfo: 'serverOverloaded' } } },
      { method: 'thread/status/changed', params: { threadId: 'T', status: { type: 'systemError' } } },
    ])], o) });
    try {
      await expect(codex.runTurn({ binary: 'codex', prompt: 'go', cwd: process.cwd(), permissionMode: 'ask' }))
        .rejects.toMatchObject({ message: 'stream broke', codexErrorInfo: 'serverOverloaded' });
    } finally { await codex.close(); }
  });

  it('shows the quiet vendor phases', async () => {
    const { phases } = await run([], {}, [
      { method: 'mcpServer/startupStatus/updated', params: { name: 'docs', status: 'starting' } },
      { method: 'model/verification', params: { threadId: 'T', turnId: 'U1' } },
      { method: 'modelProvider/authRecoveryStarted', params: { threadId: 'T' } },
      { method: 'item/autoApprovalReview/started', params: { threadId: 'T', turnId: 'U1' } },
      { method: 'item/agentMessage/delta', params: { threadId: 'T', delta: 'x' } },
    ]);
    expect(phases).toEqual(expect.arrayContaining(['starting MCP server docs', 'verifying the model', 'refreshing sign-in', 'reviewing an approval']));
  });
});
