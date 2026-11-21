/** A captcha voter that runs on the user's signed-in Claude or Codex subscription instead of Gateway credit: the
 * vendor's own command line, headless, with no tools but reading the challenge pictures and no session kept (the
 * same way the connector micro-agent runs, connector-micro-agent.ts). It takes seconds to start and runs one or two
 * at a time, so it is for the few hard, single-picture questions -- a riddle, a match, a pick -- and for standing
 * in when the Gateway's voters cannot answer; never for the dozens of yes/no asks of a picture grid. */
import type { ImageInput, ModelClient } from '../model-client.js';
import { quiet } from '../../runtime/lifecycle-log.js';

const TURN_MS = 90_000;
const LOOKUP_TTL_MS = 60_000;
const AT_ONCE = 2;

/** What a voter is asked with: the same call the Gateway voters take, and only its text comes back. */
type Step = ModelClient['step'];

let lookedUp: { at: number; command?: 'claude' | 'codex'; env?: NodeJS.ProcessEnv } | undefined;
/** The signed-in account that can take a turn now (a minute's memory, so a vote does not read the state each time). */
async function account(now: number): Promise<{ command: 'claude' | 'codex'; env: NodeJS.ProcessEnv } | undefined> {
  if (!lookedUp || now - lookedUp.at > LOOKUP_TTL_MS) {
    lookedUp = { at: now };
    try {
      const { readState } = await import('../../session/state/read.js');
      const { microAccount } = await import('./connector-micro-agent.js');
      const { nativeProfileEnvironment } = await import('../../harness/transport/profile-environment.js');
      const found = microAccount((await readState({ transcripts: [] })).accounts);
      if (found) {
        const env = { ...process.env, ...nativeProfileEnvironment(found.nativeProfile) };
        // A signed-in native account, never an unrelated API key inherited from the parent.
        delete env.OPENAI_API_KEY;
        delete env.ANTHROPIC_API_KEY;
        lookedUp = { at: now, command: found.provider === 'openai' ? 'codex' : 'claude', env };
      }
    } catch (error) { quiet('agent/computer/captcha-subscription')(error instanceof Error ? error.message : String(error)); }
  }
  return lookedUp.command && lookedUp.env ? { command: lookedUp.command, env: lookedUp.env } : undefined;
}

let running = 0;
const waiting: Array<() => void> = [];
async function turnstile<T>(work: () => Promise<T>): Promise<T> {
  if (running >= AT_ONCE) await new Promise<void>(resolve => waiting.push(resolve));
  running++;
  try { return await work(); } finally { running--; waiting.shift()?.(); }
}

const extension = (image: ImageInput): string => /png/.test(image.mimeType) ? 'png' : /webp/.test(image.mimeType) ? 'webp' : 'jpg';

export function subscriptionArgs(command: 'claude' | 'codex', prompt: string, files: string[], dir: string, config: string, final: string): string[] {
  return command === 'codex'
    ? ['exec', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check', '-C', dir, '-s', 'read-only', '-c', 'approval_policy="never"', '-c', 'features.shell_tool=false', '-c', 'web_search="disabled"', ...files.flatMap(file => ['-i', file]), '-o', final, prompt]
    : ['-p', prompt, '--model', process.env.CLIKCODE_CAPTCHA_SUBSCRIPTION_MODEL || 'claude-haiku-5-5', '--output-format', 'text', '--mcp-config', config, '--strict-mcp-config', '--tools', 'Read', '--allowedTools', 'Read', '--permission-mode', 'dontAsk', '--no-session-persistence'];
}

/** A voter on the user's subscription, or undefined when it is switched off (CLIKCODE_CAPTCHA_SUBSCRIPTION=0) or
 * no signed-in Claude or Codex account has usage left. */
export async function subscriptionVoter(now: () => number = Date.now): Promise<{ name: string; client: ModelClient } | undefined> {
  if (process.env.CLIKCODE_CAPTCHA_SUBSCRIPTION === '0') return undefined;
  const who = await account(now());
  if (!who) return undefined;
  const step = (async (request: Parameters<Step>[0]) => turnstile(async () => {
    const [{ mkdtemp, writeFile, readFile, rm }, { tmpdir }, { join }, { spawn }] = await Promise.all([import('node:fs/promises'), import('node:os'), import('node:path'), import('node:child_process')]);
    const dir = await mkdtemp(join(tmpdir(), 'clikcode-captcha-'));
    try {
      const item = request.items.find(entry => entry.type === 'text') as { text: string; images?: ImageInput[] } | undefined;
      const images = item?.images ?? [];
      const files: string[] = [];
      for (const [index, image] of images.entries()) { const file = join(dir, `picture-${index + 1}.${extension(image)}`); await writeFile(file, Buffer.from(image.data, 'base64')); files.push(file); }
      const config = join(dir, 'mcp.json'), final = join(dir, 'final.txt');
      await writeFile(config, JSON.stringify({ mcpServers: {} }));
      const where = who.command === 'claude' && files.length ? `The picture${files.length > 1 ? 's, in order, are the files' : ' is the file'} ${files.join(', ')}. Read ${files.length > 1 ? 'them' : 'it'} first.\n\n` : '';
      const prompt = `${request.system}\n\n${where}${item?.text ?? ''}\n\nReply with the answer only, in the format asked for.`;
      const child = spawn(who.command, subscriptionArgs(who.command, prompt, files, dir, config, final), { cwd: dir, env: who.env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
      let text = '';
      child.stdout!.on('data', chunk => { text = (text + String(chunk)).slice(-8_000); });
      child.stderr!.on('data', quiet('agent/computer/captcha-subscription'));
      const kill = (): void => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); } };
      const timer = setTimeout(kill, TURN_MS);
      request.signal?.addEventListener('abort', kill, { once: true });
      if (request.signal?.aborted) kill();
      const code = await new Promise<number | null>(resolve => { child.once('close', resolve); child.once('error', () => resolve(-1)); });
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', kill);
      if (who.command === 'codex') text = await readFile(final, 'utf8').catch(() => '');
      if (code !== 0 || !text.trim()) throw new Error(`the ${who.command} subscription voter did not answer (exit ${code})`);
      return { text } as Awaited<ReturnType<Step>>;
    } finally { await rm(dir, { recursive: true, force: true }).catch(quiet('agent/computer/captcha-subscription')); }
  })) as Step;
  return { name: `subscription-${who.command}`, client: { step } as ModelClient };
}
