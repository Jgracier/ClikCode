/** The sign-in screen a vendor login draws into the waiting band: link, code and key prompts. */
import chalk from 'chalk';
import { lifecycle } from '../../runtime/lifecycle-log.js';
import type { LoginLink, SignInScreen } from '../../gateway/login/vendor-sign-in.js';
import { hasLocalDisplay, loginUrlNotice, openLoginUrl } from '../../gateway/login/url.js';
import { loginPortForwardHint } from '../../gateway/login/link-info.js';
import { stdout as output } from 'node:process';
import type { TerminalHarnessPrompter } from '../prompter.js';

/** A vendor sign-in on screen (commands/account.ts withSignIn): its link
 * and code above the waiting band, a code or key typed into the waiting
 * composer, a choice in the picker, Esc cancelling it. Inside a running
 * turn (a sign-in the turn asked for) it borrows the turn's band and Esc
 * rather than starting a wait, which would reset the turn; stop() gives
 * them back. */
export function signInScreen(this: TerminalHarnessPrompter, name: string): SignInScreen {
  lifecycle('window.signin.start', { name });
  const controller = new AbortController();
  const label = `waiting for you to sign in to ${name}`;
  const cancel = (): void => controller.abort();
  const local = hasLocalDisplay();
  let opened = false;
  // The band: the link's lines, then the key offered beside it (alongside).
  let linkLines: string[] = [];
  let hint: string | undefined;
  const band = (): void => {
    this.signInLines = [...linkLines, ...(hint ? [hint] : [])];
    this.updateWaiting();
  };
  const show = (link: LoginLink): void => {
    if (local && !opened) { opened = true; openLoginUrl(link.url); }
    if (!local) output.write(loginUrlNotice(link.url).clipboard);
    linkLines = [
      `${chalk.bold(`Sign in to ${name}`)}${link.code ? ` · confirm the code ${chalk.bold(link.code)}` : ''}`,
      link.url,
      ...(loginPortForwardHint(link.url) ? [chalk.dim(loginPortForwardHint(link.url)!)] : []),
      chalk.dim(local ? 'opened in your browser' : 'full link copied to clipboard'),
    ];
    band();
  };
  // A code or key typed under the link: the waiting composer takes it, and
  // the band says what it is for.
  // What was typed before the sign-in asked: set aside for the code, and
  // put back once it is answered (or the sign-in ends unanswered). The
  // code itself is the sign-in's and never joins it.
  let aside: { draft: string; cursor: number } | undefined;
  const putBack = (): void => {
    const live = this.turn;
    if (live && aside) { live.draft = aside.draft; live.cursor = aside.cursor; }
    aside = undefined;
  };
  // Beside the vendor's sign-in (alongside): a line under its link, and
  // the composer left as it is -- the wait's label still says what it waits on.
  const ask = (prompt: string, secret: boolean, optional?: boolean, alongside?: boolean): Promise<string> => new Promise((resolve) => {
    const live = this.turn;
    hint = alongside ? chalk.dim(`${prompt} · paste it and press Enter`) : undefined;
    if (live && !alongside) {
      aside ??= { draft: live.draft, cursor: live.cursor };
      live.draft = ''; live.cursor = 0; live.label = `${prompt} · type it and press Enter`;
    }
    this.signInInput = {
      secret, optional, alongside,
      submit: (text) => {
        this.signInInput = undefined;
        hint = undefined;
        putBack();
        if (this.turn) this.turn.label = label;
        band();
        resolve(text);
      },
    };
    band();
  });
  const turn = this.turn;
  const saved = turn ? { label: turn.label, cancel: turn.cancel, cancelled: turn.cancelled } : undefined;
  // A choice is the picker. Outside a turn the wait is this sign-in's own,
  // so it steps aside for the picker and comes back after.
  const choose = async (title: string, choices: readonly string[]): Promise<number | undefined> => {
    if (!turn) this.stopWaiting(false);
    try {
      return await this.select(title, choices.map((choice, index) => ({ label: choice, value: index })));
    } finally {
      if (!turn && !controller.signal.aborted) { this.startWaiting(label, cancel); this.pauseClock(); }
    }
  };
  this.signingIn = true;
  if (turn) {
    turn.label = label;
    turn.cancel = cancel;
    turn.cancelled = false;
    this.pauseClock();
    this.scheduleWaitingTick();
    this.updateWaiting();
  } else { this.startWaiting(label, cancel); this.pauseClock(); }
  return {
    signal: controller.signal, show, ask, choose,
    stop: () => {
      this.signInLines = [];
      // An unanswered code is dropped; what was typed for the conversation
      // stays in the composer -- the turn's, or (outside one) the prompt's
      // that opens next, by stopWaiting.
      if (this.signInInput && !this.signInInput.alongside && this.turn) { this.turn.draft = ''; this.turn.cursor = 0; }
      this.signInInput = undefined;
      putBack();
      this.signingIn = false;
      // Not repainted here: the outcome line withSignIn writes next paints,
      // and a paint between them drew the composer empty for a frame
      // while a message sent under the sign-in waited for its turn.
      // The message whose first use opened it is still on its way: its
      // prompt stays drawn into the turn that starts next.
      if (!turn) {
        this.signedInJustNow = true;
        const prompt = this.submittedPrompt;
        if (this.turn) this.stopWaiting(false);
        this.submittedPrompt = prompt;
        return;
      }
      if (this.turn !== turn) { this.schedulePaint(); return; }
      // The user's time in the browser is not the turn's, nor its going quiet.
      this.resumeClock();
      turn.label = saved!.label;
      turn.cancel = saved!.cancel;
      turn.cancelled = saved!.cancelled;
      this.scheduleWaitingTick();
      this.updateWaiting();
    },
  };
}
