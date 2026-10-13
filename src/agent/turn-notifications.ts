/** What reaches the model between steps without it asking: steering typed
 * mid-turn, background shells that finished, background agents that finished. */
import { formatShellNotifications, takeShellNotifications } from './session-state.js';
import { formatAgentNotifications } from './background-agents.js';
import type { ConversationItem } from './model-client.js';
import { abortable } from './turn-support.js';
import type { TurnRuntime } from './turn-runtime.js';

/** Everything that arrived since the last step, in the order the model hears it. */
export async function deliverPending(rt: TurnRuntime): Promise<void> {
  const { input, session, backgroundAgents, append } = rt;
  if (rt.steerQueue.length) await append(...rt.steerQueue.splice(0).map((text): ConversationItem => ({ type: 'text', role: 'user', text })));
  // Background shells that finished since the last step. The model was
  // told it would hear about them rather than poll, so it hears here.
  const finished = input.subagent ? [] : takeShellNotifications(session);
  if (finished.length) {
    for (const note of finished) input.onActivity?.({ kind: 'tool-done', label: `${note.shellId} ${note.kind === 'wakeup' ? 'woke' : note.kind === 'output' ? 'output' : note.reason ? 'stopped' : 'exited'}: ${note.command}`, id: `shell-exit-${note.shellId}-${note.at}`, category: 'run' });
    await append({ type: 'text', role: 'user', text: formatShellNotifications(finished) });
  }
  // Background agents that finished without the model waiting for them.
  const agentResults = backgroundAgents?.takeFinished() ?? [];
  if (agentResults.length) {
    for (const note of agentResults) input.onActivity?.({ kind: note.result.isError ? 'tool-error' : 'tool-done', label: `${note.id} finished: ${note.label}`, id: `agent-done-${note.id}`, agent: true });
    await append({ type: 'text', role: 'user', text: formatAgentNotifications(agentResults) });
  }
}

/** The conversation left this route. Background agents it started
 * finish first, in this process, rather than being stopped by the
 * turn's end; their results go into this turn's memory and rows, so
 * the provider that takes over sees what they found. */
export async function finishBackgroundForSwitch(rt: TurnRuntime): Promise<void> {
  const { input, signal, backgroundAgents } = rt;
  while (backgroundAgents?.running()) {
    input.onPhase?.('waiting for background agents');
    await abortable(backgroundAgents.nextFinish(signal), signal);
  }
  const done = backgroundAgents?.takeFinished() ?? [];
  if (done.length) {
    for (const note of done) input.onActivity?.({ kind: note.result.isError ? 'tool-error' : 'tool-done', label: `${note.id} finished: ${note.label}`, id: `agent-done-${note.id}`, agent: true, output: note.result.output.split('\n').slice(0, 40) });
    await rt.append({ type: 'text', role: 'user', text: formatAgentNotifications(done) });
  }
}
