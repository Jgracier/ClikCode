/** The shapes the connector runner works with: what ClikDeploy returns, where a browser stopped, what a vendor run reports. Data only. */
export type HumanKind = 'captcha' | 'mfa' | 'sms' | 'payment' | 'identity' | 'app-review' | 'app-registration' | 'vendor-contact' | 'decision' | 'retire' | 'worker-setup';
/** `reasonCode` says what the wall is, set by whoever read the page (keygrab, humanStepFor, qualify); a step ClikDeploy sent without one
 * gets its kind (planFor). The loop types walls from it alone (connector-loop.ts wallOf). */
export interface HumanStep { kind: HumanKind | 'retire'; url?: string; instructions?: string; reasonCode: string; prefill?: string[] }
export interface AgentCall { tool: string; args: Record<string, unknown> }
export type Next =
  | { kind: 'call'; task: string }
  | { kind: 'agent'; task: string; then?: string; call?: AgentCall; orElse?: AgentCall }
  | { kind: 'human'; task: string; humanStep: HumanStep; then?: string }
  | { kind: 'none'; task: string };
export interface OnboardResult {
  id: string; state: 'running' | 'needs-agent' | 'needs-human' | 'published' | 'blocked' | 'complete' | 'attention' | 'in-progress'; stage: string; route?: string | null; next: Next; reason: string; lease?: string;
  /** The connector's attention record, when ClikDeploy has one. */ attention?: unknown;
  /** One line per unit ClikDeploy ran, newest last. */ evidence?: string[];
}

/** Where a browser step stopped, as data. */
export interface StopInfo {
  kind: 'captcha' | 'mfa' | 'payment' | 'password' | 'unrecognized-client' | 'choice' | 'unknown';
  message: string; url: string; pageText: string; controls: string[]; screenshot?: string;
  /** Set when the browser work already knows this is a wall only a person clears (keygrab does). */ human?: HumanStep;
  /** What keygrab did, newest last. */ trail?: string[];
  /** How many browser actions keygrab took (the trail keeps only the last 30). */ actions?: number;
  /** Pages keygrab looked at (addresses, no query). */ visited?: string[];
  /** Menus and searches it read, each as `opener: item | item`. */ menus?: string[];
  /** The hidden tab was left open on the last page: `clikcode connectors resume <id>` reattaches to it. */ parked?: boolean;
  /** The vendor address keygrab started from. */ vendorUrl?: string;
  /** keygrab signed in to the vendor during the run. */ signedIn?: boolean;
}
export type DriveOutcome = ({ ok: true; note?: string; actions?: number; /** A recipe was recorded for the next run. */ recipe?: boolean } | { ok: false; stop: StopInfo }) & { agentCalls?: number };

/** ClikDeploy as the runner sees it. */
export interface DeployClient {
  withSignal?(signal: AbortSignal): DeployClient;
  /** Read-only: the vendors waiting for an agent and the task each one has. */
  waiting(): Promise<Array<{ id: string; reason: string; task: string }>>;
  batch(input: { ids?: string[]; limit?: number; parallel?: number }): Promise<{ results: OnboardResult[]; skipped: Array<{ id: string; why: string }> }>;
  onboard(id: string): Promise<OnboardResult>;
  report(input: { id: string; outcome: 'blocked' | 'retry' | 'done'; reason: string; retryAfterMs?: number; humanStep?: HumanStep }): Promise<void>;
  note(id: string, text: string): Promise<void>;
  tool(name: string, args: Record<string, unknown>): Promise<unknown>;
}
/** The browser as the runner sees it. */
export interface BrowserDriver {
  reuseCredential?(id: string): Promise<boolean | { problem: string }>;
  oauthConnect(id: string): Promise<DriveOutcome>;
  /** Whether a saved recipe could capture a key for this connector (the address is a hint taken from the task). */
  hasRecipe(id: string, url?: string): Promise<boolean>;
  captureKey(id: string, url?: string): Promise<DriveOutcome>;
  /** The generic key-capture policy (keygrab): sign in, find the key page, create and capture a key, record the recipe. */
  /** When the vendor may be tried again, if a captcha put it on a back-off. */
  backoff?(id: string): Promise<Date | undefined>;
  /** Starts the vendor's 6 hour back-off (after a captcha); returns when it ends. */
  recordBackoff?(id: string): Promise<Date>;
  /** A screen no rule knows: one bounded agent micro-task (the account_use and browser_use tools only) that gets the key or finishes consent and saves a recipe. Absent: the screen is handed on in a note. */
  agentTask?(id: string, stop: StopInfo, budget: { maxCalls: number; maxMs: number }): Promise<DriveOutcome>;
  /** Looks for the vendor's API reference with the browser (no model): the description file its documentation pages load. When one is found it is
   * stored as the connector's draft. `docsUrls` are pages that read like API documentation, for an agent to write from when no file exists. */
  findReference?(id: string, homepage: string): Promise<{ applied: boolean; note: string; docsUrls: string[] }>;
  /** Reads the vendor's rendered sign-up, pricing and developer pages (no model) and says whether a key needs a person, with the wall as a human step when it does. */
  qualify?(id: string): Promise<{ lane: 'auto' | 'dead' | 'research'; summary: string; human?: HumanStep }>;
  keygrab(id: string, url: string, budget: { maxMs: number; /** The task's other addresses (homepage, sign-up, docs): where to start if `url` is no web page. */ alternates?: string[] }): Promise<DriveOutcome>;
}

