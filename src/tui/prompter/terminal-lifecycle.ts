/** Taking the terminal, handing it over and giving it back: the screen, title and signal re-takes, Ctrl+Z, suspend/resume and close. */
import { lifecycle } from '../../runtime/lifecycle-log.js';
import { stdin as input, stdout as output } from 'node:process';
import { enterAlternateScreen, giveBackTerminal, pushShellTitle, restoreTerminal, terminalModes } from '../restore.js';
import { notifySequence, progressSequence, shouldNotify, titleSequence, windowTitle } from '../terminal-signals.js';
import { KEEP_STDIN_FLOWING } from '../input-decoder.js';
import { popReadModes, sessionModesOff, sessionModesOn, setTerminalRawMode } from '../modes.js';
import type { TerminalHarnessPrompter } from '../prompter.js';

/** The screen back from whoever had it (the shell after Ctrl+Z, a vendor
 * login): the alternate screen, the transcript rewrapped if they resized
 * it -- a phone's keyboard does -- and the next frame drawn whole. */
export function retakeScreen(this: TerminalHarnessPrompter): void {
  setTerminalRawMode(true);
  this.suspended = false;
  enterAlternateScreen();
  this.rewrapIfWidthChanged();
  this.forgetScreenPosition();
  this.retakeTerminalSignals();
}

/** Back from a hand-over (a `!` command, a picker that left the screen,
 * Ctrl+Z): every session mode on again, the title taken, and the next
 * frame drawn as after a resize -- the screen may well have changed size,
 * and was certainly drawn on by something else. */
export function retakeTerminalSignals(this: TerminalHarnessPrompter): void {
  if (!output.isTTY) return;
  output.write(sessionModesOn());
  this.takeTerminalTitle();
  this.requestRedraw('resize');
}

/** Save the shell's title, once per taking of the terminal. */
export function takeTerminalTitle(this: TerminalHarnessPrompter): void {
  if (pushShellTitle()) this.terminalTitle = undefined;
}

/** The window title and the tab's progress indicator, kept in step with
 * the turn: whether it is working or waiting for the user, and the
 * conversation's name. Only what changed, for the next frame to carry
 * (pendingSignals), and never off a TTY. The title holds still while a turn
 * runs -- the progress indicator is what moves -- so a spinner tick writes
 * nothing here. */
export function terminalSignals(this: TerminalHarnessPrompter): string {
  if (!output.isTTY || this.suspended || this.closed || !terminalModes.titlePushed) return '';
  const running = Boolean(this.turn);
  const title = windowTitle({
    running, asking: Boolean(this.pendingApproval),
    ...(this.currentSession?.name ? { name: this.currentSession.name } : {}),
  });
  let sequence = '';
  if (title !== this.terminalTitle) { sequence += titleSequence(title); this.terminalTitle = title; }
  if (running !== terminalModes.progress) { sequence += progressSequence(running); terminalModes.progress = running; }
  return sequence;
}

/** Something needs the user -- a turn ended, an approval waits -- and the
 * terminal said it lost focus long enough ago: tell them (OSC 9 and a
 * bell). A terminal that never reports focus is never notified. */
export function notifyIfAway(this: TerminalHarnessPrompter, message: string): void {
  if (!output.isTTY || this.suspended || this.closed || !shouldNotify(this.focus, Date.now())) return;
  output.write(notifySequence(message));
}

/** Ctrl+Z. Raw mode swallows the terminal's own job control, so do what it
 * would have done: give the terminal back exactly as close() would, stop
 * this process, and rebuild the live region below whatever the shell printed
 * once `fg` continues it. */
export function suspendToShell(this: TerminalHarnessPrompter): void {
  if (this.suspended || this.closed) return;
  this.suspended = true;
  if (this.responsePaintTimer) clearTimeout(this.responsePaintTimer);
  this.responsePaintTimer = undefined;
  this.pendingLive = undefined;
  setTerminalRawMode(false);
  // Whoever takes the terminal takes the main screen with it: a vendor
  // login prompt drawn on our alternate screen would vanish with it.
  output.write(sessionModesOff(true));
  terminalModes.alternateScreen = false;
  process.once('SIGCONT', this.onContinue);
  process.kill(process.pid, 'SIGTSTP');
}

export function onContinue(this: TerminalHarnessPrompter): void {
  if (this.closed) return;
  this.retakeScreen();
  this.resumeInput?.();
  if (this.turn) this.paint(this.turn.draft, [], 0, '› ', this.turn.cursor);
  else this.repaint();
}

export function close(this: TerminalHarnessPrompter): void {
  if (this.closed) return;
  lifecycle('window.close');
  this.closed = true;
  this.pendingLive = undefined;
  if (this.responsePaintTimer) clearTimeout(this.responsePaintTimer);
  this.responsePaintTimer = undefined;
  this.stopWaiting(false);
  this.clearTransientNotice();
  if (this.resizePaintTimer) clearTimeout(this.resizePaintTimer);
  this.resizePaintTimer = undefined;
  this.stopScrollBatch?.();
  this.stopScrollBatch = undefined;
  this.stopDrainBatch?.();
  this.stopDrainBatch = undefined;
  if (this.scrollDrainTimer) clearTimeout(this.scrollDrainTimer);
  this.scrollDrainTimer = undefined;
  this.pendingScroll = 0;

  input.off('data', KEEP_STDIN_FLOWING);
  this.stopFocusReports?.();
  process.off('SIGWINCH', this.onResize);
  process.off('SIGCONT', this.onContinue);
  process.off('exit', restoreTerminal);
  setTerminalRawMode(false);
  input.pause();
  // The alternate screen is handed back and the shell's own screen returns
  // untouched. The conversation is on disk -- `/resume` reopens it.
  giveBackTerminal(popReadModes());
}

/** Hands the real terminal to a vendor CLI's own interactive flow (typically
 * login) without tearing the session down, so ClikCode's UI can resume in
 * place once that process exits. */
export async function suspend(this: TerminalHarnessPrompter): Promise<void> {
  lifecycle('window.suspend');
  this.suspended = true;
  this.pendingLive = undefined;
  this.forgetScreenPosition();
  if (this.responsePaintTimer) clearTimeout(this.responsePaintTimer);
  this.responsePaintTimer = undefined;
  setTerminalRawMode(false);
  input.pause();
  // Remove the composer and footer before handing over, so the vendor's
  // output continues directly under the conversation instead of being typed
  // across this UI's status rows. Handed over once the modes are written --
  // where a TTY write is asynchronous (Windows) the child must not start
  // ahead of them -- rather than after a guessed 50ms.
  await new Promise<void>((resolveWritten) => { output.write(sessionModesOff(false), () => resolveWritten()); });
}

export function resume(this: TerminalHarnessPrompter): void {
  if (this.closed) return;
  lifecycle('window.resume');
  this.retakeScreen();
  if (input.isTTY) input.resume();
  this.repaint({ keepPalette: false });
}
