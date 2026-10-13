/** What the bridge offers the parts it is split into: the conversation it has
 * open, and the few operations that move or redraw it. */
import type Conf from 'conf';
import type { HarnessSession } from '../session/model.js';
import type { IdePrompter, IdeChannel } from './prompter.js';
import type { IdeFeature, IdeRequest, IdeTerminalSpec } from './protocol.js';
import type { InteractiveSlashOutcome } from '../tui/slash/interactive-keys.js';
import type { WorkerLink } from './bridge-worker.js';

export interface BridgeHost {
  readonly config: Conf;
  readonly channel: IdeChannel;
  readonly prompter: IdePrompter;
  readonly sessionId: string | undefined;
  readonly closed: boolean;
  /** The editor shows this chat (its `visible`): only then is usage polled. */
  readonly shown: boolean;
  /** What the editor said it handles, with its last `open`. */
  readonly features: ReadonlySet<IdeFeature>;
  readonly link: WorkerLink;
  /** Runs `job` with its confirmation output held back: a choice made in the
   * editor's own widgets is on screen there already. Errors still are said. */
  quietly<T>(job: () => Promise<T>): Promise<T>;
  requireSession(): string;
  current(id?: string): Promise<{ session: HarnessSession; account?: string }>;
  emitSession(): Promise<void>;
  /** One job at a time, in order. */
  enqueue(job: () => Promise<void>): void;
  report(error: unknown): void;
  switchTo(id: string): Promise<void>;
  prepareRoute(): Promise<void>;
  refreshUsage(): Promise<void>;
  scheduleDrain(): void;
  /** The open conversation was closed (`/exit`): the worker is let go and none is open. */
  closeConversation(): void;
  /** The turn-running steps, reached through the bridge so each can be replaced. */
  drainQueue(): Promise<void>;
  execute(line: string, options: { queuedTurnId?: string; fromQueuedCommand?: boolean }): Promise<void>;
  runTurn(targetId: string, prompt: string, turn: { echo: boolean; queuedTurnId?: string }): Promise<void>;
  dispatch(line: string, fromQueuedCommand: boolean): Promise<InteractiveSlashOutcome>;
  runInTerminal(spec: IdeTerminalSpec, request: { environment: Readonly<Record<string, string>>; name: string }): Promise<void>;
  /** /search waiting on the editor's next key. */
  setSearchKey(answer: ((key: Extract<IdeRequest, { type: 'search-key' }>['key']) => void) | undefined): void;
}
