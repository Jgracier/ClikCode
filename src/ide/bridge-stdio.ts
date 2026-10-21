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
 * a bridge does when its editor goes. No port is opened. A bridge that
 * leaves for a newer build (bridge-retire.ts) ends this relay with it: the
 * client connects again, which starts the new build's relay and bridge. */
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
  // Its last messages (a retiring bridge's `host-retiring`) can still be in
  // the channel at its exit: they are relayed once the channel has closed.
  // Not 'close': that waits on the child's stdout, which anything it started
  // may still hold.
  if (child.connected) await new Promise<void>((resolve) => { child.once('disconnect', resolve); setTimeout(resolve, 1_000).unref(); });
  // A pipe's writes are asynchronous: the child's last message (a retiring
  // bridge's `host-retiring`) must reach the other end before this exits.
  process.stdout.write('', () => process.exit(code));
}
