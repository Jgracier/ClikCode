/** Keeps the vaults of one person's computers the same, over their own Tailscale network: no relay, no third party, no passphrase to type.
 *
 * `clikcode computer secrets --sync <user@host>` sends this computer's vault to the other one over `tailscale ssh` (already authenticated
 * and encrypted), the other one merges it and answers with its own, and this one merges that. Both end up with everything; the newer of a
 * secret both have wins; nothing is ever deleted. Values travel only inside that connection and are never printed. */
import { spawn } from 'node:child_process';
import { mergeVault, snapshotVault, type VaultSnapshot } from './credential-vault.js';
import { scrubSecrets } from './secret-scrubber.js';

interface SyncResult { sent: { added: number; updated: number; same: number }; received: { added: number; updated: number; same: number } }

/** The remote end: merges what arrived, answers with this vault as it was before (so the sender can merge it back). */
export async function exchangeVault(stateDir: string, incoming: string): Promise<string> {
  const before = await snapshotVault(stateDir);
  await mergeVault(stateDir, JSON.parse(incoming) as VaultSnapshot);
  return JSON.stringify(before);
}

/** Moves one message to the other computer and brings back its answer. */
type Transport = (payload: string) => Promise<string>;

/** What came back, without one character of it: a reply that is nearly a vault is a plaintext vault. Its size, and whether it is JSON. */
function describeReply(text: string): string {
  const size = `${text.length} characters`;
  if (!text.trim()) return 'it was empty';
  try {
    const parsed = JSON.parse(text) as unknown;
    // ClikCode's own error document ({status: "error", message}) holds no vault: its message is the one thing worth saying.
    const doc = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
    if (doc && doc.status === 'error' && typeof doc.message === 'string' && !('secrets' in doc) && !('items' in doc)) return `its error: ${scrubSecrets(doc.message).replace(/\s+/g, ' ').slice(0, 160)}`;
    return `${size} of JSON (${Array.isArray(parsed) ? 'an array' : parsed === null ? 'null' : typeof parsed}), not a v1 vault`;
  }
  catch { return `${size}, not JSON`; }
}

export async function syncVault(stateDir: string, transport: Transport): Promise<SyncResult> {
  const mine = await snapshotVault(stateDir);
  // The first run on a computer that was just updated has answered with something other than its vault; the second always has. Ask once more, and say what came back if it still is not one.
  let reply: VaultSnapshot | undefined, last = '';
  for (let attempt = 0; attempt < 2 && !reply; attempt++) {
    last = await transport(JSON.stringify(mine));
    try { const parsed = JSON.parse(last) as VaultSnapshot; if (parsed?.v === 1 && Array.isArray(parsed.secrets)) reply = parsed; } catch { /* fail-open-ok: not JSON */ }
  }
  if (!reply) throw new Error(`The other computer answered with something that is not a vault (${describeReply(last)}). Its answer is not shown: it may hold secrets. Run \`clikcode computer secrets --exchange\` there by hand to see what it says.`);
  const received = await mergeVault(stateDir, reply);
  // What the other computer gained is what it lacked of mine: counted from the reply rather than asked for again.
  const theirs = new Set(reply.secrets.map(secret => secret.name.toLowerCase()));
  const sent = { added: mine.secrets.filter(secret => !theirs.has(secret.name.toLowerCase())).length, updated: 0, same: mine.secrets.filter(secret => theirs.has(secret.name.toLowerCase())).length };
  return { sent, received };
}

/** `tailscale ssh <target> clikcode computer secrets --exchange`, the message on its standard input and the answer on its standard output. */
export function tailscaleTransport(target: string): Transport {
  if (!/^[\w.-]+@[\w.-]+$/.test(target)) throw new Error('Name the other computer as user@host, for example chronos@macbook.');
  // A non-interactive ssh shell does not have the user's PATH; ClikCode installs to ~/.local/bin, and may carry its own node beside it.
  const remote = 'PATH="$HOME/.local/bin:$HOME/.local/share/clikcode/node/bin:$PATH" clikcode computer secrets --exchange';
  return payload => new Promise((resolve, reject) => {
    const child = spawn('tailscale', ['ssh', target, remote], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', chunk => { out += String(chunk); });
    child.stderr.on('data', chunk => { err += String(chunk); });
    child.on('error', error => reject(new Error(`tailscale could not be run: ${error.message}`)));
    child.on('close', code => code === 0 && out.trim() ? resolve(out) : reject(new Error(`The other computer did not answer (${code}). ${err.trim().split('\n').slice(-2).join(' ')}`.trim())));
    child.stdin.end(payload);
  });
}
