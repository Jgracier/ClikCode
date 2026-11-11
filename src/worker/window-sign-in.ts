/** A sign-in the worker asked a window to run (`sign-in-request`), the same
 * in every kind of window -- a terminal's turn view, the editor's panel
 * (local, or on a remote machine): run once however often it is asked, on
 * the window's own sign-in screen, and answered unless taken down.
 *
 * Taken down (`withdraw`) when the request closes elsewhere (answered in
 * another window, the turn ended) or the window stops showing the
 * conversation: the vendor's login is stopped and nothing is answered --
 * the worker still waits, for a window showing the conversation. */
import { signInOutcomeSaid, withSignIn } from '../commands/account.js';
import type { SignInScreen } from '../gateway/login/vendor-sign-in.js';
import type { HarnessPrompter } from '../harness/prompter.js';
import { loginNativeHarness } from '../harness/transport/native/login.js';
import { localHarnessForCommand } from '../runtime/lazy-bridge.js';
import type { ClientCommand, WorkerEvent } from './protocol.js';

type Request = Extract<WorkerEvent, { type: 'sign-in-request' }>;
type Response = Extract<ClientCommand, { type: 'sign-in-response' }>;
type Shown = Pick<HarnessPrompter, 'signInScreen' | 'activity'>;

export class WindowSignIns {
  /** Each running here, by request id: its withdraw. */
  private readonly open = new Map<string, () => void>();

  constructor(
    private readonly answer: (response: Response) => void,
    private readonly login: typeof loginNativeHarness = loginNativeHarness,
  ) {}

  /** Runs the request on `prompter`'s sign-in screen, unless it already
   * runs here. `around` wraps the whole sign-in (the editor's queue hold). */
  run(event: Request, prompter: Shown, around: <T>(work: () => Promise<T>) => Promise<T> = (work) => work()): void {
    if (this.open.has(event.id)) return;
    let withdrawn = false;
    let screen: SignInScreen | undefined;
    const withdraw = (): void => {
      withdrawn = true;
      if (this.open.get(event.id) === withdraw) this.open.delete(event.id);
      screen?.withdraw?.();
    };
    this.open.set(event.id, withdraw);
    const open = prompter.signInScreen?.bind(prompter);
    const shown: Shown = {
      activity: (message) => prompter.activity?.(message),
      ...(open ? {
        signInScreen: (name: string) => {
          screen = open(name);
          if (withdrawn) screen.withdraw?.();
          return screen;
        },
      } : {}),
    };
    void around(() => withSignIn(shown, event.name, async () => {
      const harness = localHarnessForCommand(event.command);
      if (!harness) throw new Error(`unknown harness ${event.command}`);
      await this.login({ ...harness, loginArgv: event.argv }, event.environment);
    })).then(
      () => { if (!withdrawn) this.answer({ type: 'sign-in-response', id: event.id }); },
      (error: unknown) => {
        if (withdrawn) return;
        this.answer({
          type: 'sign-in-response', id: event.id,
          error: error instanceof Error ? error.message : String(error),
          outcome: signInOutcomeSaid(error) === 'cancelled' ? 'cancelled' : 'failed',
        });
      },
    ).finally(() => { if (this.open.get(event.id) === withdraw) this.open.delete(event.id); });
  }

  /** Takes one down: the request closed elsewhere. */
  withdraw(id: string): void {
    this.open.get(id)?.();
  }

  /** Takes every one down -- the window left the conversation -- and
   * returns their ids, to give back to the worker (`sign-in-release`). */
  withdrawAll(): string[] {
    const ids = [...this.open.keys()];
    for (const withdraw of [...this.open.values()]) withdraw();
    return ids;
  }
}
