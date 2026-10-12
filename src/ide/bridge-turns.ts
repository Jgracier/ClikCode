/** Running lines and turns for the open conversation: what is sent at once or
 * queued, the queue's drain, one turn through the worker, and how a failed
 * turn is recovered (another account, another provider, a wait for the reset). */
import { existsSync } from 'node:fs';
import { expandHomePath } from '../session/attachments.js';
import { afterTurnFailure, prepareTurn } from '../session/attach.js';
import { readState } from '../session/state/read.js';
import { writeState } from '../session/state/write.js';
import { consumeSessionTurn } from '../turn/checkpoint.js';
import { INTERRUPTED_TURN_REQUEST } from '../turn/failover-prompt.js';
import { resumeWaitLabel } from '../turn/usage-exhausted.js';
import { isShellCommandLine } from '../commands/ai/shell-run.js';
import { aiSessionCommand } from '../tui/slash/handlers.js';
import { dispatchLine } from '../tui/slash/dispatch.js';
import { sessionHarness, slashRouteContextFor } from '../tui/slash/context.js';
import { commandDuringTurn, slashLineIsCommand } from '../tui/slash/queue.js';
import type { InteractiveSlashOutcome } from '../tui/slash/interactive-keys.js';
import type { ExhaustionRetryGuard } from '../tui/pickers/resume-in.js';
import { messageOf, TurnFailed } from './bridge-support.js';
import { createSlashHost } from './bridge-slash-host.js';
import type { BridgeHost } from './bridge-host.js';

export class BridgeTurns {
  /** The same-provider retry after running out: once per interrupted turn. */
  private readonly exhaustionGuard: ExhaustionRetryGuard = {};
  /** What the last turn actually sent, when a slash command expanded the
   * line (/review): what an interrupted turn recorded is compared to. */
  private sentPrompt: string | undefined;

  constructor(private readonly host: BridgeHost) {}

  async send(text: string, id?: string): Promise<void> {
    const line = text.trim();
    if (!line) return;
    try {
      if (this.host.link.workerTurnRunning && this.host.link.worker) {
        const sessionId = this.host.link.worker.sessionId;
        const { session } = await this.host.current(sessionId);
        const context = slashRouteContextFor(session, sessionHarness(session), (path) => existsSync(expandHomePath(path)));
        if (isShellCommandLine(line) || slashLineIsCommand(line, context)) {
          // ClikCode's own command: applied now if it is a pure setting,
          // otherwise run when the turn ends -- never sent to the model.
          const result = await commandDuringTurn(sessionId, line);
          if (id) this.host.channel.send({ type: 'worker', sessionId, event: { type: 'submission', id, disposition: result.disposition === 'queued' ? 'queued' : 'steered' } });
          await this.host.emitSession();
          return;
        }
        this.host.link.worker.client.send({ type: 'steer', text: line, ...(id ? { id } : {}) });
        return;
      }
    } catch (error) {
      this.host.report(error);
      return;
    }
    this.host.enqueue(async () => {
      await this.host.execute(line, {});
      await this.host.drainQueue();
    });
  }

  /** Messages typed during a turn that the harness could not take mid-turn,
   * and commands that waited for the turn to end: sent in order, as the
   * interactive loop does at the top of every pass. */
  async drainQueue(): Promise<void> {
    let previous: string | undefined;
    while (!this.host.closed && this.host.sessionId) {
      const state = await readState({ transcripts: [this.host.sessionId!] });
      const session = state.sessions.find((item) => item.id === this.host.sessionId);
      const queued = session?.queuedTurns?.[0];
      if (!session || !queued) return;
      // Still at the head after its run: it failed and could not be taken
      // out (the worker refuses it from then on). Sending it again would
      // only fail the same way; it waits for the user to remove it.
      if (queued.id === previous) return;
      previous = queued.id;
      if (queued.kind === 'command') {
        if (consumeSessionTurn(session, queued.id)) await writeState(state);
        await this.host.execute(queued.text, { fromQueuedCommand: true });
      } else {
        await this.host.execute(queued.text, { queuedTurnId: queued.id });
      }
    }
  }

