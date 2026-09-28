/** ClikCode's own agent turn, using Gateway or a local model for inference. */
import { randomUUID } from 'node:crypto';
import { stdout as output } from 'node:process';
import type Conf from 'conf';
import chalk from 'chalk';
import { routeMcpServers } from '../gateway/mcp.js';
import { modelClientForSession } from '../agent/models/for-session.js';
import { isClikCodeAgent, isGatewayService } from '../session/route.js';
import { gatewayHarnessFallbackNotice, gatewayHarnessUnavailable, runGatewayHarnessSessionTurn } from '../gateway/harness.js';
import { isJsonDefaultMode } from '../cli/output-mode.js';
import { extractSessionTitle, stripRepeatedTitles, prepareSessionTitle, titleStreamForAttempt } from '../session/title.js';
import { readState } from '../session/state/read.js';
import { localModelTurnHooks, releaseHeldLocalModel } from '../commands/ai/local-model.js';
import { completeTurnCheckpoint, startTurnCheckpoint, type TurnRunOptions } from './runtime.js';
import { emitHarnessOutput } from '../harness/output.js';
import { prepareAttachments } from '../session/attachments.js';
import { sessionTranscriptMessages } from './checkpoint.js';
import { aiSessionSend } from './account-turn.js';
import { runPlatformAssistantTurn } from './platform-assistant-turn.js';

/** Send a turn on a route that runs ClikCode's own agent: the Gateway, or
 * ClikCode Local. Any other session goes to aiSessionSend. Only the Gateway
 * has a platform assistant to fall back to. */
