/** Lazy bridge to the separately bundled router runtime. Vendor process
 * parsing deliberately lives elsewhere; this module only exposes catalog and
 * request-building capabilities. Nothing here may name a harness: every
 * per-vendor fact is a declared field on the catalog entry. */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { augmentProcessPath } from '../harness/transport/native/install-locations.js';
import type { AiHarnessAcpLaunch, AiHarnessCapabilityManifest, AiHarnessIntegrationLevel, AiHarnessPermissionMode, AiHarnessTransport, AiLocalHarnessDefinition, AiRouterRuntime } from '../harness/definition.js';

const require = createRequire(import.meta.url);

/** A bundle beside this one: `../x` from source (dist/ is the repo's), `./x`
 * from the bundle itself. */
function sibling<T>(name: string): T {
  try {
    return require(`../${name}`) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error;
    return require(fileURLToPath(new URL(`./${name}`, import.meta.url))) as T;
  }
}

/** The direct API-key route's turn (dist/ai-router-runtime.cjs: `ai` and the
 * @ai-sdk providers, 3 MB), loaded by the first such turn and nothing else. */
let routerRuntime: Pick<AiRouterRuntime, 'streamAiChatTurn'> | undefined;
const localRouter = (): Pick<AiRouterRuntime, 'streamAiChatTurn'> => (routerRuntime ??= sibling<Pick<AiRouterRuntime, 'streamAiChatTurn'>>('ai-router-runtime.cjs'));

type HarnessCatalogRuntime = Omit<AiRouterRuntime, 'streamAiChatTurn'>;
let catalogRuntime: HarnessCatalogRuntime | undefined;

/** The dependency-free catalog bundle (dist/harness-catalog.cjs). Every
 * catalog call goes through this ONE bundle: registerCustomHarnesses() keeps
 * module state that a second copy would not see. */
function localCatalog(): HarnessCatalogRuntime {
  if (!catalogRuntime) {
    catalogRuntime = sibling<HarnessCatalogRuntime>('harness-catalog.cjs');
    // Every harness spawn reads the catalog first, so this is the one place
    // that sees them all before any: the directories vendor installers (and
    // ClikCode's own npm prefix) put binaries in go on the end of PATH.
    augmentProcessPath(catalogRuntime.allLocalHarnesses());
  }
  return catalogRuntime;
}

/** Unit consumers intentionally load this module without the separately
 * bundled router runtime; a structural answer is also the safe one for an
 * externally supplied definition. */
function withoutRuntime<T>(read: (router: HarnessCatalogRuntime) => T, structural: () => T): T {
  try { return read(localCatalog()); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error;
    return structural();
  }
}

/** Whether a provider id names a model API this process can call directly.
 *  False for a tool that merely names itself as its provider (aider, goose,
 *  opencode and nine others) -- those have no endpoint, so an api-key account
 *  on them must run the vendor CLI, not a direct HTTP turn. */
export const isDirectModelProvider = (provider: string): boolean => Boolean(localCatalog().getAiProvider(provider));
export const localHarnessForCommand = (command: string): AiLocalHarnessDefinition | undefined => localCatalog().localHarnessForCommand(command);
export const localHarnessForProvider = (provider: string): AiLocalHarnessDefinition | undefined => localCatalog().localHarnessForProvider(provider);
export const localHarnessCapabilityManifest = (harness: AiLocalHarnessDefinition): AiHarnessCapabilityManifest => localCatalog().localHarnessCapabilityManifest(harness);
export const harnessSupportsEffort = (harness: AiLocalHarnessDefinition): boolean => localCatalog().harnessSupportsEffort(harness);
export const harnessSupportsPermissionMode = (harness: AiLocalHarnessDefinition, mode: AiHarnessPermissionMode): boolean => localCatalog().harnessSupportsPermissionMode(harness, mode);
export const harnessSupportsImages = (harness: AiLocalHarnessDefinition): boolean => localCatalog().harnessSupportsImages(harness);

/** The built-in catalog alone, and the adapter version it declares. */
export const builtInHarnesses = (): readonly AiLocalHarnessDefinition[] => localCatalog().AI_LOCAL_HARNESSES;
export const harnessAdapterVersion = (): number => localCatalog().AI_LOCAL_HARNESS_ADAPTER_VERSION;
/** Built-in catalog plus any registered custom ACP harnesses. */
export const allLocalHarnesses = (): readonly AiLocalHarnessDefinition[] => localCatalog().allLocalHarnesses();
export const harnessAcpLaunch = (
  harness: AiLocalHarnessDefinition, input?: { model?: string | null; effort?: string | null; permissionMode?: AiHarnessPermissionMode },
): AiHarnessAcpLaunch | undefined => localCatalog().harnessAcpLaunch(harness, input);
export const harnessTierRank = (harness: AiLocalHarnessDefinition): number => withoutRuntime(
  (router) => router.harnessTierRank(harness),
  () => ({ primary: 0, more: 1, experimental: 2 } as const)[harness.tier ?? 'experimental'] ?? 2,
);
export const nativeHarnessTurnArgv = (
  harness: AiLocalHarnessDefinition, input: Parameters<AiRouterRuntime['nativeHarnessTurnArgv']>[1],
): string[] => localCatalog().nativeHarnessTurnArgv(harness, input);
export const harnessLoginArgvForModel = (harness: AiLocalHarnessDefinition, model: string | null | undefined): readonly string[] | undefined =>
  localCatalog().harnessLoginArgvForModel(harness, model);
