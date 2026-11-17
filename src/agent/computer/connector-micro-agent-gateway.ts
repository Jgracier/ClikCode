/** The micro-task agent on ClikDeploy Gateway (Sonnet 5.5 by default): the same three tools as the headless CLI agents, served in this process
 * by agentMcpHandler, driven by a plain tool-calling loop over the Gateway's chat-completions API. No vendor CLI or subscription is involved. */
import { agentMcpHandler } from './connector-micro-agent-mcp.js';
import { lifecycle, quiet } from '../../runtime/lifecycle-log.js';
import { stateDirectory } from '../../session/store/paths.js';
import { listedModels } from '../../gateway/model-names.js';
import { ProviderCircuit } from '../../gateway/provider-circuit.js';

/** The models that may run a connector hand-off, best first. Each is matched against what the Gateway lists now (src/gateway/model-names.ts):
 * the name `claude-sonnet-5-5` stopped resolving on 2026-11-17 and every hand-off failed at once. CLIKCODE_MICRO_AGENT_MODEL goes first. */
const MICRO_MODELS = ['claude-sonnet-5-5', 'claude-opus-5-5', 'gpt-5.2', 'gemini-3.1-pro', 'claude-sonnet-4-6'];
/** A reply that says this model cannot serve the request now (not listed for the account, or its providers are out of credit). */
const UNAVAILABLE = /not available to you|out of credit|no provider can serve|no model can take/i;
const MODEL_BENCH_MS = 5 * 60_000;
const benchedModels = new Map<string, number>();
const PROVIDER_OUTAGE_MS = 5 * 60_000;
const providerCircuit = new ProviderCircuit();

/** The models to try for a hand-off, in order: those the Gateway lists (the names as it lists them), minus any that failed lately. */
export async function microModels(listed?: readonly string[]): Promise<string[]> {
  const wanted = [...(process.env.CLIKCODE_MICRO_AGENT_MODEL ? [process.env.CLIKCODE_MICRO_AGENT_MODEL] : []), ...MICRO_MODELS];
  let known = listed;
  if (!known) { try { known = (await (await import('../../gateway/models.js')).gatewayModels()).models.map(model => model.id); } catch { known = undefined; } }
  const resolved = known ? listedModels(wanted, known) : [];
  // A list that could not be read, or that holds none of them, is asked for by the names as written: the Gateway accepts aliases it does not list.
  const all = resolved.length ? resolved : wanted;
  const now = Date.now();
  const fit = all.filter(id => (benchedModels.get(id) ?? 0) <= now);
  return fit.length ? fit : all;
}
const MAX_TURNS = 80;

interface Message { role: 'system' | 'user' | 'assistant' | 'tool'; content?: string | null; tool_calls?: unknown[]; tool_call_id?: string }
interface Reply { choices?: { message?: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[]; error?: { message?: string } }

export interface GatewayMicroOptions { /** The models to try, in order (default: the Gateway's current ones, microModels()). */ models?: readonly string[]; tab: string; maxCalls: number; maxMs: number; connector?: string; counter?: string; fetchImpl?: typeof fetch; connection?: { baseUrl: string; apiKey: string }; tools?: Parameters<typeof agentMcpHandler>[0]['tools']; availability?: ProviderCircuit; now?: () => number }

export async function runGatewayMicro(prompt: string, options: GatewayMicroOptions): Promise<{ text: string; timedOut: boolean; calls: number; error?: string }> {
  const clock = options.now ?? Date.now;
  const circuit = options.availability ?? providerCircuit;
  const outage = circuit.state(clock());
  if (outage.open) return { text: '', timedOut: false, calls: 0, error: `Gateway temporarily unavailable until ${new Date(outage.retryAt!).toISOString()}: ${outage.reason ?? 'all configured providers are unavailable'}` };
  const connection = options.connection ?? await (async () => {
    const { gatewayConnection } = await import('../models/for-session.js');
    const Conf = (await import('conf')).default;
    return gatewayConnection(new Conf({ projectName: 'clikcode', configFileMode: 0o600 }));
  })();
  const handle = agentMcpHandler({ tab: options.tab, maxCalls: options.maxCalls, ...(options.tools ? { tools: options.tools } : {}), ...(options.counter ? { counter: options.counter } : {}), ...(options.connector ? { connector: options.connector } : {}) });
  const listed = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) as { result?: { tools?: { name: string; description: string; inputSchema: unknown }[] } };
  const tools = (listed.result?.tools ?? []).map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
  const doFetch = options.fetchImpl ?? fetch;
  const candidates = [...(options.models ?? await microModels())];
  let model = candidates[0] ?? MICRO_MODELS[0]!, nextCandidate = 1;
  const messages: Message[] = [{ role: 'user', content: prompt }];
  const deadline = Date.now() + options.maxMs;
  let calls = 0, text = '', timedOut = false, error: string | undefined, unavailable = 0;
  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const left = deadline - Date.now();
      if (left <= 0) { timedOut = true; break; }
      const root = connection.baseUrl.replace(/\/+$/, '');
      const turnStarted = Date.now();
      const response = await doFetch(`${root.endsWith('/v1') ? root : `${root}/v1`}/chat/completions`, {
        method: 'POST', signal: AbortSignal.timeout(Math.min(left, 120_000)),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${connection.apiKey}`, 'x-client': 'clikcode-micro-agent' },
        body: JSON.stringify({ model, messages, tools, stream: false }),
      }).catch((cause: unknown) => { if (Date.now() >= deadline) timedOut = true; else error = `Gateway request failed: ${cause instanceof Error ? cause.message : String(cause)}`; return undefined; });
      if (!response) break;
      const body = await response.json().catch(() => ({})) as Reply;
      // How long each turn and each tool call takes is written down, so a vendor that burns its whole budget on a few calls says which.
      lifecycle('micro.turn', { tab: options.tab, turn, ms: Date.now() - turnStarted, status: response.status });
      if (!response.ok) {
        const said = body.error?.message ?? 'request refused';
        // This model cannot serve the request now: it sits out for a while and the next one takes the same turn.
        if (UNAVAILABLE.test(said)) {
          unavailable++;
          if (nextCandidate < candidates.length) {
            benchedModels.set(model, clock() + MODEL_BENCH_MS);
            lifecycle('micro.model', { tab: options.tab, from: model, to: candidates[nextCandidate], why: said.slice(0, 80) });
            model = candidates[nextCandidate++]!;
            turn--;
            continue;
          }
          if (candidates.length > 1 && unavailable === candidates.length) {
            const why = 'every configured Gateway model is unavailable';
            circuit.open(clock(), PROVIDER_OUTAGE_MS, why);
            error = `Gateway temporarily unavailable: ${why}; retry after ${Math.round(PROVIDER_OUTAGE_MS / 1000)} seconds`;
            lifecycle('micro.providers-unavailable', { tab: options.tab, count: candidates.length, retryMs: PROVIDER_OUTAGE_MS });
            break;
          }
        }
        error = `Gateway ${response.status}: ${said}`.slice(0, 300);
        break;
      }
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
        const callStarted = Date.now();
        const raced = await Promise.race([handle({ jsonrpc: '2.0', id: ++calls, method: 'tools/call', params: { name: call.function.name, arguments: args } }), timeout]);
        clearTimeout(timer.id);
        lifecycle('micro.call', { tab: options.tab, tool: call.function.name, ...(typeof args.action === 'string' ? { action: args.action } : {}), ms: Date.now() - callStarted, ...(raced === 'late' ? { late: true } : {}) });
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
