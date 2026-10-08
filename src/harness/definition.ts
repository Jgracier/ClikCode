/** What a harness is: the declared shape every vendor CLI is described by,
 * and the router runtime that reads it. One canonical definition, so a
 * per-vendor fact is always a field here and never a name in a branch. */

import type { UsageLearning } from './accounts/usage-learning.js';

/** The catalog's own vocabulary (packages/clikrouter/src/ai-local-harness.ts),
 * type-only: erased at build, so the catalog bundle still loads lazily. */
import type {
  AiCustomAcpHarnessInput, AiHarnessAcpLaunch, AiHarnessAuthKind, AiHarnessCapabilityManifest, AiHarnessIntegrationLevel,
  AiHarnessPermissionMode, AiHarnessTransport, AiHarnessTurnDefinition, AiKeyProvider, AiKeyProviderId, AiLocalHarnessDefinition,
} from '@clikcode/router/ai-local-harness';
export type {
  AiCustomAcpHarnessInput, AiHarnessAcpDefinition, AiHarnessAcpLaunch, AiHarnessAuthKind, AiHarnessCapabilityManifest, AiHarnessInstallStep,
  AiHarnessInstaller, AiHarnessIntegrationLevel, AiHarnessKeyRoute, AiHarnessOptionDefinition, AiHarnessPermissionMode, AiHarnessTransport,
  AiKeyProvider, AiKeyProviderId, AiLocalHarnessDefinition,
} from '@clikcode/router/ai-local-harness';

/** ClikCode's own, not the catalog's: where a conversation runs, ClikCode
 * Local included, and the account record with the state it keeps. */
export type AiHarnessRoute = 'local' | 'gateway' | 'clikcode-local';

export interface AiHarnessAccount {
  id: string;
  provider: string;
  label: string;
  authKind: AiHarnessAuthKind;
  models: string[];
  status: 'ready' | 'needs_login' | 'offline';
  quotaState?: 'available' | 'exhausted';
  /** When the vendor refused a turn for quota -- the moment `quotaState` was
   * set to 'exhausted'. A usage reading taken after this that shows room
   * overrides the mark; one taken before it says nothing about it. */
  quotaExhaustedAt?: string;
  /** When the refusal stops holding on its own: the vendor's own "resets in"
   * hint when the refusal carried one, else a default window. See
   * quotaMarkExpiresAt in usage-reading.ts. */
  quotaRetryAt?: string;
  /** Spent windows (`name@resetsAt`) the vendor served a turn through anyway:
   * its reading for them is wrong -- Claude's /usage kept "weekly 100%" after
   * the user reset the limit -- so they are not believed until a refusal or
   * a reading of a different window. */
  disprovenWindows?: string[];
  /** The vendor signed this account in but will not serve it until the user
   * verifies it (e.g. Google's "Verify your account"). A fact about the
   * account, cleared by a turn that succeeds or by the user saying it is done. */
  verification?: { url?: string; at: string };
  /** When the vendor last signed this account in. A live vendor child holds
   * the credentials it started with, so this is part of what makes a child
   * reusable: a sign-out and sign-in starts a fresh one. */
  signedInAt?: string;
  credentialRef: string;
  /** Last usage reading for this account, shared across every terminal.
   * The figure belongs to the account, not to one chat, so caching it per
   * process meant the cost of displaying it scaled with the number of open
   * terminals -- which is what rate-limited the account out of reading its
   * own usage. */
  usage?: { at: string; label?: string; failed?: boolean };
  /** When any ClikCode process last asked the harness for this account's
   * usage, answered or not (USAGE_RECHECK_MS). On the record, so every open
   * chat and window share one clock instead of each asking on its own. */
  usageCheckedAt?: string;
  /** The vendor's own name for this account's plan ("Free", "KIRO FREE",
   * "free_limited_copilot", "plus"), as its usage reading last said, and the
   * models that plan runs when the vendor names them (Cursor: Auto only).
   * See free-plan.ts. */
  plan?: { name: string; models?: string[] };
  /** What this account's vendor has shown about its limit, for a harness
   *  that reports no usage of its own -- see usage-learning.ts. */
  usageLearning?: UsageLearning;
  nativeProfile?: {
    env: string;
    path: string;
    /** Static env vars a specific harness's isolation needs beyond the one
     * profile-root variable -- currently only Antigravity CLI, whose
     * per-account isolation depends on Application Default Credentials
     * (a real file under the isolated HOME) rather than its own default
     * keyring-based auth, which ignores HOME entirely and would otherwise
     * silently collapse every isolated account back into one shared
     * identity. Optional and unused by every other harness. */
    extraEnv?: Readonly<Record<string, string>>;
  };
}

