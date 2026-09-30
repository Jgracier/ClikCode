/** How a model id reads next to the provider it is shown under.
 *
 * The provider is always on screen beside a model (the picker's title, the
 * footer's provider half, a conversation row's "OpenCode · …"), so a leading
 * segment that only repeats it is noise: `opencode/big-pickle` under OpenCode
 * reads `big-pickle`, Kilo's `kilo/openai/gpt-5.1` reads `openai/gpt-5.1`,
 * Hermes's `nous:anthropic/claude-opus-5` reads `anthropic/claude-opus-5`.
 *
 * A prefix naming anyone else stays, because there it says something: the
 * lab behind a Gateway or Cline model (`openai/gpt-5.5`), or the upstream a
 * multi-provider harness routes to (Goose's `openrouter/…`, Hermes's
 * `copilot:…`). Only one segment is ever removed.
 *
 * Other routed models use `provider/model` on every screen, regardless of
 * whether their vendor writes `provider:model` or `provider/model`.
 * Display only. Stored and sent ids never change; this module has no imports
 * so the VS Code webview bundles the same code the terminal runs. */

/** Every name a provider goes by, keyed by the id `choose provider` takes (a
 * harness command, `gateway`, `clikcode-local`): its catalog provider id, its
 * binary, its display name, and the spellings its vendor uses as a model
 * prefix (`kimi-code/k3`). A test holds this to the harness catalog, so a new
 * harness cannot be missing from it. */
export const MODEL_OWNER_NAMES: Readonly<Record<string, readonly string[]>> = {
  claude: ['anthropic', 'claude-code', 'Claude Code'],
  grok: ['xai', 'Grok Build'],
  gemini: ['google', 'Gemini CLI'],
  codex: ['openai', 'Codex'],
  opencode: ['OpenCode'],
  copilot: ['github-copilot', 'GitHub Copilot'],
  aider: ['Aider'],
  goose: ['Goose'],
  amp: ['Amp'],
  antigravity: ['agy', 'Antigravity CLI'],
  pi: ['Pi Coding Agent'],
  droid: ['factory', 'Factory Droid'],
  kiro: ['kiro-cli', 'Kiro CLI'],
  qwen: ['Qwen Code'],
  cline: ['Cline CLI'],
  kilo: ['kilo-code', 'Kilo Code CLI'],
  cursor: ['cursor-agent', 'Cursor Agent'],
  hermes: ['nous', 'Hermes'],
  openclaw: ['OpenClaw'],
  command: ['command-code', 'cmdc', 'Command Code'],
  kimi: ['kimi-code', 'Kimi CLI'],
  auggie: ['augment', 'Augment Auggie'],
  vibe: ['mistral-vibe', 'vibe-acp', 'Mistral Vibe'],
  openhands: ['OpenHands CLI'],
  cn: ['continue', 'Continue'],
  'clikcode-local': ['ClikCode Local'],
  gateway: ['clikdeploy', 'clikdeploy-gateway', 'ClikDeploy Gateway'],
};

/** Names compared on letters and digits alone: `GitHub Copilot` is
 * `github-copilot`. */
function bare(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const GROUPS: ReadonlyArray<ReadonlySet<string>> = Object.entries(MODEL_OWNER_NAMES)
  .map(([id, names]) => new Set([id, ...names].map(bare)));

/** Only these harnesses use a provider before a colon in model ids. Other
 * vendors can use a colon for a model tag, which must remain intact. */
const ROUTED_HARNESSES = new Set(['opencode', 'goose', 'pi', 'hermes', 'openclaw', 'kilo']);
const ROUTED_NAMES = new Set([...ROUTED_HARNESSES]
  .flatMap((id) => [id, ...(MODEL_OWNER_NAMES[id] ?? [])].map(bare)));

function routesModels(owners: ReadonlyArray<string | null | undefined>): boolean {
  return owners.some((owner) => owner && ROUTED_NAMES.has(bare(owner)));
}

/** Every bare name the given owners go by. An owner the table does not know
 * still counts as itself. */
function ownerNames(owners: ReadonlyArray<string | null | undefined>): Set<string> {
  const names = new Set<string>();
  for (const owner of owners) {
    const key = owner ? bare(owner) : '';
    if (!key) continue;
    names.add(key);
    for (const group of GROUPS) if (group.has(key)) for (const name of group) names.add(name);
  }
  return names;
}

/** A `name:tag` id's tag (`qwen:7b`, `kimi:latest`) is not a model name on
 * its own, so such a colon is never read as a provider separator. */
const BARE_TAG = /^(?:latest|free|beta|nightly|\d[\w.]*)$/i;

/** `model` as it reads under `owners` (the provider id and/or its display
 * name): one leading `owner/` or `owner:` removed when it names one of them;
 * a different provider's `:` separator reads `/`. Empty in, empty out. */
export function modelLabel(model: string, ...owners: ReadonlyArray<string | null | undefined>): string;
export function modelLabel(model: string | null | undefined, ...owners: ReadonlyArray<string | null | undefined>): string | undefined;
export function modelLabel(model: string | null | undefined, ...owners: ReadonlyArray<string | null | undefined>): string | undefined {
  if (!model) return model ?? undefined;
  const match = /^([^\s/:]+)([/:])(.+)$/.exec(model);
  if (!match) return model;
  const [, prefix, separator, rest] = match as unknown as [string, string, string, string];
  if (separator === ':' && (!routesModels(owners) || BARE_TAG.test(rest) || rest.startsWith('//'))) return model;
  if (ownerNames(owners).has(bare(prefix))) return rest;
  return separator === ':' ? `${prefix}/${rest}` : model;
}
