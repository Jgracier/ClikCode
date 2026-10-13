/** The worker's command dispatch: what each message a window sends does. */
import type { Socket } from 'node:net';
import { lifecycle } from '../runtime/lifecycle-log.js';
import { persistentWorkRunning } from '../turn/vendor-process.js';
import { isClikCodeAgent, isGatewayService } from '../session/route.js';
import { gatewayModels } from '../gateway/models.js';
import { routeMcpServers } from '../gateway/mcp.js';
import { prepareMcp, releaseMcp } from '../agent/mcp/manager.js';
import { stateDirectory } from '../session/store/paths.js';
import { sendEvent } from './broadcast-observer.js';
import type { ClientCommand } from './protocol.js';
import { createLiveCommands } from './worker-live-commands.js';
import type { ConnectionState, WorkerContext } from './worker-context.js';

export function createCommandHandler(ctx: WorkerContext) {
  const { observer, sessionId, config, token } = ctx;
  const { currentSessionAndAccount } = ctx.io;
  const live = createLiveCommands(ctx);

  /** Ready for the route the conversation is on now -- or, off an agent
   * route, nothing left running that only an agent turn would use. */
  const prepareForRoute = async (): Promise<void> => {
    const { session: current } = await currentSessionAndAccount();
    if (!isClikCodeAgent(current)) { if (!ctx.turnRunning) await releaseMcp(); return; }
    prepareMcp(stateDirectory(), routeMcpServers(current, config));
    // Opens the connection the first step will reuse, and has the model list
    // ready for the picker.
    if (isGatewayService(current)) void gatewayModels({ config }).catch(() => undefined);
  };

  /** `attach`: a window joins, after its token is checked. */
  const handleAttach = async (socket: Socket, command: Extract<ClientCommand, { type: 'attach' }>, connection: ConnectionState): Promise<void> => {
    if (command.token !== token) {
      sendEvent(socket, { type: 'attach-rejected', reason: 'stale or invalid token' });
      socket.end();
      return;
    }
    // Read first, then join the broadcast and send the snapshot in the same
    // tick. Joined before the read, the window was sent every delta that
    // streamed during it AND a snapshot whose text already held them, and
    // drew that text twice.
    if (ctx.idleTimer) clearTimeout(ctx.idleTimer);
    ctx.idleTimer = undefined;
    connection.attaching = currentSessionAndAccount().then(({ session: current, account }) => {
      if (socket.destroyed) return;
      connection.attached = true;
      observer.attach(socket);
      lifecycle('worker.client.attach', { clients: observer.attachedCount, turnRunning: ctx.turnRunning });
      observer.snapshotFor(socket, current, account);
      // A turn waiting on an answer is asked again here: whoever it asked
      // may be gone, and this window may be the only one left to answer.
      observer.reofferPending(socket);
    });
    await connection.attaching;
    return;
  };

  /** `retire`: the worker decides, not the window asking. */
  const handleRetire = async (socket: Socket): Promise<void> => {
    // The worker decides, not the window asking: only it knows whether it
    // is in the middle of something. A window used to decide from the
    // state file and SIGTERM it -- killing another window's turn whenever
    // the file had not caught up with the worker.
    const blocker = ctx.idle.retireBlocker() ?? (await persistentWorkRunning(sessionId) ? 'the vendor is still running work it started' : ctx.idle.retireBlocker());
    if (blocker) {
      ctx.retireWhenIdle = true;
      sendEvent(socket, { type: 'retire-declined', reason: blocker });
      return;
    }
    void ctx.shutdown('replaced by a newer ClikCode build');
    return;
  };

  return async (socket: Socket, command: ClientCommand, connection: ConnectionState): Promise<void> => {
    if (command.type === 'attach') { await handleAttach(socket, command, connection); return; }
    if (connection.attaching) await connection.attaching.catch(() => undefined);
    if (!connection.attached) return;
    if (command.type === 'submit') {
      // Counted from acceptance to the answer: a Stop that comes in between
      // is the turn's, kept until it starts (worker-live-commands.ts).
      ctx.submitsInFlight++;
      try { await ctx.queue.handleSubmit(socket, command); } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendEvent(socket, { type: 'submit-rejected', message });
        sendEvent(socket, { type: 'turn-error', message });
        sendEvent(socket, { type: 'waiting-stop' });
      } finally {
        ctx.submitsInFlight--;
        // The submit ended without a turn to stop (queued, rejected): the Stop
        // asked for has nothing to apply to, and its askers are told.
        if (ctx.submitsInFlight === 0 && ctx.pendingCancel) {
          const { askers } = ctx.pendingCancel;
          ctx.pendingCancel = undefined;
          if (!ctx.activeController) ctx.stopAnnounced = false;
          for (const asker of askers) sendEvent(asker, { type: 'stop-done', nothing: true });
        }
      }
      return;
    }
    if (command.type === 'approval-response') { observer.resolveApproval(command.id, command.approved); return; }
    if (command.type === 'question-response') { observer.resolveQuestion(command.id, command.result); return; }
    if (command.type === 'sign-in-response') { observer.resolveSignIn(command.id, command.error); return; }
    if (command.type === 'refresh') {
      // What the window changed may be a turn parked for the reset.
      void ctx.resumeWaiter.check();
      const { session: current, account } = await currentSessionAndAccount();
      observer.render(current, account);
      return;
    }
    if (command.type === 'settings-changed') { ctx.liveSettings.apply(command.settings); return; }
    if (command.type === 'prepare') { await prepareForRoute(); return; }
    // Another window's turn may be using them: a turn keeps what it started,
    // and the turn's own end releases them if nobody is left.
    if (command.type === 'release') { if (!ctx.turnRunning) await releaseMcp(); return; }
    if (command.type === 'retire') { await handleRetire(socket); return; }
    if (command.type === 'detach') { socket.end(); return; }
    if (command.type === 'unqueue') { await live.handleUnqueue(socket, command); return; }
    if (command.type === 'send-queued') { await live.handleSendQueued(socket, command); return; }
    if (command.type === 'cancel') { await live.handleCancel(socket, command); return; }
    if (command.type === 'steer') { await live.handleSteer(socket, command); return; }
  };
}