export async function aiGatewaySessionSend(
  config: Conf, id: string, prompt: string, signal?: AbortSignal, run: TurnRunOptions = {},
): Promise<void> {
  const prompter = run.prompter;
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  // A session that left ClikCode Local lets go of the model this process
  // held for it (a worker that ran its earlier turns, say).
  if (session.route !== 'clikcode-local') await releaseHeldLocalModel(session.id);
  if (!isClikCodeAgent(session)) return aiSessionSend(id, prompt, signal, run);
  const gatewayService = isGatewayService(session);
  // Attribution for the invocation log and the output payload: the route's
  // own name, so ClikCode Local turns are never counted as Gateway usage.
  const attributedTo = gatewayService ? 'gateway' : 'clikcode-local';
  const text = prompt.trim();
  if (!text) throw new Error('prompt is required');
  const prepared = await prepareAttachments(session.attachments ?? []);
  // No image refusal here any more, and it was not a limit: the gateway route
  // runs ClikCode's own agent loop on this machine, runGatewayHarnessSessionTurn
  // takes `images`, and run-turn.ts names the attached files for the agent to
  // read with its own file tools. This threw twenty lines above the call that
  // passes them, so the capability the code below implements was unreachable.
  // (The platform-assistant fallback further down cannot read local files at
  // all -- it says so in its own notice -- so images are simply not part of
  // that request, exactly as before.)
  // The first turns of a conversation carry the title request here too: the
  // gateway's coding agent and the platform assistant both answer as a
  // model, and neither writes a title of its own anywhere ClikCode can read.
  const agentTitle = prepareSessionTitle(session, `${text}${prepared.textContext}`);
  let titleStream = agentTitle.stream;
  const turnText = agentTitle.prompt;
  // Before the checkpoint, so a route that cannot serve a turn (the Gateway
  // not signed in, ClikCode Local's engine absent) fails without recording
  // a turn that never ran.
  // ClikCode Local shows its model coming up here: on the waiting line in a
  // terminal, on stderr headless. In a worker the terminal already brought
  // it up, so this is a silent join.
  const localHooks = session.route === 'clikcode-local' ? localModelTurnHooks(session.id) : undefined;
  let modelClient;
  try { modelClient = await modelClientForSession(session, config, localHooks); }
  finally { localHooks?.done(); }
  const startedAt = Date.now();
  const baseMessages = sessionTranscriptMessages(session);
  const checkpoint = await startTurnCheckpoint(state, session, text, run);
  // The coding agent runs here, on this machine; the gateway supplies the
  // model step and nothing else. Only a gateway that cannot serve that -- an
  // administrator kill switch, or a deployment older than the endpoint --
  // falls back to the platform assistant below, and says so when it does.
  try {
    const harnessTurn = await runGatewayHarnessSessionTurn({
      session, prompt: turnText, modelClient,
      // ClikDeploy's own account tools come with the Gateway.
      mcpServers: routeMcpServers(session, config),
      ...(prompter ? { prompter } : {}),
      ...(titleStream ? { responseFilter: (delta: string, mode: 'append' | 'replace') => titleStream?.push(delta, mode) } : {}),
      // Each model step may open with the title again (the request rides in
      // the conversation every step re-sends): the filter watches every step's
      // start, and hands on whatever the previous step still held.
      ...(titleStream ? {
        onStepStart: () => {
          const pending = titleStream?.flush();
          if (pending) prompter?.response(pending, 'append');
          titleStream?.nextStep();
        },
      } : {}),
      ...(signal ? { signal } : {}),
      ...(prepared.images.length ? { images: prepared.images } : {}),
      onActivity: (event) => checkpoint.activity(event),
      // The loop takes steering before each model step (run-turn.ts).
      onSteerReady: (handler) => run.liveInput?.setSteerHandler(handler ? async (steerText, submission) => {
        await handler(steerText);
        await checkpoint.steer(submission);
      } : undefined),
    });
    if (harnessTurn.isError) throw new Error(harnessTurn.text || `${attributedTo} harness turn failed`);
    // A reply shorter than the title filter's decision window is still held
    // back when the stream ends; it is owed to the screen.
    const held = titleStream?.flush();
    if (held) prompter?.response(held, 'append');
    const harnessInvocation = {
      id: randomUUID(), sessionId: session.id, accountId: attributedTo,
      provider: session.provider ?? attributedTo, ...(session.model ? { model: session.model } : {}),
      at: new Date().toISOString(), latencyMs: Date.now() - startedAt,
      // Which context profile the agent ran under, so an evaluation can
      // attribute time and quality to it (agent/context-profile.ts).
      ...(harnessTurn.contextProfile ? { contextProfile: harnessTurn.contextProfile } : {}),
    };
    state.invocations.push(harnessInvocation);
    const extracted = extractSessionTitle(harnessTurn.text);
    const named = { ...extracted, text: stripRepeatedTitles(extracted.text) };
    const completedText = await completeTurnCheckpoint(session, checkpoint, named.text, { title: titleStream?.title ?? named.title });
    if (!prompter) {
      emitHarnessOutput({
        session, text: completedText, invocation: harnessInvocation,
        usage: {
          attributedBy: attributedTo, ...harnessTurn.usage,
          ...(harnessTurn.contextProfile ? { contextProfile: harnessTurn.contextProfile } : {}),
        },
      });
    }
    await checkpoint.flush();
    return;
  } catch (error) {
    // The platform assistant is the Gateway's; a local model server's 404 is
    // a real failure of a real turn, never a reason to call the platform.
    if (!gatewayService || !gatewayHarnessUnavailable(error)) { await checkpoint.flush(); throw error; }
    const notice = gatewayHarnessFallbackNotice(error);
    // The assistant below is a second attempt at the same prompt, not a
    // continuation of the abandoned one.
    titleStream = titleStreamForAttempt(titleStream, turnText, session);
    if (prompter) prompter.activity(chalk.dim(notice));
    else if (!isJsonDefaultMode()) output.write(`${chalk.yellow('ClikDeploy Gateway:')} ${notice}\n`);
  }
  return runPlatformAssistantTurn({ config, state, session, turnText, baseMessages, checkpoint, startedAt, titleStream, signal, run });
}
