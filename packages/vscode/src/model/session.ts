/** The chat-level state a session snapshot sets, and what a new conversation starts from. */
import { pendingPromptText } from '../../../../src/tui/render/pending-prompt';
import type { HarnessSession, IdeModelLabel } from '../protocol';
import { withSavedTraces } from './traces';
import type { ChatModel } from './types';


export function emptyModel(): ChatModel {
  return { connection: 'starting', messages: [], notes: [], queued: [], running: false, plan: [], approvals: [], submissions: [], traces: [] };
}

/** What `choose provider` calls the provider a session runs on, for a bridge
 * that does not say (the `session` event's `providerId` does). */
export function providerIdOf(session: HarnessSession): string | undefined {
  if (session.route === 'gateway') return 'gateway';
  if (session.route === 'clikcode-local') return 'clikcode-local';
  return session.nativeHarness ?? undefined;
}

/** What a turn's end, a worker's shutdown and a lost connection all drop: the
 * locally echoed prompt, open requests, unanswered submissions and a Stop
 * waiting for its turn. The one place these are cleared. */
export const NO_TRANSIENT: Pick<ChatModel, 'pendingPrompt' | 'approvals' | 'submissions' | 'stopPending'> = {
  pendingPrompt: undefined, approvals: [], submissions: [], stopPending: undefined,
};

export function freshFor(model: ChatModel): ChatModel {
  return {
    ...emptyModel(), connection: model.connection,
    ...(model.version ? { version: model.version } : {}), ...(model.revision ? { revision: model.revision } : {}),
  };
}

/** The provider the bridge named with the session (its `session` event). */
export interface SessionProvider { id?: string; name?: string }

export function applySession(model: ChatModel, session: HarnessSession, account?: string, label?: IdeModelLabel, provider?: SessionProvider): ChatModel {
  const providerId = provider?.id ?? providerIdOf(session);
  if (model.sessionId && model.sessionId !== session.id) model = freshFor(model);
  // An empty chat that moves to another provider starts clean: what was said about the last one (a
  // cancelled sign-in) is not about this one, and would otherwise keep the welcome off the page.
  else if (model.sessionId === session.id && model.providerId !== undefined && model.providerId !== providerId
    && !model.messages.length && !model.running && !model.pendingPrompt && model.notes.length) model = { ...model, notes: [] };
  const pending = session.pendingTurn;
  return {
    ...model,
    ...(label ? { modelLabel: label } : {}),
    sessionId: session.id,
    title: session.name,
    harness: session.route === 'gateway' ? 'ClikDeploy Gateway' : session.route === 'clikcode-local' ? 'ClikCode Local' : session.nativeHarness,
    providerId,
    // A snapshot from the worker names no provider: the name stands while it is the same one.
    ...(provider ? (provider.name ? { providerName: provider.name } : { providerName: undefined }) : model.providerId === providerId && model.providerName ? { providerName: model.providerName } : { providerName: undefined }),
    // Automatic reads as the Gateway's own `auto`, never as a model it routed to.
    model: session.route === 'gateway' && !session.model && !session.gatewayAgentId ? 'auto' : session.reported?.model ?? session.model ?? undefined,
    account,
    agentId: session.route === 'gateway' ? session.gatewayAgentId : undefined,
    effort: session.route === 'gateway' ? undefined : session.effort || undefined,
    // What an agent may do to this machine applies on every route, the
    // Gateway's included: ClikCode's own agent asks before it edits.
    permissions: session.permissionMode ?? 'ask',
    route: session.route,
    workspace: session.workspace,
    messages: sameMessages(model.messages, session.messages ?? []) ? model.messages : (session.messages ?? []).map(({ role, content }) => ({ role, content })),
    traces: withSavedTraces(model.traces, session.messages ?? []),
    // What ClikCode owes the model (a finished background shell) is not the user's to see.
    queued: (session.queuedTurns ?? []).filter((item) => item.kind !== 'notification').map((item) => ({
      id: item.id, text: item.text, command: item.kind === 'command',
      // The running turn is holding it to send in once no tool call is open
      // (acp-client.ts); queued only in case that moment never comes.
      ...(item.heldForTurn && item.heldForTurn === pending?.startedAt ? { held: true } : {}),
    })),
    // The worker's journal of the running turn has the prompt from here on.
    // A send is drawn before the bridge prepares a worker. A snapshot taken
    // during that preparation has no pendingTurn yet; keep the local prompt
    // until the worker acknowledges it or the send is rejected.
    // The durable copy wins, and the sticky one goes once the transcript
    // holds it (the TUI's pendingPromptText): drawn on top of it, the
    // prompt showed twice.
    pendingPrompt: pendingPromptText({
      ...(pending?.prompt ? { durable: pending.prompt } : {}),
      ...((model.running || model.ownTurn) && model.pendingPrompt ? { sticky: model.pendingPrompt } : {}),
      // Where this turn's prompt lands: the message there, not the last
      // (an answered turn ends on the assistant's reply).
      lastMessage: session.messages?.[model.turnUserIndex ?? model.messages.length],
    }),
  };
}

/** Every snapshot carries the whole transcript as a new array; the one the
 * page already has is kept when it says the same, so it is not resent. */
export function sameMessages(previous: ChatModel['messages'], next: ChatModel['messages']): boolean {
  return previous.length === next.length
    && previous.every((message, index) => message.role === next[index]!.role && message.content === next[index]!.content);
}
