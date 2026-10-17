/** Where a captured key goes, decided by the agent before it is captured and
 * approved once by the user. Nothing about a provider is built in: a destination
 * is "this ClikDeploy tool with these arguments" or "this GitHub repository
 * secret", with `{{secret}}` marking where the value goes. The worker fills it in
 * at the moment of capture, so the value is never in anything the agent writes or reads.
 *
 * Only two executors exist, both talking to the user's own services: the
 * `clikdeploy` command (`tools run`) and `gh secret set`. The agent chooses the
 * tool and its arguments, not the program that runs. */
import { runCli } from './run-cli.js';
import { scrubSecrets } from './secret-scrubber.js';

export const PLACEHOLDER = '{{secret}}';

export type Destination =
  | { type: 'clikdeploy'; tool: string; args: Record<string, unknown> }
  | { type: 'github'; repo: string; name: string };

const TOOL_NAME = /^[a-z][a-z0-9_]{2,80}$/;
const REPO = /^[\w.-]+\/[\w.-]+$/;
const SECRET_NAME = /^[A-Z][A-Z0-9_]{1,80}$/;

const mentionsSecret = (node: unknown): boolean =>
  typeof node === 'string' ? node.includes(PLACEHOLDER)
    : Array.isArray(node) ? node.some(mentionsSecret)
      : node !== null && typeof node === 'object' ? Object.values(node).some(mentionsSecret) : false;

/** The first problem with the plan, in words the agent can act on; undefined when it is sound. */
export function destinationProblem(list: readonly unknown[]): string | undefined {
  for (const [index, item] of list.entries()) {
    const at = `send_to[${index}]`;
    const d = item as Record<string, unknown> | null;
    if (!d || typeof d !== 'object') return `${at} must be an object.`;
    if (d.type === 'clikdeploy') {
      if (typeof d.tool !== 'string' || !TOOL_NAME.test(d.tool)) return `${at}.tool must be a ClikDeploy tool name such as admin_compute_save_credentials.`;
      if (!d.args || typeof d.args !== 'object' || Array.isArray(d.args)) return `${at}.args must be an object of the tool's arguments.`;
      if (!mentionsSecret(d.args)) return `${at}.args must contain ${PLACEHOLDER} where the key goes, or the key is never sent.`;
    } else if (d.type === 'github') {
      if (typeof d.repo !== 'string' || !REPO.test(d.repo)) return `${at}.repo must be owner/name.`;
      if (typeof d.name !== 'string' || !SECRET_NAME.test(d.name)) return `${at}.name must be an upper-case secret name such as SALAD_API_KEY.`;
    } else return `${at}.type must be clikdeploy or github.`;
  }
  return undefined;
}

/** The plan as the user will read it when approving: the key is shown only as its placeholder. */
export function describeDestinations(list: readonly Destination[]): string {
  return list.map(d => d.type === 'github'
    ? `  • GitHub repository ${d.repo}: secret ${d.name}`
    : `  • ClikDeploy: ${d.tool} ${JSON.stringify(d.args).replace(/"/g, '').replace(/\{\{secret\}\}/g, '‹the key›').slice(0, 200)}`).join('\n');
}

function fill(node: unknown, value: string): unknown {
  if (typeof node === 'string') return node.split(PLACEHOLDER).join(value);
  if (Array.isArray(node)) return node.map(item => fill(item, value));
  if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, fill(child, value)]));
  return node;
}

export type Delivery = { label: string; ok: boolean; message: string };

const say = (text: string): string => {
  try {
    const parsed = JSON.parse(text.slice(text.indexOf('{'))) as { message?: string; error?: string; data?: { message?: string; appliedToWebProcess?: boolean; reloadReason?: string } };
    const line = [parsed.message ?? parsed.error ?? parsed.data?.message, parsed.data?.appliedToWebProcess !== undefined ? `appliedToWebProcess=${parsed.data.appliedToWebProcess}` : '', parsed.data?.reloadReason].filter(Boolean).join(' · ');
    if (line) return line;
  } catch { /* not JSON: use the last lines */ }
  return text.trim().split('\n').slice(-3).join(' ').slice(0, 300);
};

export async function sendToDestinations(list: readonly Destination[], value: string, signal?: AbortSignal): Promise<Delivery[]> {
  const out: Delivery[] = [];
  for (const d of list) {
    const label = d.type === 'github' ? `GitHub ${d.repo} ${d.name}` : `ClikDeploy ${d.tool}`;
    const result = d.type === 'github'
      // gh reads the value from stdin: it is in no command line.
      ? await runCli('gh', ['secret', 'set', d.name, '--repo', d.repo], { stdin: value, signal, timeoutMs: 60_000 })
      : await runCli('clikdeploy', ['tools', 'run', d.tool, '--args-json', JSON.stringify(fill(d.args, value)), '--confirm'], { signal, timeoutMs: 90_000 });
    if (result.missing) { out.push({ label, ok: false, message: `The ${d.type === 'github' ? 'gh' : 'clikdeploy'} command is not installed on this computer.` }); continue; }
    out.push({ label, ok: result.code === 0, message: scrubSecrets(say(result.text)) });
  }
  return out;
}
