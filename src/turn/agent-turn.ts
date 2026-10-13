/** ClikCode's own agent turn, using Gateway or a local model for inference. */
import { summarySources } from './summary-sources.js';
import { agentMcpServer, gatewayAgentSession, type GatewayAgentSession } from '../gateway/agent-session.js';
import type Conf from 'conf';
import { routeMcpServers } from '../gateway/mcp.js';
import { modelClientForSession } from '../agent/models/for-session.js';
import { isClikCodeAgent, isGatewayService } from '../session/route.js';
import { readState } from '../session/state/read.js';
import { discardInterruptedTurn } from './turn-journal.js';
import { agentTurnUsage, runGatewayHarnessSessionTurn } from '../gateway/harness.js';
import { turnStopReason, type TurnUsage } from '../harness/protocol/turn-usage.js';
import { prepareSessionTitle, replyWithoutTitle } from '../session/title.js';
import { localModelTurnHooks } from '../commands/ai/local-model.js';
import { completeTurnCheckpoint, startTurnCheckpoint } from './turn-journal.js';
import type { TurnRunOptions } from './session-turn.js';
import type { HarnessSession, HarnessState } from '../session/model.js';
import { emitHarnessOutput } from '../harness/output.js';
import { prepareAttachments } from '../session/attachments.js';
import { setPlanMode, unfinishedUsageRecorder } from './turn-steps.js';
import { recordInvocation, showStopReason } from './turn-output.js';
import { isTurnCancelled } from '../agent/cancellation.js';
import chalk from 'chalk';
import { agentTurnFailureKind } from './failover.js';
import { usageExhaustedMessage } from './usage-exhausted.js';
import { signInGatewayForTurn } from '../gateway/sign-in-for-turn.js';
import { seedAgentConversation } from './agent-history.js';
import { ConversationStore } from '../agent/conversation.js';
import { stateDirectory } from '../session/store/paths.js';
import { localHarnessForCommand } from '../runtime/lazy-bridge.js';
import { lifecycle } from '../runtime/lifecycle-log.js';
import { withResourceNotes } from './resource-notes.js';

/** The account and model as the user has them now, before each model step.
 * Leaving this agent route hands the conversation to that account without
 * ending it. A client that cannot be rebuilt keeps the previous one: a bad
 * setting reaches the user as a notice, not as a thrown turn. */
export function stepClientRefresher(input: {
  session: HarnessSession; config: Conf; agentModel: string | undefined;
  current: () => Awaited<ReturnType<typeof modelClientForSession>>;
  adopt: (client: Awaited<ReturnType<typeof modelClientForSession>>) => void;
  notice: (message: string) => void;
}) {
  const { session, config } = input;
  return async () => {
    const stored = (await readState({ transcripts: [] })).sessions.find((item) => item.id === session.id);
    if (stored && !isClikCodeAgent(stored)) return 'switch' as const;
    // Model, effort and speed are read back before every model step: a change made while the turn
    // runs applies to the next call, not to the next turn.
    if (!stored || (stored.model === session.model && stored.effort === session.effort && stored.speed === session.speed)) return undefined;
    const before = { model: session.model, effort: session.effort, speed: session.speed };
    session.model = stored.model;
    session.effort = stored.effort;
    session.speed = stored.speed;
    try {
      // The same effective session the turn started with: the agent's own
      // model, unless the conversation chose one.
      const next = await modelClientForSession(input.agentModel && !session.model ? { ...session, model: input.agentModel } : session, config);
      input.adopt(next);
      return next;
    } catch (error) {
      Object.assign(session, before);
      input.notice(`Could not apply the new model settings; this turn continues with the previous ones: ${error instanceof Error ? error.message : String(error)}`);
      return input.current();
    }
  };
}

/** A turn on a route that runs ClikCode's own agent: the Gateway, or
 * ClikCode Local. */
