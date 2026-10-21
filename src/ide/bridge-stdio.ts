/** `clikcode ide-bridge --stdio`: the bridge over stdin/stdout, for a client
 * that reaches this machine through a pipe -- ClikCode Remote's SSH
 * connection (src/remote/connection.ts) -- rather than by starting the
 * bridge itself with an IPC channel.
 *
 * The bridge proper keeps its IPC channel (protocol.ts says why: vendor CLIs
 * inherit its stdout, and one stray line must not corrupt the conversation).
 * This process only relays: it starts the ordinary `ide-bridge` as its child
 * with an IPC channel, and copies messages between that channel and its own
 * stdin/stdout as one JSON object per line. The child's stdout goes to this
 * process's stderr, so nothing but those lines ever reaches stdout.
 *
 * The other end closing stdin (the SSH connection dropped or was closed) is
 * the editor disconnecting: the child's channel is closed and it exits, as
 * a bridge does when its editor goes. No port is opened. */
import { fork } from 'node:child_process';
import { createInterface } from 'node:readline';

export async function runStdioBridge(): Promise<void> {
  const entry = process.argv[1];
  if (!entry) throw new Error('ide-bridge --stdio: no entry point to start the bridge from');
  const child = fork(entry, ['ide-bridge'], {
    stdio: ['ignore', 'pipe', 'inherit', 'ipc'],
    env: process.env,
    execArgv: process.execArgv,
  });
  child.stdout?.on('data', (chunk: Buffer) => process.stderr.write(chunk));
  child.on('message', (message) => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  });
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on('line', (line) => {
    if (!line.trim()) return;
    let message: unknown;
    try { message = JSON.parse(line); } catch { process.stderr.write(`ide-bridge --stdio: not JSON: ${line.slice(0, 200)}\n`); return; }
    if (child.connected) child.send(message as object);
  });
  const hangUp = (): void => { if (child.connected) child.disconnect(); };
  lines.on('close', hangUp);
  process.on('SIGTERM', hangUp);
  process.on('SIGHUP', hangUp);
  const code = await new Promise<number>((resolve) => child.once('exit', (exitCode) => resolve(exitCode ?? 0)));
  process.exit(code);
}