export interface AiRouterRuntime {
  streamAiChatTurn(input: Record<string, unknown>): Promise<any>;
  AI_LOCAL_HARNESS_ADAPTER_VERSION: number;
  AI_LOCAL_HARNESSES: readonly AiLocalHarnessDefinition[];
  KEY_PROVIDERS: Readonly<Record<AiKeyProviderId, AiKeyProvider>>;
  /** A provider row when this id is a model API that can be addressed
   *  directly, undefined when it merely names a tool (see catalog.ts). */
  getAiProvider(id: string): { id: string; envKey?: string } | undefined;
  localHarnessForCommand(command: string): AiLocalHarnessDefinition | undefined;
  localHarnessForProvider(provider: string): AiLocalHarnessDefinition | undefined;
  localHarnessCapabilityManifest(harness: AiLocalHarnessDefinition): AiHarnessCapabilityManifest;
  harnessSupportsEffort(harness: AiLocalHarnessDefinition): boolean;
  harnessSupportsModelSelection(harness: AiLocalHarnessDefinition): boolean;
  harnessSupportsPermissionMode(harness: AiLocalHarnessDefinition, mode: AiHarnessPermissionMode): boolean;
  harnessSupportsImages(harness: AiLocalHarnessDefinition): boolean;
  harnessIntegrationLevel(harness: AiLocalHarnessDefinition): AiHarnessIntegrationLevel;
  nativeHarnessTurnArgv(harness: AiLocalHarnessDefinition, input: {
    prompt: string; nativeSessionId?: string; createdHere?: boolean;
    model?: string | null; workspace?: string | null; effort?: string | null;
    permissionMode?: AiHarnessPermissionMode;
    images?: readonly string[];
    options?: Readonly<Record<string, unknown>>;
  }): string[];
  maxPromptArgvBytes: number;
  HOME_REDIRECT_ENV_DEFAULTS: Readonly<Record<string, string | null>>;
  allLocalHarnesses(): readonly AiLocalHarnessDefinition[];
  registerCustomHarnesses(definitions: readonly AiLocalHarnessDefinition[]): readonly AiLocalHarnessDefinition[];
  customAcpHarness(definition: AiCustomAcpHarnessInput): AiLocalHarnessDefinition;
  harnessLoginArgvForModel(harness: AiLocalHarnessDefinition, model: string | null | undefined): readonly string[] | undefined;
  harnessReplyError(harness: AiLocalHarnessDefinition, text: string): { notice: string; statusCode?: number; withoutNotice?: string } | undefined;
  modelProvider(harness: AiLocalHarnessDefinition, model: string): string | undefined;
  modelDisplayId(harness: AiLocalHarnessDefinition, model: string): string;
  modelIdFromDisplay(harness: AiLocalHarnessDefinition, typed: string): string;
  harnessAcpLaunch(harness: AiLocalHarnessDefinition, input?: { model?: string | null; effort?: string | null; permissionMode?: AiHarnessPermissionMode }): AiHarnessAcpLaunch | undefined;
  harnessTurnTransport(harness: AiLocalHarnessDefinition): AiHarnessTransport;
  harnessCanRunTurns(harness: AiLocalHarnessDefinition): boolean;
  harnessTierRank(harness: AiLocalHarnessDefinition): number;
  guardedPromptArgv(turn: Pick<AiHarnessTurnDefinition, 'promptGuard' | 'promptArgvPrefix'>, prompt: string): string[];
  promptExceedsArgvLimit(harness: AiLocalHarnessDefinition, prompt: string): boolean;
}

/** A provider the harness can reach but is not signed in to: the picker
 * offers `argv` (a vendor sign-in command) instead of models. Only
 * multi-provider harnesses publish these. Signing in runs `argv` on
 * ClikCode's own screen, like any sign-in. */
export type ModelCatalogConnect = { id: string; label: string; detail?: string; argv: readonly string[] };
export type ModelCatalogResult = {
  configured?: string;
  models: string[];
  labels?: Readonly<Record<string, string>>;
  /** Models the vendor's own list marks free (Kilo's `isFree`, OpenCode's
   * zero price); `:free` ids are free without being listed here. */
  free?: string[];
  connect?: readonly ModelCatalogConnect[];
  /** The reasoning levels the agent's own ACP session offers for its
   * `acp.effortConfigId` option (Goose), where it has no effort flag. */
  effortValues?: string[];
  /** Hardware-fit model configurations exposed by Hermes local runtimes. */
  localRecommendations?: readonly { id: string; label: string; detail: string }[];
};

export type NativeUsageProbe = (environment: Readonly<Record<string, string>>) => Promise<string | undefined>;
