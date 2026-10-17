/** The worker's command dispatch: what each message a window sends does. */
import type { Socket } from 'node:net';
import { lifecycle } from '../runtime/lifecycle-log.js';
import { persistentWorkRunning } from '../turn/vendor-process.js';
import { isClikCodeAgent, isGatewayService } from '../session/route.js';
import { gatewayModels } from '../gateway/models.js';
import { routeMcpServers } from '../gateway/mcp.js';
import { prepareMcp, releaseMcp } from '../agent/mcp/manager.js';
import { stateDirectory } from '../session/store/paths.js';
import { computerEnabled } from '../agent/computer/settings.js';
import { computerPage, openComputerPage } from '../agent/computer/browser.js';
import { loginComputerPage, loginOutcomeMessage } from '../agent/computer/login-page.js';
import { LoginError } from '../agent/computer/login-error.js';
import { manageSavedLogins } from '../agent/computer/login-manager.js';
import { askPrivateLogin } from '../agent/computer/private-login-prompt.js';
import { runSharedComputerTool } from './computer-tool.js';
import { homedir } from 'node:os';
import { sendEvent, windowReadsSaved } from './broadcast-observer.js';
import type { ClientCommand } from './protocol.js';
import { createAgentsCommand } from './worker-agents.js';
import { createLiveCommands } from './worker-live-commands.js';
import type { ConnectionState, WorkerContext } from './worker-context.js';

export function createCommandHandler(ctx: WorkerContext) {
  const { observer, sessionId, config, token } = ctx;
  const { currentSessionAndAccount } = ctx.io;
  const live = createLiveCommands(ctx);
  const agentsCommand = createAgentsCommand(ctx);

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
    // Before any snapshot: the first one is already the slim kind.
    if (command.readsSaved) windowReadsSaved(socket);
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

  /** `retire`: the worker decides, not the window asking. `presented` is the
   * token of a question asked on its own (no attach): checked here, and the
   * answer goes to the asker directly, because it is not in the broadcast. */
  const handleRetire = async (socket: Socket, presented?: string): Promise<void> => {
    if (presented !== undefined && presented !== token) {
      sendEvent(socket, { type: 'attach-rejected', reason: 'stale or invalid token' });
      socket.end();
      return;
    }
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
    // Told before it goes, so an asker that never attached still hears it.
    if (presented !== undefined) sendEvent(socket, { type: 'shutdown', reason: 'replaced by a newer ClikCode build' });
    void ctx.shutdown('replaced by a newer ClikCode build');
    return;
  };

  return async (socket: Socket, command: ClientCommand, connection: ConnectionState): Promise<void> => {
    if (command.type === 'attach') { await handleAttach(socket, command, connection); return; }
    if (command.type === 'retire' && command.token !== undefined) { await handleRetire(socket, command.token); return; }
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
          ctx.pendingCancel = undefined;
          if (!ctx.activeController) ctx.stopAnnounced = false;
          // Every window heard `stopping`; every one hears it ended.
          observer.broadcast({ type: 'stop-done', nothing: true });
        }
      }
      return;
    }
    if (command.type === 'approval-response') { observer.resolveApproval(command.id, command.approved); return; }
    if (command.type === 'question-response') { observer.resolveQuestion(command.id, command.result); return; }
    if (command.type === 'computer-login') {
      sendEvent(socket, { type: 'computer-login-started', id: command.id });
      const controller = new AbortController();
      const cancel = (): void => controller.abort();
      socket.once('close', cancel);
      void (async () => {
        try {
          const stateDir = stateDirectory();
          if (!await computerEnabled(stateDir)) throw new LoginError('Computer use is off.');
          // This command's own IPC client cannot display question fields.
          if (observer.attachedCount < 2) throw new LoginError('No chat window is open to show the prompt. Open this chat in the terminal or VS Code.');
          if (command.manage) {
            const message = await manageSavedLogins(observer, stateDir, controller.signal);
            if (!socket.destroyed) sendEvent(socket, { type: 'computer-login-result', id: command.id, ok: true, message });
            return;
          }
          const page = command.url ? await openComputerPage(stateDir) : await computerPage(stateDir);
          if (command.url) {
            const url = new URL(command.url);
            if (url.protocol !== 'https:' || url.username || url.password) throw new LoginError('Private login needs an HTTPS website URL without credentials.');
            await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 30_000 });
          }
          const outcome = await loginComputerPage({ stateDir, page, signal: controller.signal, ...(command.newAccount ? { newAccount: true } : {}),
            ask: (site, fields, signal) => askPrivateLogin(observer, site, fields, signal) });
          if (!socket.destroyed) sendEvent(socket, { type: 'computer-login-result', id: command.id,
            ok: outcome !== 'unverified' && outcome !== 'saved_login_rejected', message: loginOutcomeMessage(outcome) });
        } catch (error) {
          if (!socket.destroyed) sendEvent(socket, { type: 'computer-login-result', id: command.id, ok: false,
            message: error instanceof LoginError ? error.message : 'Private login did not finish. Check the browser and try again.' });
        } finally { socket.off('close', cancel); }
      })();
      return;
    }
    if (command.type === 'computer-tool') {
      sendEvent(socket, { type: 'computer-tool-started', id: command.id });
      const controller = new AbortController();
      const cancel = (): void => controller.abort();
      socket.once('close', cancel);
      void (async () => {
        const result = await runSharedComputerTool({ observer, stateDir: stateDirectory(), homeDir: homedir(), tool: command.tool, args: command.args,
          signal: controller.signal, windows: () => observer.attachedCount });
        if (!socket.destroyed) sendEvent(socket, { type: 'computer-tool-result', id: command.id, ...result });
        socket.off('close', cancel);
      })();
      return;
    }
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
    if (command.type === 'agents') { sendEvent(socket, await agentsCommand(command)); return; }
    if (command.type === 'send-queued') { await live.handleSendQueued(socket, command); return; }
    if (command.type === 'cancel') { await live.handleCancel(socket, command); return; }
    if (command.type === 'steer') { await live.handleSteer(socket, command); return; }
    if (command.type === 'steer-subagent') { await live.handleSteerSubagent(socket, command); return; }
  };
}
