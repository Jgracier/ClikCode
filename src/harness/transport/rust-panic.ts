/** What a Rust panic report on stderr says went wrong ("The application
 * panicked (crashed). Message: ..."), once its message line is complete;
 * undefined for none. Colours are stripped.
 *
 * A Rust agent that panics can keep its process alive with nothing left to
 * answer (kiro-cli 2.23.1: "first agent loop request should never fail"), and
 * a turn waited on it until the idle ceiling. The ACP transport hands this to
 * its peer as the crash report (jsonrpc-peer.ts `crashReport`). */
export function panicMessage(stderr: string): string | undefined {
  // eslint-disable-next-line no-control-regex
  const plain = stderr.replace(/\u001b\[[0-9;]*m/g, '');
  if (!/The application panicked|thread '[^']*' panicked at/.test(plain)) return undefined;
  const message = /Message:\s*([^\n]*)\n/.exec(plain) ?? /panicked at [^\n]*:\n([^\n]+)\n/.exec(plain);
  return message ? message[1]!.trim() || 'it panicked' : undefined;
}