export const modelProvider = (harness: AiLocalHarnessDefinition, model: string): string | undefined =>
  localCatalog().modelProvider(harness, model);
export const modelDisplayId = (harness: AiLocalHarnessDefinition, model: string): string =>
  localCatalog().modelDisplayId(harness, model);
export const modelIdFromDisplay = (harness: AiLocalHarnessDefinition, typed: string): string =>
  localCatalog().modelIdFromDisplay(harness, typed);
export const harnessReplyError = (harness: AiLocalHarnessDefinition, text: string): { statusCode?: number } | undefined =>
  localCatalog().harnessReplyError(harness, text);
export const maxPromptArgvBytes = (): number => localCatalog().maxPromptArgvBytes;
export const promptExceedsArgvLimit = (harness: AiLocalHarnessDefinition, prompt: string): boolean => localCatalog().promptExceedsArgvLimit(harness, prompt);
export const harnessCanRunTurns = (harness: AiLocalHarnessDefinition): boolean =>
  harness.surface === 'terminal' && Boolean(harness.turn || harness.acp);

export const harnessIntegrationLevel = (harness: AiLocalHarnessDefinition): AiHarnessIntegrationLevel => {
  if (harness.integration) return harness.integration;
  return withoutRuntime((router) => router.harnessIntegrationLevel(harness), () => {
    if (harness.surface === 'editor-extension') return 'editor-only';
    if (harness.transport === 'codex-app-server') return 'native';
    if (harness.transport === 'acp' && harness.acp) return 'structured';
    if (harness.transport === 'text-cli') return 'compatibility';
    return harness.turn && harness.turn.output !== 'text' ? 'structured' : 'compatibility';
  });
};

/** Transport for one turn, read from the declaration. */
export const harnessPreferredTransport = (
  harness: AiLocalHarnessDefinition, input: { hasImages?: boolean } = {},
): AiHarnessTransport => withoutRuntime((router) => router.harnessTurnTransport(harness, input), () => {
  if (harness.transport === 'codex-app-server') return 'codex-app-server';
  const cli: AiHarnessTransport = harness.turn?.output === 'text' ? 'text-cli' : 'structured-cli';
  if (!harness.acp) return harness.turn ? cli : harness.transport ?? cli;
  if (!harness.turn) return 'acp';
  return !input.hasImages ? 'acp' : cli;
});

export const streamLocalAiTurn = (input: Record<string, unknown>): Promise<any> => localRouter().streamAiChatTurn(input);

/** Redirecting HOME for an isolated account also hides the user's git, npm,
 * gh, docker and gpg configuration from the agent's tools. For a harness whose
 * profile root IS `HOME`, point those tools back at the real home (catalog
 * HOME_REDIRECT_ENV_DEFAULTS, narrowed by `profileEnvPassthrough`). A variable
 * the caller already exports wins, and `null` defaults (SSH_AUTH_SOCK, …) only
 * ever pass the caller's value through, which process.env inheritance does. */
export function homeRedirectEnvironment(
  harness: AiLocalHarnessDefinition, base: Readonly<Record<string, string>>,
  deps: { home: string; env?: NodeJS.ProcessEnv; exists: (path: string) => boolean },
): Record<string, string> {
  if (harness.profileEnv !== 'HOME' || base.HOME === undefined || base.HOME === deps.home) return { ...base };
  const defaults = withoutRuntime((router) => router.HOME_REDIRECT_ENV_DEFAULTS, () => ({} as Readonly<Record<string, string | null>>));
  const environment = deps.env ?? process.env;
  const result: Record<string, string> = { ...base };
  for (const name of harness.profileEnvPassthrough ?? Object.keys(defaults)) {
    if (result[name] !== undefined || environment[name]) continue;
    const target = defaults[name];
    if (typeof target !== 'string') continue;
    const path = target.startsWith('~/') ? `${deps.home.replace(/[\\/]$/, '')}/${target.slice(2)}` : target;
    if (deps.exists(path)) result[name] = path;
  }
  return result;
}