export interface RunnerOptions {
  ids?: string[]; limit?: number; parallel?: number;
  /** With `ids`: connect only. Each id is sent straight to the consent driver, never through onboarding (which refuses a connector already published to users and developers). */
  published?: boolean;
  /** Most actions per vendor (default 12). */ maxSteps?: number;
  /** Most time per vendor in ms (default 300000). */ maxMs?: number;
  /** Most tool calls the agent may make on one hand-off (default 25). */ agentCalls?: number;
  /** Time one agent hand-off may take, on top of maxMs: judgement work (a spec from docs, proof review) needs minutes, not the leftovers (default: what is left of maxMs). */ agentMs?: number;
  dryRun?: boolean;
  now?: () => number; sleep?: (ms: number) => Promise<void>;
  /** Where hand-off requests are written (default: a fresh temp directory). */ handoffDir?: () => Promise<string>;
  writeFile?: (path: string, text: string) => Promise<void>;
  log?: (line: string) => void;
  /** Told each action as it starts (the loop keeps the last one, to say where a vendor that ran out of time was). */
  onAction?: (line: string) => void;
  /** Told when an agent hand-off starts (true) and ends (false): its time is the agent's own budget, not the vendor's. */
  onAgent?: (running: boolean) => void;
}

export type VendorStatus = 'published' | 'blocked' | 'human' | 'handoff' | 'budget' | 'waiting' | 'error';
export interface VendorOutcome { id: string; status: VendorStatus; /** Runner steps (one onboard or browser job each). */ steps: number; /** Browser actions taken inside those steps (opens, clicks, fills, captures); the action trail below lists them. */ browserActions: number; stage: string; summary: string; actions: string[]; humanStep?: HumanStep; handoff?: { file?: string; request: HandoffRequest }; recorded?: string; attention?: { kind: string; owner: string };
  /** The command that reattaches to the parked hidden tab and carries on. */ resume?: string; /** Set when a captcha put this vendor on a back-off. */ backoffUntil?: string; /** A key was captured and a recipe was recorded for the next run. */ recipe?: boolean }
export interface HandoffRequest {
  id: string; why: string; /** The whole task text. */ task: string; url?: string; pageText?: string; controls?: string[]; screenshot?: string;
  call?: AgentCall; orElse?: AgentCall; attention?: unknown; /** The last 3 evidence lines. */ evidence?: string[];
  /** Deterministic spec work (the auth probe ended path-wrong or placement), not browser work. */ specFix?: boolean;
  /** Warm hand-off: the hidden tab is still open on `url`. `resume` reattaches to it; the rest is what keygrab knows so far. */
  vendorUrl?: string; trail?: string[]; visited?: string[]; menus?: string[]; narrowTask?: string; resume?: string;
}

/** The task kinds the runner knows. */
export type Plan =
  | { do: 'done'; status: 'published' | 'blocked' }
  | { do: 'wait'; ms: number }
  | { do: 'oauth' }
  | { do: 'tool'; call: AgentCall }
  | { do: 'capture'; url?: string; generic?: boolean; alternates?: string[] }
  | { do: 'report'; call: AgentCall }
  | { do: 'specfix'; why: string; call?: AgentCall }
  | { do: 'human'; humanStep: HumanStep }
  | { do: 'handoff'; why: string }
  /** ClikDeploy parked the vendor because no API reference was found, and the browser search has not been run for it: run it before the item stays parked. */
  | { do: 'reference'; homepage: string; why: string };

