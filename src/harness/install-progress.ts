/**
 * Installing a vendor CLI without putting npm's progress on the screen.
 *
 * `npm install --global` inherited the terminal, so choosing a provider that
 * was not installed yet dumped npm's whole log -- progress bars, deprecation
 * warnings, funding notices, an audit summary -- into the middle of the UI.
 * None of it is the user's decision to make, and on a phone it is several
 * screens of it.
 *
 * The output is captured instead: one animated line while it runs, one line
 * when it finishes. A failure is the exception -- then the tail is printed,
 * because an install that did not work is exactly when the log matters.
 */
import { spawnPortable as spawn } from './transport/spawn.js';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const FRAME_MS = 80;
/** Enough of npm's log to explain a failure, not enough to be another dump. */
const FAILURE_TAIL_LINES = 12;

export function installFailureTail(output: string, limit = FAILURE_TAIL_LINES): string {
  const lines = output.split(/\r?\n/)
    // npm's funding/audit footer says nothing about why an install failed.
    .filter((line) => line.trim() && !/^\s*(?:npm (?:notice|fund|warn deprecated)|\d+ packages are looking for funding|run `npm fund`)/i.test(line));
  return lines.slice(-limit).join('\n');
}

export interface Spinner { stop: (finalLine?: string) => void }

/** One self-clearing line. Silent where stdout is not a terminal, so piped
 * and CI output stays clean rather than filling with frames. */
export function startSpinner(label: string, write: (text: string) => void = (text) => process.stdout.write(text), isTty = process.stdout.isTTY): Spinner {
  if (!isTty) {
    write(`${label}\n`);
    return { stop: (finalLine) => { if (finalLine) write(`${finalLine}\n`); } };
  }
  let frame = 0;
  const paint = (): void => {
    write(`\r\u001b[2K\u001b[2m${FRAMES[frame % FRAMES.length]}\u001b[0m ${label}`);
    frame += 1;
  };
  paint();
  const timer = setInterval(paint, FRAME_MS);
  timer.unref?.();
  return {
    stop: (finalLine) => {
      clearInterval(timer);
      write(`\r\u001b[2K${finalLine ? `${finalLine}\n` : ''}`);
    },
  };
}

export interface CapturedRun { code: number | null; output: string }

/** Run a command with its output captured rather than inherited. */
export function runCaptured(command: string, args: readonly string[]): Promise<CapturedRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const collect = (chunk: Buffer): void => { output += chunk.toString(); };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
  });
}
