/** The accounts service's sign-ins (`POST /v1/logins`): each one a vendor's
 * own login, run by the same code `clikcode accounts login` runs
 * (commands/account.ts aiAccountSignIn -> native/login.ts), on a sign-in
 * screen of the service's own instead of a terminal's.
 *
 * That screen (SignInScreen, gateway/login/vendor-sign-in.ts) is the seam
 * every surface already uses -- the CLI's band, the VS Code panel's card.
 * Here it is a state an HTTP caller polls: a link the vendor printed is
 * `awaiting-user` (open it, approve it), a question the vendor asks is
 * `awaiting-input` (answer it with POST .../input), and the end is
 * `connected` with the account it landed on, or `failed`/`timeout`.
 *
 * What is typed back is never kept beyond handing it to the vendor, never
 * logged, and scrubbed out of any error the vendor printed afterwards. */
import { randomUUID } from 'node:crypto';
import type { LoginLink, SignInScreen } from '../gateway/login/vendor-sign-in.js';
import { redactForLog } from '../runtime/redact.js';

export type LoginState = 'starting' | 'installing' | 'awaiting-user' | 'awaiting-input' | 'connected' | 'failed' | 'timeout';

/** GET /v1/logins/:id. */
export interface LoginView {
  loginId: string;
  provider: string;
  state: LoginState;
  verificationUrl?: string;
  userCode?: string;
  prompt?: string;
  /** Added: the question is one of these (answer with its number or its text). */
  choices?: string[];
  /** Added: the answer is a secret (a key): send it, it is never shown back. */
  secret?: boolean;
  /** Added: the vendor's own link is up and a key may be pasted instead of approving it. */
  acceptsInput?: boolean;
  accountId?: string;
  error?: string;
}

/** What a login needs from the machine: everything vendor-specific. The
 * service's real one is service/backend.ts; tests give a fake harness. */
export interface LoginDriver {
  /** The harness that signs in to `provider` (a provider id or a harness command), or undefined. */
  resolve(provider: string): { command: string; provider: string } | undefined;
  /** Whether its CLI must be installed first (a slow step, shown as `installing`). */
  needsInstall(command: string): Promise<boolean>;
  install(command: string): Promise<void>;
  /** Runs the vendor's login on `screen` to its end; the account it landed on. */
  signIn(command: string, options: { label?: string; accountId?: string }, screen: SignInScreen): Promise<{ id: string }>;
}

interface Pending {
  prompt: string;
  secret: boolean;
  alongside: boolean;
  choices?: readonly string[];
  answer: (value: string) => void;
}

/** How long a sign-in may wait on its person before it is stopped. */
export const LOGIN_TIMEOUT_MS = 15 * 60_000;
/** How long a finished sign-in is still answered for. */
const KEEP_FINISHED_MS = 60 * 60_000;

/** A method menu answered without asking: no browser callback reaches a
 * container, so a device or headless sign-in is the one that can finish
 * (native/login.ts preferredSignInMethod, the same order). */
const METHOD_MENU = /login method|sign.?in method|how would you like to (?:log|sign) ?in|authenticat(?:e|ion) method/i;
const DEVICE_CHOICE = /\b(?:headless|device|code)\b/i;

export class ServiceLogin {
  readonly loginId = randomUUID();
  private state: LoginState = 'starting';
  private link?: LoginLink;
  private readonly pending: Pending[] = [];
  private readonly given: string[] = [];
  private accountId?: string;
  private error?: string;
  private readonly controller = new AbortController();
  finishedAt?: number;
  private installing = false;
  private timer?: NodeJS.Timeout;

  constructor(readonly provider: string) {}

  get signal(): AbortSignal { return this.controller.signal; }

  view(): LoginView {
    const state = this.current();
    const question = this.question();
    const asking = state === 'awaiting-input' ? question : undefined;
    const beside = state === 'awaiting-user' ? this.pending.at(-1) : undefined;
    return {
      loginId: this.loginId, provider: this.provider, state,
      ...(this.link && !this.finishedAt ? { verificationUrl: this.link.url, ...(this.link.code ? { userCode: this.link.code } : {}) } : {}),
      ...(asking ? { prompt: describe(asking), ...(asking.choices ? { choices: [...asking.choices] } : {}), ...(asking.secret ? { secret: true } : {}) } : {}),
      ...(beside ? { prompt: describe(beside), acceptsInput: true } : {}),
      ...(this.accountId ? { accountId: this.accountId } : {}),
      ...(this.error ? { error: this.error } : {}),
    };
  }

  /** The question an answer goes to: the vendor's own first, else the key field beside its link. */
  private question(): Pending | undefined {
    return [...this.pending].reverse().find((item) => !item.alongside) ?? this.pending.at(-1);
  }

  private current(): LoginState {
    if (this.finishedAt) return this.state;
    if (this.pending.some((item) => !item.alongside)) return 'awaiting-input';
    if (this.link) return 'awaiting-user';
    if (this.pending.length) return 'awaiting-input';
    return this.installing ? 'installing' : 'starting';
  }

  /** The answer to the question the vendor is waiting on. Throws when it waits on none. */
  input(value: string): LoginView {
    if (this.finishedAt) throw new LoginError('login-finished', 'This sign-in has already ended.');
    const target = this.question();
    if (!target) throw new LoginError('not-awaiting-input', 'The sign-in is not waiting for anything to be typed.');
    this.pending.splice(this.pending.indexOf(target), 1);
    const text = String(value);
    if (text.trim()) this.given.push(text.trim());
    if (target.choices) {
      const at = choiceIndex(target.choices, text);
      if (at === undefined) {
        this.pending.push(target);
        throw new LoginError('invalid-choice', `Answer with one of: ${target.choices.map((choice, index) => `${index + 1}`).join(', ')}.`);
      }
      target.answer(String(at));
    } else target.answer(text);
    return this.view();
  }

