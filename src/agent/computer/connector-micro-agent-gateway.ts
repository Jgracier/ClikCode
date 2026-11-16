/** The micro-task agent on ClikDeploy Gateway (Sonnet 5.5 by default): the same three tools as the headless CLI agents, served in this process
 * by agentMcpHandler, driven by a plain tool-calling loop over the Gateway's chat-completions API. No vendor CLI or subscription is involved. */
import { agentMcpHandler } from './connector-micro-agent-mcp.js';
import { quiet } from '../../runtime/lifecycle-log.js';
import { stateDirectory } from '../../session/store/paths.js';

export const GATEWAY_MICRO_MODEL = process.env.CLIKCODE_MICRO_AGENT_MODEL || 'claude-sonnet-5-5';
const MAX_TURNS = 80;

interface Message { role: 'system' | 'user' | 'assistant' | 'tool'; content?: string | null; tool_calls?: unknown[]; tool_call_id?: string }
interface Reply { choices?: { message?: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[]; error?: { message?: string } }

export interface GatewayMicroOptions { tab: string; maxCalls: number; maxMs: number; connector?: string; counter?: string; fetchImpl?: typeof fetch; connection?: { baseUrl: string; apiKey: string }; tools?: Parameters<typeof agentMcpHandler>[0]['tools'] }

export async function runGatewayMicro(prompt: string, options: GatewayMicroOptions): Promise<{ text: string; timedOut: boolean; calls: number; error?: string }> {
  const connection = options.connection ?? await (async () => {
    const { gatewayConnection } = await import('../models/for-session.js');
    const Conf = (await import('conf')).default;
    return gatewayConnection(new Conf({ projectName: 'clikcode', configFileMode: 0o600 }));
  })();
  const handle = agentMcpHandler({ tab: options.tab, maxCalls: options.maxCalls, ...(options.tools ? { tools: options.tools } : {}), ...(options.counter ? { counter: options.counter } : {}), ...(options.connector ? { connector: options.connector } : {}) });
  const listed = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) as { result?: { tools?: { name: string; description: string; inputSchema: unknown }[] } };
  const tools = (listed.result?.tools ?? []).map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
  const doFetch = options.fetchImpl ?? fetch;
  const messages: Message[] = [{ role: 'user', content: prompt }];
  const deadline = Date.now() + options.maxMs;
  let calls = 0, text = '', timedOut = false, error: string | undefined;
  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const left = deadline - Date.now();
      if (left <= 0) { timedOut = true; break; }
      const root = connection.baseUrl.replace(/\/+$/, '');
      const response = await doFetch(`${root.endsWith('/v1') ? root : `${root}/v1`}/chat/completions`, {
        method: 'POST', signal: AbortSignal.timeout(Math.min(left, 120_000)),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${connection.apiKey}`, 'x-client': 'clikcode-micro-agent' },
        body: JSON.stringify({ model: GATEWAY_MICRO_MODEL, messages, tools, stream: false }),
      }).catch((cause: unknown) => { if (Date.now() >= deadline) timedOut = true; else error = `Gateway request failed: ${cause instanceof Error ? cause.message : String(cause)}`; return undefined; });
      if (!response) break;
      const body = await response.json().catch(() => ({})) as Reply;
      if (!response.ok) { error = `Gateway ${response.status}: ${body.error?.message ?? 'request refused'}`.slice(0, 300); break; }
      const message = body.choices?.[0]?.message;
      if (!message) { error = 'Gateway returned no message.'; break; }
      text = message.content ?? '';
      const asked = message.tool_calls ?? [];
      if (asked.length === 0) break;
      messages.push({ role: 'assistant', content: message.content ?? null, tool_calls: asked });
      for (const call of asked) {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>; } catch { /* a malformed call is answered with the tool's own refusal */ }
        // A hung page must not hold the vendor past its budget: each call gets at most the time left (and 3 minutes).
        const wait = Math.max(1_000, Math.min(deadline - Date.now(), 180_000));
        const timer: { id?: NodeJS.Timeout } = {};
        const timeout = new Promise<'late'>(resolve => { timer.id = setTimeout(() => resolve('late'), wait); });
        const raced = await Promise.race([handle({ jsonrpc: '2.0', id: ++calls, method: 'tools/call', params: { name: call.function.name, arguments: args } }), timeout]);
        clearTimeout(timer.id);
        if (raced === 'late') { if (Date.now() >= deadline) timedOut = true; messages.push({ role: 'tool', tool_call_id: call.id, content: 'That call did not finish in time and was abandoned. Try something simpler or end with your RESULT line.' }); continue; }
        const out = raced as { result?: { content?: { text?: string }[] }; error?: { message?: string } };
        messages.push({ role: 'tool', tool_call_id: call.id, content: out.result?.content?.map(c => c.text ?? '').join('\n') ?? out.error?.message ?? 'No result.' });
      }
    }
  } finally {
    // Closing the tab waits on the browser, which an abandoned hung call may still hold: it gets 15 seconds, not forever.
    if (!options.tools) await Promise.race([closeTab(options.tab), new Promise(resolve => setTimeout(resolve, 15_000).unref())]);
  }
  return { text, timedOut, calls, ...(error ? { error } : {}) };
}

async function closeTab(tab: string): Promise<void> {
  const stateDir = stateDirectory();
  // Only this agent's own tab. The browser connection is shared with the vendors running beside it in this process: releasing it
  // here cut their pages off mid-task ("the browser has been closed"), which the CLI agents never did because each was its own process.
  const { closeComputerPage } = await import('./browser.js');
  await closeComputerPage(stateDir, tab).catch(quiet('agent/computer/connector-micro-agent-gateway'));
}