export async function runAgentTurn(input: {
  config: Conf; state: HarnessState; session: HarnessSession; prompt: string; signal?: AbortSignal; run: TurnRunOptions;
}): Promise<'continue' | 'resend' | void> {
  const { config, state, session, prompt, signal, run } = input;
  // A Gateway agent runs HERE, as ClikCode's own agent: the Gateway is the intelligence, the agent adds
  // its instructions and its platform tools, ClikCode is the harness (gateway/agent-session.ts).
  const agentId = session.route === 'gateway' ? session.gatewayAgentId : undefined;
  const agent: GatewayAgentSession | undefined = agentId ? await gatewayAgentSession(config, { ...session, gatewayAgentId: agentId }, signal) : undefined;
  const prompter = run.prompter;
  const gatewayService = isGatewayService(session);
  // Attribution for the invocation log and the output payload: the route's
  // own name, so ClikCode Local turns are never counted as Gateway usage.
  const attributedTo = gatewayService ? 'gateway' : 'clikcode-local';
  const text = prompt.trim();
  if (!text) throw new Error('prompt is required');
  const prepared = await prepareAttachments(session.attachments ?? []);
  // Images are not refused: the agent loop runs on this machine and reads the
  // attached files with its own tools (run-turn.ts names them).
  // One turn asks for a title, once the user has said enough to name the
  // chat. The agent writes no title of its own anywhere ClikCode can read.
  // Every other turn sends the prompt unchanged and does not filter the reply.
  const agentTitle = prepareSessionTitle(session, `${text}${prepared.textContext}`);
  const titleStream = agentTitle.stream;
  // Resource notes ClikCode held for this conversation ride the same way (turn/resource-notes.ts).
  const turnText = withResourceNotes(session.id, agentTitle.prompt);
  // Before the checkpoint, so a route that cannot serve a turn (the Gateway
  // not signed in, ClikCode Local's engine absent) fails without recording
  // a turn that never ran.
  // ClikCode Local shows its model coming up here: on the waiting line in a
  // terminal, on stderr headless. In a worker the terminal already brought
  // it up, so this is a silent join.
  const localHooks = session.route === 'clikcode-local' ? localModelTurnHooks(session.id) : undefined;
  let modelClient: Awaited<ReturnType<typeof modelClientForSession>>;
  // The agent's own model, unless the conversation chose one.
  const modelSession = agent?.model && !session.model ? { ...session, model: agent.model } : session;
  try { modelClient = await modelClientForSession(modelSession, config, localHooks); }
  finally { localHooks?.done(); }
  /** The account and model as the user has them now, before each model
   * step. Leaving this agent route hands the conversation to that account
   * without ending it. */
  const modelClientForStep = stepClientRefresher({
    session, config, agentModel: agent?.model ?? undefined,
    current: () => modelClient, adopt: (next) => { modelClient = next; }, notice: (message) => prompter?.activity(chalk.yellow(message)),
  });
  const agentServer = agent ? agentMcpServer(config, agent) : undefined;
  const startedAt = Date.now();
  const checkpoint = await startTurnCheckpoint(state, session, text, run);
  /** Text the title filter held back and now owes: to the saved turn and to
   * the screen alike, like every streamed delta. */
  const releaseHeld = (): void => {
    const held = titleStream?.flush();
    if (!held) return;
    checkpoint.response(held, 'append');
    prompter?.response(held, 'append');
  };
  let turnUsage: TurnUsage | undefined;
  /** The turn's usage went into the invocation log: once, however it ended. */
  let usageRecorded = false;
  const recordUnfinished = unfinishedUsageRecorder(state, undefined, () => {
    if (usageRecorded) return undefined;
    usageRecorded = true;
    // Every model step reported its running total through onUsage: a turn
    // stopped, failed or handed on mid-way spent that much all the same.
    return {
      sessionId: session.id, accountId: attributedTo, provider: session.provider ?? attributedTo,
      model: (gatewayService ? session.reported?.model : undefined) ?? session.model, startedAt, usage: turnUsage,
    };
  });
  // The agent remembers what it ran itself. Turns that ran elsewhere -- the
  // conversation moved here from another harness, or was away on one since --
  // go into its memory first (agent-history.ts), so the model the Gateway
  // serves starts from the conversation, not from this prompt alone.
  const memory = new ConversationStore(stateDirectory(), session.id);
  let held: Awaited<ReturnType<typeof seedAgentConversation>> = { total: 0, seeded: 0 };
  let memoryBytes = 0;
  let seededOk = false;
  // The coding agent runs here, on this machine; the model server supplies
  // the model step and nothing else. A server that cannot serve one fails the
  // turn with its own reason (for-session.ts gatewayErrorMessage).
  try {
    held = await seedAgentConversation({
      session, stateDir: stateDirectory(), ...(modelClient.contextHints?.contextWindow ? { contextWindow: modelClient.contextHints.contextWindow } : {}),
      summaries: summarySources(state.accounts),
      displayName: (command) => localHarnessForCommand(command)?.displayName,
    });
    if (held.seeded) lifecycle('thread.take-up', { harness: attributedTo, how: 'agent-memory', turns: held.total, seeded: held.seeded, ...(held.summarized ? { summarized: held.summarized, summaryFrom: held.summaryFrom } : {}) });
    session.agentThreadTurns = held.total;
    memoryBytes = await memory.size();
    seededOk = true;
    // The Gateway refused this machine's sign-in before anything ran: sign in
    // (sign-in-for-turn.ts) and ask again, once, as a vendor turn does.
    let signInTried = false;
    let harnessTurn: Awaited<ReturnType<typeof runGatewayHarnessSessionTurn>>;
    for (;;) {
      harnessTurn = await runGatewayHarnessSessionTurn({
        session, prompt: turnText, modelClient, modelClientForStep,
        // ClikDeploy's own account tools come with the Gateway.
        mcpServers: [...routeMcpServers(session, config), ...(agentServer ? [agentServer] : [])],
        ...(agent?.system ? { agentInstructions: agent.system } : {}),
        ...(prompter ? { prompter } : {}),
        ...(titleStream ? { responseFilter: (delta: string, mode: 'append' | 'replace') => titleStream.push(delta, mode) } : {}),
        // Each model step may open with the title again (the request rides in
        // the conversation every step re-sends): the filter watches every step's
        // start, and hands on whatever the previous step still held.
        ...(titleStream ? {
          onStepStart: () => {
            releaseHeld();
            titleStream.nextStep();
          },
        } : {}),
        ...(signal ? { signal } : {}),
        ...(prepared.images.length ? { images: prepared.images } : {}),
        // What streams is saved as it streams, as on every other route: a
        // worker that dies mid-turn leaves the answer so far, not nothing.
        onResponseDelta: (delta, mode) => checkpoint.response(delta, mode ?? 'append'),
        onActivity: (event) => checkpoint.activity(event),
        onUsage: (usage) => {
          turnUsage = { ...turnUsage, ...usage };
          session.lastUsage = { ...turnUsage, at: new Date().toISOString() };
        },
        // The model that answered, where a vendor's own report of its model
        // goes (vendor-cli-attempt.ts): the status line and the editor name it,
        // and for Automatic it is the only place that says which model it was.
        // The plan was approved: the chat leaves plan mode, saved with the turn.
        onPlanModeExit: () => setPlanMode(session, checkpoint, prompter, false),
        // The agent asked to plan and the user agreed: the chat stays in plan mode.
        onPlanModeEnter: () => setPlanMode(session, checkpoint, prompter, true),
        onServedModel: (served) => {
          // Automatic stays Automatic: a Gateway that names its pick is not echoed back onto the chat.
          if (!session.model && !session.gatewayAgentId) return;
          session.reported = { ...session.reported, at: new Date().toISOString(), model: served };
          checkpoint.touch();
          prompter?.render(session);
        },
        // The loop takes steering before each model step (run-turn.ts).
        onSteerReady: (handler) => run.liveInput?.setSteerHandler(handler ? async (steerText, submission) => {
          await handler(steerText);
          if (submission.kind !== 'note') await checkpoint.steer(submission);
        } : undefined),
      });
      const nothingRan = harnessTurn.steps === 0 && !session.pendingTurn?.response?.trim();
      if (!harnessTurn.isError || !gatewayService || signInTried || !nothingRan
        || agentTurnFailureKind(harnessTurn) !== 'authentication-required') break;
      signInTried = true;
      if (!await signInGatewayForTurn(config, prompter, signal)) break;
      // What the refused attempt wrote to the agent's memory (the request) is
      // taken back: the retry writes it again.
      await memory.truncate(memoryBytes);
      modelClient = await modelClientForSession(modelSession, config);
    }
    if (harnessTurn.stopReason === 'account-switch') {
      recordUnfinished('stopped');
      releaseHeld();
      const progressed = Boolean(harnessTurn.text.trim() || harnessTurn.steps > 0);
      if (!progressed) {
        await discardInterruptedTurn(session.id, text);
        return 'resend';
      }
      const extracted = replyWithoutTitle(harnessTurn.text, titleStream !== undefined, true);
      await completeTurnCheckpoint(session, checkpoint, extracted.text, { title: titleStream?.title ?? extracted.title, asked: false });
      return 'continue';
    }
    if (harnessTurn.isError) {
      // Out of Gateway usage is the outcome every provider's running out is
      // (account-routing.ts terminalFailoverError): "All accounts exhausted",
      // which offers Resume in on another provider. The Gateway's own words
      // (what it ran out of, where to add credit) stay on the turn.
      if (gatewayService && agentTurnFailureKind(harnessTurn) === 'quota-exhausted') {
        prompter?.activity(chalk.yellow(harnessTurn.text));
        throw new Error(usageExhaustedMessage());
      }
      throw new Error(harnessTurn.text || `${attributedTo} harness turn failed`);
    }
    // A reply shorter than the title filter's decision window is still held
    // back when the stream ends; it is owed to the screen.
    releaseHeld();
    const usage = { ...agentTurnUsage(harnessTurn.usage), ...turnUsage };
    // The loop's own reason wins where it ended the turn early (no progress, a model error).
    const loopStop = turnStopReason(harnessTurn.stopReason);
    if (loopStop && loopStop !== 'completed') usage.stopReason = loopStop;
    usageRecorded = true;
    const harnessInvocation = recordInvocation(state, {
      sessionId: session.id, accountId: attributedTo, provider: session.provider ?? attributedTo,
      // The model that answered: for Automatic the session names none.
      model: (gatewayService ? session.reported?.model : undefined) ?? session.model, startedAt, usage,
      // Which context profile the agent ran under, so an evaluation can
      // attribute time and quality to it (agent/context-profile.ts).
      contextProfile: harnessTurn.contextProfile,
    });
    // The marker is taken off only the turn that asked for it. A repeated
    // marker inside that same multi-step reply is the same request, not a
    // second naming.
    const extracted = replyWithoutTitle(harnessTurn.text, titleStream !== undefined, true);
    const completedText = await completeTurnCheckpoint(session, checkpoint, extracted.text, { title: titleStream?.title ?? extracted.title, asked: false });
    showStopReason(prompter, usage.stopReason);
    if (!prompter) {
      emitHarnessOutput({
        session, text: completedText, invocation: harnessInvocation,
        usage: {
          attributedBy: attributedTo, ...usage,
          ...(harnessTurn.contextProfile ? { contextProfile: harnessTurn.contextProfile } : {}),
        },
      });
    }
  } catch (error) {
    recordUnfinished(isTurnCancelled(error) ? 'stopped' : 'error');
    throw error;
  } finally {
    // The turn is in the agent's memory once it wrote to it -- also when the
    // turn then failed or was stopped, which leaves its prompt there.
    if (seededOk && await memory.size().catch(() => 0) > memoryBytes) session.agentThreadTurns = held.total + 1;
    checkpoint.touch();
    await checkpoint.flush();
  }
}
