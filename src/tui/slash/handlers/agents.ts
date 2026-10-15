/** `/agents`: list the conversation's background agents, or stop some. The
 * worker owns them (agent/background-agents.ts), so this asks it. Esc and
 * Ctrl+C never stop an agent; this does, after naming what it would stop. */
import { WorkerClient } from '../../../worker/client.js';
import { readAgentRecords } from '../../../agent/agent-registry.js';
import { agentsReport } from '../../../worker/worker-agents.js';
import { stateDirectory } from '../../../session/store/paths.js';
import { emitHarnessOutput } from '../../../harness/output.js';
import type { ClientCommand, WorkerEvent } from '../../../worker/protocol.js';
import type { HeadlessSlashHandler } from './shared.js';

const ANSWER_MS = 10_000;

export async function askAgents(sessionId: string, command: Extract<ClientCommand, { type: 'agents' }>): Promise<string> {
  const client = await WorkerClient.attachExisting(sessionId);
  if (!client) {
    // No worker, so nothing runs: what the record says happened.
    const records = readAgentRecords(stateDirectory(), sessionId).map((record) => ({ id: record.id, label: record.label, status: record.status, startedAt: record.startedAt, ...(record.worktree ? { branch: record.worktree.branch } : {}) }));
    return `${agentsReport([], records)}\n\n(No worker is running for this conversation.)`;
  }
  try {
    const answered = new Promise<Extract<WorkerEvent, { type: 'agents' }>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The conversation\'s worker did not answer.')), ANSWER_MS);
      client.on('event', (event: WorkerEvent) => { if (event.type === 'agents') { clearTimeout(timer); resolve(event); } });
      client.on('close', () => { clearTimeout(timer); reject(new Error('The conversation\'s worker closed the connection.')); });
    });
    client.send(command);
    return (await answered).text;
  } finally {
    client.send({ type: 'detach' });
  }
}

/** `/agents`, `/agents stop <id>…`, `/agents stop all`, each with `confirm` to actually stop. */
export function parseAgentsArgs(words: readonly string[]): { action: 'list' } | { action: 'stop'; ids: string[]; all: boolean; confirm: boolean } {
  const rest = words.map((word) => word.toLowerCase());
  if (rest[0] !== 'stop') return { action: 'list' };
  const args = rest.slice(1);
  const confirm = args.some((word) => word === 'confirm' || word === 'yes' || word === '--yes');
  const named = args.filter((word) => !['confirm', 'yes', '--yes'].includes(word));
  const all = named.includes('all') || named.includes('everything');
  return { action: 'stop', ids: named.filter((word) => word !== 'all' && word !== 'everything'), all, confirm };
}

export const agentsHandlers: { agents: HeadlessSlashHandler } = {
  agents: async ({ id, words }) => {
    const parsed = parseAgentsArgs(words);
    if (parsed.action === 'stop' && !parsed.all && !parsed.ids.length) throw new Error('usage: /agents stop <id> [confirm], or /agents stop all [confirm]');
    const text = await askAgents(id, { type: 'agents', ...parsed });
    return emitHarnessOutput({ panel: 'agents', text });
  },
};