  cancel(): void {
    if (this.finishedAt) return;
    this.finish('failed', { error: 'cancelled' });
  }

  /** Runs the login with `driver`; resolves when it has ended, however it ends. */
  async run(driver: LoginDriver, command: string, options: { label?: string; accountId?: string }, timeoutMs = LOGIN_TIMEOUT_MS): Promise<void> {
    this.timer = setTimeout(() => this.finish('timeout', { error: 'The sign-in was not finished in time.' }), timeoutMs);
    this.timer.unref?.();
    try {
      if (await driver.needsInstall(command)) {
        this.installing = true;
        await driver.install(command);
        this.installing = false;
      }
      if (this.signal.aborted) return;
      const account = await driver.signIn(command, options, this.screen());
      this.finish('connected', { accountId: account.id });
    } catch (error) {
      this.finish('failed', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private finish(state: 'connected' | 'failed' | 'timeout', outcome: { accountId?: string; error?: string }): void {
    if (this.finishedAt) return;
    clearTimeout(this.timer);
    this.state = state;
    this.finishedAt = Date.now();
    if (outcome.accountId) this.accountId = outcome.accountId;
    if (outcome.error) this.error = this.scrub(outcome.error);
    for (const item of this.pending.splice(0)) item.answer('');
    // Stops the vendor (runVendorSignIn listens on the screen's signal).
    if (state !== 'connected') this.controller.abort();
  }

  /** An error without anything that was typed into the sign-in, nor anything shaped like a credential. */
  private scrub(text: string): string {
    let out = text;
    for (const value of this.given) if (value.length >= 4) out = out.split(value).join('[hidden]');
    return redactForLog(out).slice(0, 1_000);
  }

  /** The sign-in screen the vendor's login draws on. */
  private screen(): SignInScreen {
    const ask = (prompt: string, secret: boolean, alongside: boolean, choices?: readonly string[]): Promise<string> => new Promise((resolve) => {
      if (this.finishedAt) { resolve(''); return; }
      // One question at a time from the vendor: a new one replaces the one
      // before it (its asker has moved on), as on every other screen.
      for (const item of this.pending.filter((other) => other.alongside === alongside)) {
        this.pending.splice(this.pending.indexOf(item), 1);
        item.answer('');
      }
      this.pending.push({ prompt, secret, alongside, ...(choices ? { choices } : {}), answer: resolve });
    });
    return {
      signal: this.signal,
      show: (link) => { this.link = link; },
      hide: () => { this.link = undefined; },
      ask: (prompt, secret, _optional, alongside) => ask(prompt, secret, Boolean(alongside)),
      choose: async (title, choices, selected) => {
        if (METHOD_MENU.test(title)) {
          const device = choices.findIndex((choice) => DEVICE_CHOICE.test(choice));
          if (device >= 0) return device;
        }
        if (choices.length === 1) return 0;
        const answer = await ask(title, false, false, choices);
        if (!answer) return selected === undefined || this.finishedAt ? undefined : selected;
        const at = Number(answer);
        return Number.isInteger(at) && at >= 0 && at < choices.length ? at : undefined;
      },
      stop: () => undefined,
      withdraw: () => this.cancel(),
    };
  }
}

export class LoginError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

/** A question as one line: a menu's options numbered after its title. */
function describe(item: Pending): string {
  if (!item.choices) return item.prompt;
  return `${item.prompt} -- ${item.choices.map((choice, index) => `${index + 1}) ${choice}`).join('  ')}`;
}

/** Which choice an answer names: its number (from 1) or its text. */
export function choiceIndex(choices: readonly string[], answer: string): number | undefined {
  const text = answer.trim();
  if (/^\d+$/.test(text)) {
    const at = Number(text) - 1;
    return at >= 0 && at < choices.length ? at : undefined;
  }
  const at = choices.findIndex((choice) => choice.trim().toLowerCase() === text.toLowerCase());
  return at >= 0 ? at : undefined;
}

/** Every sign-in this service is running or recently ran. */
export class LoginRegistry {
  private readonly logins = new Map<string, ServiceLogin>();

  constructor(private readonly driver: LoginDriver, private readonly timeoutMs = LOGIN_TIMEOUT_MS) {}

  start(input: { provider: string; label?: string; accountId?: string }): ServiceLogin {
    this.prune();
    const harness = this.driver.resolve(input.provider);
    if (!harness) throw new LoginError('unknown-provider', `ClikCode cannot sign in to "${input.provider}".`);
    const login = new ServiceLogin(input.provider);
    this.logins.set(login.loginId, login);
    void login.run(this.driver, harness.command, {
      ...(input.label?.trim() ? { label: input.label.trim() } : {}),
      ...(input.accountId ? { accountId: input.accountId } : {}),
    }, this.timeoutMs);
    return login;
  }

  get(loginId: string): ServiceLogin | undefined {
    this.prune();
    return this.logins.get(loginId);
  }

  cancel(loginId: string): boolean {
    const login = this.logins.get(loginId);
    if (!login) return false;
    login.cancel();
    return true;
  }

  /** Stops every sign-in still running (the service is stopping). */
  cancelAll(): void {
    for (const login of this.logins.values()) login.cancel();
  }

  private prune(now = Date.now()): void {
    for (const [id, login] of this.logins) if (login.finishedAt && now - login.finishedAt > KEEP_FINISHED_MS) this.logins.delete(id);
  }
}
