/**
 * The interactive session: one terminal, one conversation, until you leave.
 *
 * Everything here exists because a human is watching. It owns the prompter's
 * lifetime, the claim that stops two terminals from driving one conversation,
 * the routing of each typed line to either a turn or a slash handler, and the
 * unwinding of all of that on exit -- including exits it did not choose, like
 * a mobile SSH connection dropping mid-turn.
 */
import { lifecycle, setLifecycleRole } from '../../runtime/lifecycle-log.js';
import Conf from 'conf';
import { adoptHandedOverDraft } from '../../session/ephemeral.js';
import { openConversation } from '../../session/attach.js';
import { openWindow } from './interactive/window.js';
import { ChatLoop } from './interactive/loop.js';

// An ANSI terminal runs every turn through a session worker. A terminal with
// no alternate screen (`terminal` undefined below: CI consoles, IDE output
// panes, Emacs shells, screen-reader mode -- see capabilities.ts) runs its
// turn in process: a worker has no screen to hand back to it. That path is
// why claim.ts stays, recording which process holds a conversation.
// claims.ts is unrelated -- it is the file lock on index.json.
//
// SIGINT remains ignored around client-side identity derivation and vendor
// login, which the worker design keeps in the client. SIGHUP is different:
// the terminal restore handler tears down the UI and exits the client, while
// its detached worker can finish an in-flight turn and serve a reconnect.

export async function aiSessionOpenDefault(config: Conf, options: { continue?: boolean } = {}): Promise<void> {
  await aiSessionInteractive(config, await openConversation(process.cwd(), options.continue ? 'continue' : 'new'));
}

export async function aiSessionResume(config: Conf, ref: string): Promise<void> {
  // A window a newer build replaced, on a draft: the draft comes with it.
  adoptHandedOverDraft();
  await aiSessionInteractive(config, await openConversation(process.cwd(), 'resume', ref));
}

async function aiSessionInteractive(config: Conf, id: string): Promise<void> {
  // Fetched while the app starts, so Copilot's model list is there the first
  // time the picker opens rather than racing the picker's short wait.
  void import('../../harness/accounts/goose-discovery.js').then(({ modelsDevCache }) => modelsDevCache()).catch(() => undefined);
  // SIGINT is ignored for a related but distinct reason: run()'s own Ctrl+C
  // forwarding to a login/turn subprocess is removed the INSTANT that
  // subprocess exits -- but the terminal stays in cooked mode (raw mode
  // off, from suspend()) for everything that happens after, including this
  // codebase's own identity-derivation retry loop, which can legitimately
  // run for several seconds with nothing visibly changing on screen. A
  // Ctrl+C landing in that specific gap -- a completely natural thing to do
  // when the screen looks idle right after pasting an auth code --
  // previously had no handler registered at all, so Node's default SIGINT
  // action (immediate termination) applied, killing the process mid-save.
  // While raw mode IS active (the normal composer state), Ctrl+C is read
  // as data (byte 0x03) handled entirely inside this UI, never reaching
  // the OS as a real signal at all -- so ignoring the signal here changes
  // nothing about that existing, working "cancel the current turn"
  // behavior; it only closes the gap where raw mode is temporarily off and
  // nothing else is watching. /exit and /quit remain the ways to leave.
  const ignoreInterrupt = (): void => {};
  process.on('SIGINT', ignoreInterrupt);
  setLifecycleRole('window', id);
  lifecycle('window.open', { cols: process.stdout.columns, rows: process.stdout.rows, tty: Boolean(process.stdin.isTTY) });
  try {
    await aiSessionInteractiveInner(config, id);
    lifecycle('window.exit', { how: 'left' });
  } catch (error) {
    lifecycle('window.exit', { how: 'error', message: error instanceof Error ? error.message.slice(0, 300) : String(error) });
    throw error;
  } finally {
    process.off('SIGINT', ignoreInterrupt);
  }
}

async function aiSessionInteractiveInner(config: Conf, id: string): Promise<void> {
  const window = await openWindow(config, id);
  if (!window) return;
  await new ChatLoop(window).run();
}
