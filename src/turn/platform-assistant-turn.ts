/** The Gateway platform assistant used when its model endpoint cannot serve a turn. */
import { stdout as output } from 'node:process';
import type Conf from 'conf';
import chalk from 'chalk';
import { gatewayConnection } from '../agent/models/for-session.js';
import { CLIKCODE_USER_AGENT } from '../version.js';
import { isJsonDefaultMode } from '../cli/output-mode.js';
import type { HarnessActivityEvent } from '../harness/prompter.js';
import type { HarnessSession, HarnessState } from '../session/model.js';
import { completeTurnCheckpoint, type DurableTurnCheckpoint } from './turn-journal.js';
import type { TurnRunOptions } from './session-turn.js';
import { emitHarnessOutput } from '../harness/output.js';
import type { StreamingTitle } from '../session/title.js';
import { recordInvocation, turnSink } from './turn-output.js';

/** What the Gateway's final `result` event says that the text did not. */
function gatewayResultNotice(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const result = data as { requiresConfirmation?: unknown; pendingToolCalls?: unknown };
  const pending = Array.isArray(result.pendingToolCalls) ? result.pendingToolCalls : [];
  if (result.requiresConfirmation !== true && pending.length === 0) return undefined;
  const names = pending.map((call) => {
    const record = call && typeof call === 'object' ? call as { name?: unknown; tool?: unknown; toolName?: unknown } : {};
    return [record.name, record.tool, record.toolName].find((value): value is string => typeof value === 'string');
  }).filter((name): name is string => Boolean(name));
  const what = pending.length ? `${pending.length} action${pending.length === 1 ? '' : 's'}${names.length ? ` (${[...new Set(names)].slice(0, 5).join(', ')})` : ''}` : 'an action';
  return `The platform is holding ${what} for your confirmation and has NOT run ${pending.length === 1 || !pending.length ? 'it' : 'them'}. ClikCode cannot confirm ClikDeploy Gateway actions yet — approve ${pending.length === 1 || !pending.length ? 'it' : 'them'} in the ClikDeploy dashboard assistant.`;
}

export async function runPlatformAssistantTurn(input: {
  config: Conf;
  state: HarnessState;
  session: HarnessSession;
  turnText: string;
  baseMessages: NonNullable<HarnessSession['messages']>;
  checkpoint: DurableTurnCheckpoint;
  startedAt: number;
  titleStream?: StreamingTitle;
  signal?: AbortSignal;
  run: TurnRunOptions;
}): Promise<void> {
  const { config, state, session, turnText, baseMessages, checkpoint, startedAt, titleStream, signal, run } = input;
  const prompter = run.prompter;
  const sink = turnSink(checkpoint, prompter);
  // Only a Gateway session reaches here, and it is the same connection the
  // model client was built from.
  const { baseUrl, apiKey } = gatewayConnection(config);
  try {
  const response = await fetch(`${baseUrl}/api/assistant/chat`, {
    method: 'POST',
    signal,
    headers: { authorization: `Bearer ${apiKey}`, accept: 'text/event-stream', 'content-type': 'application/json', 'user-agent': CLIKCODE_USER_AGENT },
    body: JSON.stringify({ message: turnText, messages: baseMessages, mode: 'plan' }),
  });
  if (!response.ok || !response.body) throw new Error(`gateway AI request failed (${response.status})`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let reply = '';
  let gatewayNotice: string | undefined;
  const streamToTerminal = !isJsonDefaultMode() && !prompter;
  let wroteDelta = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary).trim();
      buffer = buffer.slice(boundary + 2);
      if (frame.startsWith('data:')) {
        const event = JSON.parse(frame.slice('data:'.length).trim()) as { type?: string; text?: string; error?: string; label?: string; kind?: 'thinking' | 'tool-start'; tool?: string; data?: unknown };
        // The server's final `result` carries what the text stream cannot:
        // tool calls it is holding back for confirmation. Dropping it left
        // the user with a reply that implied work the platform never did.
        if (event.type === 'result') gatewayNotice = gatewayResultNotice(event.data) ?? gatewayNotice;
        if (event.type === 'delta' && typeof event.text === 'string') {
          reply += event.text;
          const visible = titleStream ? titleStream.push(event.text, 'append') : event.text;
          if (visible !== undefined) {
            checkpoint.response(visible, 'append');
            prompter?.phase('generating response');
            prompter?.response(visible, 'append');
            if (streamToTerminal) { output.write(visible); wroteDelta = true; }
          }
        }
        // `kind`/`tool` are real, additive fields on the wire protocol
        // (the assistant chat route) mapping the
        // backend's own `{ status: 'thinking' }` / `{ status: 'tool_call',
        // tool }` into the same canonical shape native harnesses' own
        // parsers produce, so a Gateway tool call's *activity log line*
        // renders identically to a Codex or Claude Code one — same glyph,
        // same color, same bare-subject wording (renderActivityLine adds its
        // own verb, so the canonical label here is the bare tool name via
        // `tool`, not the backend's already-verbed `label`). The status line
        // stays the turn. There's no 'tool-done' here because AssistantChatEvent has no completion
        // signal to report (verified: 'tool_call' fires once, nothing after
        // it) — a real gap in what the agent loop reports, not something to
        // fake here.
        if (event.type === 'status' && typeof event.label === 'string') {
          const activityEvent: HarnessActivityEvent = { kind: event.kind === 'tool-start' ? 'tool-start' : 'thinking', label: event.tool ?? event.label };
          sink.activity(activityEvent);
        }
        if (event.type === 'error') throw new Error(event.error ?? 'gateway AI request failed');
      }
      boundary = buffer.indexOf('\n\n');
    }
  }
  if (gatewayNotice) {
    if (prompter) prompter.activity(`${chalk.yellow('gateway')} ${chalk.dim(gatewayNotice)}`);
    else if (!isJsonDefaultMode()) output.write(`${wroteDelta ? '\n' : ''}${chalk.yellow('ClikDeploy Gateway:')} ${gatewayNotice}\n`);
    if (!reply) reply = gatewayNotice;
  }
  if (!reply) throw new Error('gateway AI response contained no text');
  const invocation = recordInvocation(state, { sessionId: session.id, accountId: 'gateway', provider: session.provider ?? 'gateway', model: session.model, startedAt });
  const completedText = await completeTurnCheckpoint(session, checkpoint, reply, { title: titleStream?.title });
  if (wroteDelta) output.write('\n\n');
  else if (!prompter) emitHarnessOutput({ session, text: completedText, usage: { attributedBy: 'gateway' }, invocation, ...(gatewayNotice ? { notice: gatewayNotice } : {}) });
  } finally {
    await checkpoint.flush();
  }
}