  async execute(line: string, options: { queuedTurnId?: string; fromQueuedCommand?: boolean }): Promise<void> {
    const id = this.host.requireSession();
    this.sentPrompt = undefined;
    try {
      if (options.queuedTurnId) {
        await this.host.runTurn(id, line, { echo: true, queuedTurnId: options.queuedTurnId });
        return;
      }
      const outcome = await this.host.dispatch(line, Boolean(options.fromQueuedCommand));
      if (outcome.notice) this.host.channel.send({ type: 'notice', message: outcome.notice, level: 'info' });
      if (outcome.exit) {
        this.host.channel.send({ type: 'closed', sessionId: id });
        this.host.closeConversation();
        return;
      }
      if (outcome.id && outcome.id !== this.host.sessionId) await this.host.switchTo(outcome.id);
      else await this.host.emitSession();
      // /redo: the conversation went back; its prompt goes to the message box.
      if (outcome.draft !== undefined) this.host.channel.send({ type: 'restore-draft', text: outcome.draft });
      if (outcome.prompt) {
        this.sentPrompt = outcome.prompt;
        await this.host.runTurn(this.host.requireSession(), outcome.prompt, { echo: outcome.echo !== false });
      }
    } catch (error) {
      const next = await afterTurnFailure(this.host.prompter, id, error, {
        line, sent: this.sentPrompt ?? line, guard: this.exhaustionGuard, ...(options.queuedTurnId ? { queuedTurnId: options.queuedTurnId } : {}),
      });
      if ('retry' in next) {
        await this.host.execute(next.retry, {});
        return;
      }
      if ('moved' in next) {
        await this.host.switchTo(next.moved.id);
        // No prompt: another window already carried this turn on there.
        if (next.moved.prompt !== undefined) await this.host.execute(next.moved.prompt, {});
        return;
      }
      if (next.waiting) {
        // The worker sends it at the reset; it hears of the parked turn now.
        this.host.link.worker?.client.send({ type: 'refresh' });
        this.host.channel.send({ type: 'notice', message: `${resumeWaitLabel(next.waiting)} · a new message cancels`, level: 'info' });
        void this.host.refreshUsage().catch(() => undefined);
        return;
      }
      if (next.back.length) this.host.channel.send({ type: 'restore-draft', text: next.back.join('\n\n') });
      this.host.report(error);
    } finally {
      await this.host.emitSession().catch(() => undefined);
    }
  }

  /** One turn through the conversation's worker, after what the terminal
   * does before one (prepareTurn). */
  async runTurn(targetId: string, prompt: string, turn: { echo: boolean; queuedTurnId?: string }): Promise<void> {
    // Carrying on an interrupted turn is not something the user typed.
    if (prompt === INTERRUPTED_TURN_REQUEST) turn = { ...turn, echo: false };
    await prepareTurn(targetId, (label) => this.host.channel.send({ type: 'busy', ...(label ? { label } : {}) }));
    await this.host.prepareRoute();
    const client = await this.host.link.workerFor(targetId);
    this.host.channel.send({ type: 'turn-start', sessionId: targetId, ...(turn.echo ? { prompt } : {}), ...(turn.queuedTurnId ? { queuedTurnId: turn.queuedTurnId } : {}) });
    try {
      await new Promise<void>((resolve, reject) => {
        this.host.link.turnWaiter = { resolve, reject };
        client.send({ type: 'submit', text: prompt, echo: turn.echo, ...(turn.queuedTurnId ? { queuedTurnId: turn.queuedTurnId } : {}) });
      });
    } catch (error) {
      throw error instanceof TurnFailed ? error : new TurnFailed(messageOf(error));
    }
  }

  /** A line typed between turns: the terminal's routing (dispatchLine), with
   * the editor's widgets where the terminal draws its own. */
  async dispatch(line: string, fromQueuedCommand: boolean): Promise<InteractiveSlashOutcome> {
    const id = this.host.requireSession();
    // `!<command>`: run here, its output a transcript message for next turn.
    if (isShellCommandLine(line)) {
      return this.withBusy(line, () => this.host.quietly(async () => {
        // Quiet: its result payload repeats the transcript message the chat
        // already shows, and would be drawn a second time as an output card.
        const resulting = await aiSessionCommand(id, line);
        return resulting !== id ? { id: resulting } : {};
      }));
    }
    return dispatchLine(createSlashHost(this.host, this), id, line, { fromQueuedCommand });
  }

  async withBusy<T>(label: string, work: () => Promise<T>): Promise<T> {
    this.host.channel.send({ type: 'busy', label });
    try { return await work(); } finally { this.host.channel.send({ type: 'busy' }); }
  }
}
