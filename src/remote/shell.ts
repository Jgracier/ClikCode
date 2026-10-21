/** Quoting for the command lines ClikCode Remote sends over SSH, and the one
 * check an SSH target must pass.
 *
 * Everything run on another machine is a POSIX `sh` script passed as ONE
 * argument after the target. ssh joins its arguments with spaces and hands
 * the result to the remote user's login shell, so the script is itself
 * single-quoted (`sh -c '<script>'`), and every value that came from a user
 * or a machine -- a host, a user name, a path -- is single-quoted inside it.
 * Nothing is interpolated unquoted. */

/** `value` as one single-quoted POSIX shell word: `'` closes the quote, an
 * escaped quote, and opens it again. Safe for any byte but NUL. */
export function shellQuote(value: string): string {
  if (value.includes('\0')) throw new Error('a shell word cannot contain a NUL byte');
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The argument ssh runs on the other side: `script` under `sh`, whatever
 * the user's login shell is (fish, zsh, ...). */
export function remoteShell(script: string): string {
  return `sh -c ${shellQuote(script)}`;
}

/** What ssh accepts as a destination here: `host`, `user@host`, or an
 * ~/.ssh/config Host alias. Never anything that starts with `-` (ssh would
 * read it as an option: `-oProxyCommand=...` runs a command locally), and no
 * whitespace, quotes or control characters -- a target is one word.
 * Returns the trimmed target, or throws saying what is wrong. */
export function validateSshTarget(input: string): string {
  const target = input.trim();
  if (!target) throw new Error('Type an SSH address: user@host, host, or a Host alias from ~/.ssh/config.');
  if (target.startsWith('-')) throw new Error(`"${target}" starts with "-", which ssh would read as an option. Type user@host.`);
  if (/[\s'"`\\$;&|<>(){}*?!#\u0000-\u001f\u007f]/.test(target)) throw new Error(`"${target}" is not an SSH address: user@host, host, or a Host alias.`);
  const at = target.lastIndexOf('@');
  const user = at >= 0 ? target.slice(0, at) : undefined;
  const host = at >= 0 ? target.slice(at + 1) : target;
  if (!host || host.startsWith('-')) throw new Error(`"${target}" has no host after "@".`);
  if (user !== undefined && (!user || user.startsWith('-') || user.includes('@'))) throw new Error(`"${target}" is not user@host.`);
  return target;
}

/** The host part of a target (`bob@box` -> `box`). */
export function targetHost(target: string): string {
  const at = target.lastIndexOf('@');
  return at >= 0 ? target.slice(at + 1) : target;
}

/** The user part, when the target names one. */
export function targetUser(target: string): string | undefined {
  const at = target.lastIndexOf('@');
  return at >= 0 ? target.slice(0, at) : undefined;
}

/** `user@host` for a user typed when asked: the same checks as a target. */
export function withUser(target: string, user: string): string {
  const name = user.trim();
  if (!name || name.startsWith('-') || /[\s@'"`\\$;&|<>(){}*?!#\u0000-\u001f\u007f]/.test(name)) throw new Error(`"${user}" is not a user name.`);
  return validateSshTarget(`${name}@${targetHost(target)}`);
}
