/** Runs one command and collects its output. The caller decides what may be said about it. */
import { spawn } from 'node:child_process';

type CliResult = { code: number | null; text: string; missing: boolean };

export function runCli(command: string, argv: string[], options: { stdin?: string; signal?: AbortSignal; timeoutMs?: number; maxChars?: number } = {}): Promise<CliResult> {
  return new Promise(resolve => {
    const child = spawn(command, argv, { stdio: [options.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], windowsHide: true });
    let text = '';
    const keep = options.maxChars ?? 200_000;
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 90_000);
    const stop = (): void => { child.kill(); };
    options.signal?.addEventListener('abort', stop, { once: true });
    child.stdout!.on('data', chunk => { text = (text + String(chunk)).slice(-keep); });
    child.stderr!.on('data', chunk => { text = (text + String(chunk)).slice(-keep); });
    if (options.stdin !== undefined) { child.stdin!.on('error', () => undefined); child.stdin!.end(options.stdin); }
    child.once('error', error => { clearTimeout(timer); resolve({ code: null, text: '', missing: (error as NodeJS.ErrnoException).code === 'ENOENT' }); });
    child.once('close', code => { clearTimeout(timer); options.signal?.removeEventListener('abort', stop); resolve({ code, text, missing: false }); });
  });
}
