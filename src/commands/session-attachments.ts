/**
 * Getting text and files out of, and into, a turn.
 *
 * Copying an answer to the clipboard, and turning what a user typed or dropped
 * into attachments a harness can be given. Split out of the turn loop, where
 * it had nothing to do with running a turn.
 */
import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stdout as output } from 'node:process';
import type { HarnessSession } from './types.js';

function captureProcess(command: string, args: readonly string[], cwd?: string, stdinText?: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...args], { cwd, stdio: [stdinText === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => { if (stdout.length < 1024 * 1024) stdout += chunk; });
    child.stderr!.on('data', (chunk: string) => { if (stderr.length < 16 * 1024) stderr += chunk; });
    if (stdinText !== undefined) child.stdin!.end(stdinText);
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolvePromise(stdout) : reject(new Error(stderr.trim() || `${command} exited ${code ?? 1}`)));
  });
}

/** OSC 52 asks the TERMINAL to set the clipboard, so it works over SSH where
 * no clipboard binary can reach the user's machine. tmux/screen need the
 * sequence wrapped in their passthrough envelope. */
export function osc52Sequence(text: string, environment: NodeJS.ProcessEnv = process.env): string {
  const payload = `\u001b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\u0007`;
  if (environment.TMUX) return `\u001bPtmux;${payload.replace(/\u001b/g, '\u001b\u001b')}\u001b\\`;
  if (/^screen/.test(environment.TERM ?? '')) return `\u001bP${payload}\u001b\\`;
  return payload;
}
const OSC52_MAX_BYTES = 74_000; // common terminal limit is ~100 kB of base64

export async function copyToClipboard(text: string): Promise<'binary' | 'osc52'> {
  const candidates: Array<[string, string[]]> = process.platform === 'darwin'
    ? [['pbcopy', []]]
    : process.platform === 'win32'
      ? [['clip', []]]
      : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]];
  // Over SSH a local clipboard binary would fill the REMOTE machine's clipboard.
  const remote = Boolean(process.env.SSH_CONNECTION || process.env.SSH_TTY);
  let lastError: unknown;
  if (!remote) {
    for (const [command, args] of candidates) {
      try { await captureProcess(command, args, undefined, text); return 'binary'; } catch (error) { lastError = error; }
    }
  }
  if (output.isTTY && Buffer.byteLength(text, 'utf8') <= OSC52_MAX_BYTES) {
    output.write(osc52Sequence(text));
    return 'osc52';
  }
  throw new Error(`No supported clipboard command is available${output.isTTY ? ' and the response is too large for the terminal clipboard (OSC 52)' : ''}${lastError instanceof Error && lastError.message ? `: ${lastError.message}` : '.'}`);
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

/** Decode a path as entered or dragged into a terminal without invoking a
 * shell. Drag-and-drop commonly adds quotes or backslashes before spaces. */
export function decodeAttachmentPath(input: string): string {
  let value = input.trim();
  const quoted = value.match(/^(?:"([\s\S]*)"|'([\s\S]*)')$/);
  if (quoted) value = quoted[1] ?? quoted[2] ?? '';
  if (value.startsWith('file://')) {
    try { return fileURLToPath(value); } catch { return value; }
  }
  // Backslashes are path separators on Windows, but terminal escape
  // characters on the Unix platforms where drag-and-drop produces them.
  return process.platform === 'win32' ? value : value.replace(/\\(.)/g, '$1');
}

export function expandHomePath(value: string, home = homedir()): string {
  return value === '~' ? home : /^~[\\/]/.test(value) ? join(home, value.slice(2)) : value;
}

/** Resolve a standalone input only when it clearly looks like a file
 * reference and names an existing regular file. This preserves slash
 * commands while allowing absolute image paths such as /home/me/photo.png. */
export async function resolveStandaloneAttachment(
  input: string,
  workspace: string,
): Promise<string | undefined> {
  const raw = input.trim();
  const decoded = decodeAttachmentPath(raw);
  const explicitlyQuoted = /^(?:"[\s\S]*"|'[\s\S]*')$/.test(raw);
  const looksLikePath = raw.startsWith('file://')
    || isAbsolute(decoded)
    || decoded.startsWith('./')
    || decoded.startsWith('../')
    || decoded.startsWith('~/')
    || explicitlyQuoted
    || IMAGE_EXTENSIONS.has(extname(decoded).toLowerCase());
  if (!looksLikePath) return undefined;
  const expanded = expandHomePath(decoded);
  const path = isAbsolute(expanded) ? resolve(expanded) : resolve(workspace, expanded);
  try {
    return (await stat(path)).isFile() ? path : undefined;
  } catch {
    // fail-open-ok: this decides whether typed text names an attachable file.
    // A path that cannot be stat'd is simply not one, and the text is then
    // treated as an ordinary prompt -- there is no failure to report.
    return undefined;
  }
}

export async function queueAttachment(session: HarnessSession, path: string): Promise<void> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error('Attachments must be files.');
  if (info.size > 1024 * 1024) throw new Error('Attachments are limited to 1 MiB each.');
  session.attachments = [...new Set([...(session.attachments ?? []), path])].slice(-10);
}

export async function prepareAttachments(paths: readonly string[]): Promise<{ textContext: string; images: string[] }> {
  const blocks: string[] = [];
  const images: string[] = [];
  let total = 0;
  for (const path of paths) {
    if (IMAGE_EXTENSIONS.has(extname(path).toLowerCase())) { images.push(path); continue; }
    const info = await stat(path);
    if (info.size > 256 * 1024 || total + info.size > 512 * 1024) throw new Error('Text attachments are limited to 256 KiB each and 512 KiB per request.');
    const content = await readFile(path, 'utf8');
    total += Buffer.byteLength(content);
    blocks.push(`\n<clikcode_attachment path="${path.replace(/"/g, '&quot;')}">\n${content}\n</clikcode_attachment>`);
  }
  return { textContext: blocks.join('\n'), images };
}