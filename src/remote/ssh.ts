/** Running something on another machine: plain OpenSSH, never a prompt.
 *
 * Every connection is `ssh -o BatchMode=yes -o ConnectTimeout=10 -- <target>
 * <script>`. BatchMode means ssh never asks for a password or a passphrase
 * and never asks to trust a new host key interactively: a login that needs
 * one fails, and ClikCode says so. A new machine's host key is accepted and
 * remembered the first time (accept-new); a changed one is refused. ClikCode
 * handles no passwords and sends no secrets. Keys, an agent, or Tailscale SSH
 * (which needs neither) are how a login succeeds. `--` ends ssh's options, and the target was checked not
 * to start with `-` anyway (shell.ts). */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { userInfo } from 'node:os';
import { remoteShell, targetHost, targetUser, validateSshTarget } from './shell.js';

export const SSH_OPTIONS: readonly string[] = [
  '-o', 'BatchMode=yes',
  '-o', 'ConnectTimeout=10',
  // A machine's first connection trusts its host key and remembers it, as
  // answering "yes" would; a key that CHANGED is still refused (host-key).
  '-o', 'StrictHostKeyChecking=accept-new',
  // A dropped network is noticed within a minute, not at TCP's leisure.
  '-o', 'ServerAliveInterval=15',
  '-o', 'ServerAliveCountMax=3',
];

export interface SshResult { code: number; stdout: string; stderr: string }

/** Why ssh itself failed (exit 255), from what it printed. */
export type SshFailure = 'auth' | 'unreachable' | 'host-key' | 'other';

export function sshFailure(result: SshResult): SshFailure | undefined {
  if (result.code !== 255) return undefined;
  const text = result.stderr;
  // Tailscale SSH refuses by its tailnet policy, then closes: `tailscale: tailnet policy does not permit you to SSH as user "x"`.
  if (/Permission denied|Authentication failed|Too many authentication failures|no matching host key|publickey|tailnet policy does not permit/i.test(text) && !/host key verification failed/i.test(text)) return 'auth';
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(text)) return 'host-key';
  if (/Could not resolve|Connection timed out|Connection refused|No route to host|Network is unreachable|Operation timed out|timed out|Name or service not known|nodename nor servname/i.test(text)) return 'unreachable';
  return 'other';
}

/** The words for an ssh failure, with what to do about it. */
export function sshFailureMessage(target: string, result: SshResult): string {
  const failure = sshFailure(result);
  // The line that says why, not ssh's closing `Connection closed by ...` after it.
  const lines = result.stderr.trim().split('\n').map((line) => line.trim()).filter(Boolean);
  const said = lines.filter((line) => !/^Connection (closed|reset) by /i.test(line)).pop() ?? lines.pop() ?? '';
  if (failure === 'auth') return `${target} refused the login (${said || 'permission denied'}). ClikCode never asks for passwords: add your SSH key to that machine (ssh-copy-id ${target}), or turn on Tailscale SSH there.`;
  if (failure === 'unreachable') return `${target} could not be reached (${said || 'no answer'}). Check that it is on and online.`;
  if (failure === 'host-key') return `${target}'s host key is not trusted yet (${said}). Connect once with \`ssh ${target}\` to check and accept it.`;
  return `ssh ${target} failed: ${said || `exit ${result.code}`}`;
}

/** The argv for `script` on `target` (no shell involved locally). */
export function sshArgv(target: string, script: string, extra: readonly string[] = []): string[] {
  return [...SSH_OPTIONS, ...extra, '--', validateSshTarget(target), remoteShell(script)];
}

/** Starts `script` on `target` with its stdio piped (the board's bridge). */
export function spawnSsh(target: string, script: string): ChildProcessWithoutNullStreams {
  return spawn('ssh', sshArgv(target, script, ['-T']), { stdio: ['pipe', 'pipe', 'pipe'] });
}

/** Runs `script` on `target` and collects what it printed. Never throws for
 * a failed command: the caller reads `code` (255 is ssh's own failure). */
export function runSsh(target: string, script: string, options: { timeoutMs?: number; onLine?: (line: string) => void } = {}): Promise<SshResult> {
  return new Promise((resolve) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn('ssh', sshArgv(target, script, ['-T']), { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ code: 255, stdout: '', stderr: error instanceof Error ? error.message : String(error) });
      return;
    }
    child.stdin.end();
    let stdout = '';
    let stderr = '';
    let pending = '';
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stdout += text;
      if (!options.onLine) return;
      pending += text;
      for (let at = pending.indexOf('\n'); at >= 0; at = pending.indexOf('\n')) {
        options.onLine(pending.slice(0, at));
        pending = pending.slice(at + 1);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    const timer = options.timeoutMs ? setTimeout(() => { stderr += '\nssh: timed out'; child.kill('SIGTERM'); }, options.timeoutMs) : undefined;
    timer?.unref();
    child.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({ code: 255, stdout, stderr: error.code === 'ENOENT' ? 'ssh is not installed on this machine (OpenSSH client)' : error.message });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 255, stdout, stderr });
    });
  });
}

/** Who ssh logs in as for `target` when it names no user: `User` from
 * ~/.ssh/config (read by `ssh -G`, which does not connect), else the local
 * user name. The default offered when a login is refused. */
export async function defaultLoginUser(target: string): Promise<string> {
  const named = targetUser(target);
  if (named) return named;
  const local = (() => { try { return userInfo().username; } catch { return process.env.USER ?? 'root'; } })();
  const configured = await new Promise<string | undefined>((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn('ssh', ['-G', '--', validateSshTarget(targetHost(target))], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { resolve(undefined); return; }
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
    child.once('error', () => resolve(undefined));
    child.once('close', () => resolve(/^user (\S+)$/m.exec(out)?.[1]));
  });
  return configured || local;
}
