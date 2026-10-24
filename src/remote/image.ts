/** A pasted image belongs on the machine whose chat will read it. */
import { dirname } from 'node:path';
import { spawnSsh, runSsh } from './ssh.js';
import { shellQuote } from './shell.js';
import { failureText } from '../harness/protocol/stderr-line.js';

export async function uploadRemoteImage(target: string, name: string, bytes: Buffer): Promise<string> {
  const suffix = name.toLowerCase().match(/\.(png|jpe?g|gif|webp)$/)?.[1] ?? 'png';
  const script = [
    'set -eu',
    'umask 077',
    'dir=$(mktemp -d "${TMPDIR:-/tmp}/clikcode-image.XXXXXXXX")',
    `file="$dir/image.${suffix}"`,
    'cat > "$file"',
    'printf "%s\\n" "$file"',
  ].join('\n');
  return new Promise<string>((resolve, reject) => {
    const child = spawnSsh(target, script);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(-16_000); });
    child.stdin.on('error', () => undefined);
    child.once('error', reject);
    child.once('close', (code) => {
      const path = stdout.trim();
      if (code !== 0 || !/^\/[^\n]*\/clikcode-image\.[^/]+\/image\.(?:png|jpe?g|gif|webp)$/.test(path)) {
        reject(new Error(failureText(stderr) || 'Could not save the image on the remote machine.'));
      } else resolve(path);
    });
    child.stdin.end(bytes);
  });
}

export async function removeRemoteImage(target: string, path: string): Promise<void> {
  if (!/^\/[^\n]*\/clikcode-image\.[^/]+\/image\.(?:png|jpe?g|gif|webp)$/.test(path)) return;
  const folder = dirname(path);
  await runSsh(target, `rm -f ${shellQuote(path)}; rmdir ${shellQuote(folder)} 2>/dev/null || true`, { timeoutMs: 10_000 });
}
