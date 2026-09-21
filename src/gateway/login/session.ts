/**
 * Adding the link handling a vendor sign-in does not do.
 *
 * The vendor owns the terminal for its own sign-in, exactly as it always has.
 * ClikCode only watches the output: on the first sign-in URL it copies the
 * link to the terminal's clipboard (OSC 52, which reaches the phone rather
 * than the server), opens a browser where one is any use, and prints a short
 * line saying so. The code is still pasted into the vendor's own prompt.
 */
import { extractLoginUrl, hasLocalDisplay, loginUrlNotice, openLoginUrl } from './url.js';
import { runTeedLogin, type TeedLoginResult } from './tee.js';

export interface LoginSessionIo {
  write: (text: string) => void;
  environment?: NodeJS.ProcessEnv;
  open?: (url: string) => void;
}

/** Run a vendor login, adding the link handling the vendor does not do.
 *
 * ClikCode watches the output and, on the first sign-in URL, copies it to the
 * terminal's clipboard, opens a browser where one is any use, and prints a
 * short line saying so. The vendor keeps the terminal: its own prompt is what
 * the code gets pasted into.
 *
 * An earlier version painted a full panel over the vendor and drove its stdin
 * through a pipe. That broke "+ Add account" outright -- the picker suspends
 * the UI and releases the terminal precisely so the vendor can own it, and
 * taking stdin back (raw mode on, input re-piped) left logins that never
 * appeared. A login that does not open is worse than one that is not pretty,
 * so the terminal stays the vendor's.
 */
export async function runLoginSession(input: {
  binary: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  displayName: string;
  io: LoginSessionIo;
}): Promise<TeedLoginResult> {
  const { io } = input;
  const environment = io.environment ?? process.env;
  let raw = '';
  let announced = false;

  return runTeedLogin({
    binary: input.binary,
    args: input.args,
    env: input.env,
    // stdin is deliberately NOT taken: it stays inherited, so the vendor reads
    // the real terminal exactly as it did before any of this existed.
    write: (chunk) => io.write(chunk),
    onOutput: (chunk) => {
      raw += chunk;
      if (announced) return;
      const url = extractLoginUrl(raw);
      if (!url) return;
      announced = true;
      const notice = loginUrlNotice(url, environment);
      if (hasLocalDisplay(environment)) (io.open ?? openLoginUrl)(url);
      io.write(`\n${notice.clipboard}${notice.lines.join('\n')}\n\n`);
    },
  });
}
