/**
 * Driving a vendor sign-in behind ClikCode's own screen.
 *
 * Until a sign-in URL appears, the vendor's output passes straight through --
 * whatever it is doing, the user should see it. Once the URL appears there is
 * nothing further worth reading, so ClikCode takes the terminal: it copies the
 * link, opens a browser where one exists, and paints a panel with the short
 * link and one field. What the user types there is written to the vendor's
 * own stdin, so the vendor's prompt is answered without the user ever having
 * to find it.
 *
 * The raw output is kept, never discarded: Ctrl-O reveals it and hands the
 * terminal back, and a login that exits non-zero prints its tail on the way
 * out. Hiding output is only safe while nothing has gone wrong.
 */
import { LoginField, renderLoginScreen, type LoginScreenState } from './login-screen.js';
import { extractLoginUrl, hasLocalDisplay, openLoginUrl, shortenLoginUrl } from './login-url.js';
import { osc52Sequence } from './session-attachments.js';
import { runTeedLogin, type TeedLoginResult } from './login-tee.js';

/** Enough of the tail to explain a failure without replaying an entire TUI. */
const FAILURE_TAIL_LINES = 40;

export interface LoginSessionIo {
  write: (text: string) => void;
  /** The terminal's key stream. Undefined where there is no terminal, which
   * disables the panel entirely. */
  input?: NodeJS.ReadStream;
  environment?: NodeJS.ProcessEnv;
  open?: (url: string) => void;
}

/** The pty echoes back everything written to it, so anything the user pasted
 * is sitting in the captured output. Revealing that output -- on Ctrl-O or on
 * a failure -- must not put a live API key into the scrollback. */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let redacted = text;
  for (const secret of secrets) {
    if (secret.length < 4) continue; // too short to find without matching prose
    redacted = redacted.split(secret).join('«redacted»');
  }
  return redacted;
}

export function failureTail(raw: string, secrets: readonly string[] = []): string {
  const lines = redactSecrets(raw, secrets).split(/\r?\n/).filter((line) => line.trim());
  return lines.slice(-FAILURE_TAIL_LINES).join('\n');
}

/** Run a vendor login with ClikCode's panel in front of it. */
export async function runLoginSession(input: {
  binary: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  displayName: string;
  io: LoginSessionIo;
}): Promise<TeedLoginResult> {
  const { io } = input;
  const environment = io.environment ?? process.env;
  const terminal = io.input;
  const interactive = Boolean(terminal?.isTTY);

  let raw = '';
  let panel: LoginScreenState | undefined;
  let revealed = false;
  const field = new LoginField();
  let toVendor: ((text: string) => void) | undefined;
  /** Everything the user submitted, so it can be kept out of any reveal. */
  const submitted: string[] = [];
  let detachInput = (): void => {};

  const paint = (): void => {
    if (!panel) return;
    io.write(`\u001b[2J\u001b[H${renderLoginScreen(panel).join('\r\n')}\r\n`);
  };

  const reveal = (): void => {
    if (!panel) return;
    panel = undefined;
    revealed = true;
    detachInput();
    io.write(`\u001b[2J\u001b[H${redactSecrets(raw, submitted)}`);
  };

  const result = await runTeedLogin({
    binary: input.binary,
    args: input.args,
    env: input.env,
    // Only take the vendor's stdin when there is a terminal to take it from;
    // otherwise it keeps the terminal itself, exactly as before.
    ...(interactive ? {
      onStdin: (write) => {
        toVendor = write;
        const onKey = (chunk: Buffer | string): void => {
          if (!panel) { toVendor?.(chunk.toString()); return; }
          const event = field.push(chunk.toString());
          if (event.kind === 'submit') {
            if (event.value) submitted.push(event.value);
            toVendor?.(`${event.value}\n`);
            panel = { ...panel, field: '', note: event.value ? 'Sent — waiting for the vendor…' : undefined };
            paint();
          } else if (event.kind === 'cancel') {
            toVendor?.('\u0003');
          } else if (event.kind === 'reveal') {
            reveal();
          } else if (event.kind === 'update') {
            panel = { ...panel, field: field.contents };
            paint();
          }
        };
        terminal!.on('data', onKey);
        if (terminal!.isTTY) terminal!.setRawMode(true);
        terminal!.resume();
        // Bracketed paste: a phone pasting a long key sends it as one burst,
        // and the markers must be recognised rather than typed into the field.
        io.write('\u001b[?2004h');
        detachInput = () => {
          terminal!.off('data', onKey);
          io.write('\u001b[?2004l');
          if (terminal!.isTTY) terminal!.setRawMode(false);
          terminal!.pause();
        };
      },
    } : {}),
    write: (chunk) => {
      // While the panel is up the vendor's output is behind it -- including
      // the pty's own echo of the credential just written to it.
      if (!panel) io.write(chunk);
    },
    onOutput: (chunk) => {
      raw += chunk;
      if (panel || revealed || !interactive) return;
      const url = extractLoginUrl(raw);
      if (!url) return;
      const local = hasLocalDisplay(environment);
      io.write(osc52Sequence(url, environment));
      if (local) (io.open ?? openLoginUrl)(url);
      panel = {
        displayName: input.displayName, shortUrl: shortenLoginUrl(url),
        opened: local, copied: true, field: '',
      };
      paint();
    },
  });

  if (panel) {
    panel = { ...panel, finished: result.exitCode === 0 ? 'ok' : 'failed' };
    paint();
  }
  detachInput();
  if (panel && result.exitCode !== 0 && result.exitCode !== null) io.write(`\n${failureTail(raw, submitted)}\n`);
  return result;
}
