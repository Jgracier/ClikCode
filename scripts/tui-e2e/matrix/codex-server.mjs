/* The Codex app-server protocol (`codex app-server --stdio`), the shapes the
 * adapter reads (src/harness/transport/codex-app-server.ts, and the fixture of
 * src/harness/protocol/turn-flow-conformance.vitest.test.ts, codex-cli 0.155):
 * newline-delimited JSON-RPC without a `jsonrpc` field. */

export async function serveCodex({ turn, log, sleep, wordMs, promptMatch }) {
  const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const note = (method, params, mark = {}) => { log({ ev: 'emit', method, ...mark }); send({ method, params }); };
  const T = 'T';
  let U = 'U1';
  let counter = 0;
  const item = (method, threadId, turnId, body) => note(method, { threadId, turnId, item: body }, { item: body });

  const words = async (text) => {
    const id = `msg${++counter}`;
    item('item/started', T, U, { type: 'agentMessage', id, text: '' });
    let said = '';
    for (const piece of text.match(/\s*\S+\s*|\s+$/g) ?? []) {
      await sleep(wordMs);
      said += piece;
      note('item/agentMessage/delta', { threadId: T, turnId: U, itemId: id, delta: piece }, { text: piece });
    }
    item('item/completed', T, U, { type: 'agentMessage', id, text: said });
  };

  const play = async () => {
    const commands = new Map();
    let usage;
    for (const op of turn.ops) {
      switch (op.op) {
        case 'text': await words(op.text); break;
        case 'thought': {
          const body = `${op.heading ? `**${op.heading}**\n\n` : ''}${op.text}`;
          const id = `rs${++counter}`;
          for (const piece of body.match(/\S+\s*/g) ?? []) {
            await sleep(op.ms ?? 20);
            note('item/reasoning/summaryTextDelta', { threadId: T, turnId: U, itemId: id, delta: piece }, { text: piece });
          }
          item('item/completed', T, U, { type: 'reasoning', id, summary: [body] });
          break;
        }
        case 'sleep': await sleep(op.ms); break;
        case 'tool-start':
          commands.set(op.id, op.title);
          item('item/started', T, U, { type: 'commandExecution', id: op.id, command: op.title, status: 'inProgress' });
          break;
        case 'tool-end':
          item('item/completed', T, U, { type: 'commandExecution', id: op.id, command: commands.get(op.id), status: 'completed',
            aggregatedOutput: `${op.result ?? 'ok'}\n`, exitCode: 0 });
          break;
        case 'agent-start':
          commands.set('agent', 'C');
          item('item/started', T, U, { type: 'subAgentActivity', id: op.id, kind: 'started', agentThreadId: 'C', agentPath: `/root/${op.description ?? 'explore'}` });
          note('turn/started', { threadId: 'C', turn: { id: 'CU1', status: 'inProgress' } });
          break;
        case 'child-start':
          commands.set(op.id, op.title);
          item('item/started', 'C', 'CU1', { type: 'commandExecution', id: op.id, command: op.title, status: 'inProgress' });
          break;
        case 'child-end':
          item('item/completed', 'C', 'CU1', { type: 'commandExecution', id: op.id, command: commands.get(op.id), status: 'completed',
            aggregatedOutput: `${op.result ?? 'ok'}\n`, exitCode: 0 });
          break;
        case 'agent-end':
          note('turn/completed', { threadId: 'C', turn: { id: 'CU1', status: 'completed' } });
          item('item/completed', T, U, { type: 'subAgentActivity', id: op.id, kind: 'completed', agentThreadId: 'C', agentPath: '/root/explore' });
          break;
        case 'plan':
          note('turn/plan/updated', { threadId: T, turnId: U, plan: op.entries.map((entry) => ({ step: entry.content, status: entry.status })) },
            { text: op.entries.map((entry) => entry.content).join(' | ') });
          break;
        case 'usage': usage = op; break;
        default: throw new Error(`codex fake: unknown op ${op.op}`);
      }
    }
    if (usage) {
      const total = { totalTokens: usage.input + usage.output, inputTokens: usage.input, outputTokens: usage.output };
      note('thread/tokenUsage/updated', { threadId: T, turnId: U, tokenUsage: { total, last: total, modelContextWindow: usage.size } });
    }
    log({ ev: 'end' });
    note('turn/completed', { threadId: T, turn: { id: U, status: 'completed' } });
  };

  let buffer = '';
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const { id, method } = message;
      if (method === 'initialize') send({ id, result: {} });
      else if (method === 'thread/start' || method === 'thread/resume') send({ id, result: { thread: { id: T } } });
      else if (method === 'turn/start') {
        // The script is for the prompt the rig typed; any other turn ClikCode
        // starts on its own (a title, a probe) is just answered.
        const matched = !promptMatch || JSON.stringify(message.params ?? {}).includes(promptMatch);
        log({ ev: 'recv', what: 'turn/start', matched });
        send({ id, result: { turn: { id: U } } });
        if (matched) void play();
        else { void words('ok').then(() => note('turn/completed', { threadId: T, turn: { id: U, status: 'completed' } })); }
      } else if (method === 'turn/interrupt') send({ id, result: {} });
      else if (id !== undefined && method) send({ id, error: { code: -32601, message: `fake codex: ${method}` } });
    }
  });
  process.stdin.on('end', () => process.exit(0));
}
