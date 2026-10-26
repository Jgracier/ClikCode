/** What the user may change while a turn runs, as the running turn reads it.
 *
 * The conversation's session worker owns one. The settings come to it as a
 * `settings-changed` command from whichever window changed them (which also
 * persists them in the state file); the turn reads this object and never the
 * state file. Seeded from the conversation as the turn starts, so a change
 * made while no turn ran is already in it. */
import type { AiHarnessPermissionMode } from '../harness/definition.js';
import { lifecycle } from '../runtime/lifecycle-log.js';
import type { HarnessSession } from '../session/model.js';

export interface LiveSettingsFields {
  nativeHarness?: string;
  route?: HarnessSession['route'];
  model?: string | null;
  effort?: string;
  speed?: 'fast' | undefined;
  permissionMode?: AiHarnessPermissionMode | undefined;
  /** The account the next model call should run on. Absent means unchanged. */
  accountId?: string | null;
  /** `off` is explicit; absent or anything else is the workspace sandbox. */
  sandbox?: HarnessSession['sandbox'];
  /** Plan mode on the chat itself. `undefined` is off. */
  planMode?: boolean;
}

type Source = Pick<HarnessSession, 'route' | 'nativeHarness' | 'model' | 'effort' | 'speed' | 'permissionMode' | 'accountId' | 'sandbox' | 'planMode'>;

export class LiveSettings {
  private readonly listeners = new Set<(changes: LiveSettingsFields) => void>();
  private current: Required<Pick<LiveSettingsFields, 'route'>> & LiveSettingsFields;

  constructor(session: Source) {
    this.current = pick(session);
  }

  /** A turn is starting from this conversation as stored now. */
  seed(session: Source): void {
    this.current = pick(session);
  }

  /** Fields that changed (an absent key is unchanged; `undefined` is a value). */
  apply(changes: LiveSettingsFields): void {
    const before = this.current;
    const next = { ...this.current, ...changes } as typeof this.current;
    const changed = (Object.keys(changes) as (keyof LiveSettingsFields)[]).filter((key) => before[key] !== next[key]);
    this.current = next;
    if (!changed.length) return;
    for (const listener of this.listeners) listener(changes);
    const account = changed.includes('accountId') && next.accountId ? String(next.accountId).slice(0, 8) : undefined;
    lifecycle('turn.settings', {
      changed: changed.join(','),
      ...(changed.includes('route') ? { route: next.route } : {}),
      ...(changed.includes('model') ? { model: next.model } : {}),
      ...(changed.includes('effort') ? { effort: next.effort } : {}),
      ...(changed.includes('speed') ? { speed: next.speed ?? 'off' } : {}),
      ...(changed.includes('permissionMode') ? { permission: next.permissionMode } : {}),
      ...(changed.includes('sandbox') ? { sandbox: next.sandbox ?? 'workspace' } : {}),
      ...(changed.includes('planMode') ? { plan: next.planMode === true } : {}),
      ...(account ? { account } : {}),
    });
  }

  get route(): HarnessSession['route'] { return this.current.route; }
  get nativeHarness(): string | undefined { return this.current.nativeHarness; }
  subscribe(listener: (changes: LiveSettingsFields) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  get model(): string | null | undefined { return this.current.model; }
  get effort(): string | undefined { return this.current.effort; }
  get speed(): 'fast' | undefined { return this.current.speed; }
  get permissionMode(): AiHarnessPermissionMode | undefined { return this.current.permissionMode; }
  get accountId(): string | null | undefined { return this.current.accountId; }
  get sandbox(): HarnessSession['sandbox'] { return this.current.sandbox; }
  get planMode(): boolean | undefined { return this.current.planMode; }
}

/** The running turn should stop and continue on what the user just chose.
 * A different route, or an account of another provider, is that choice.
 * Another account of this provider is not: the next attempt runs as that account. */
export function liveCallsForSwitch(
  live: LiveSettings | undefined,
  here: { route?: string; nativeHarness?: string; accountId?: string | null; accountProvider?: string },
  accounts: readonly { id: string; provider: string }[],
): boolean {
  if (!live) return false;
  if (live.nativeHarness !== undefined && here.nativeHarness !== undefined && live.nativeHarness !== here.nativeHarness) return true;
  if (live.route !== undefined && here.route !== undefined && live.route !== here.route) return true;
  const id = live.accountId;
  if (!id || id === here.accountId) return false;
  const next = accounts.find((item) => item.id === id);
  return !next || next.provider !== here.accountProvider;
}

function pick(session: Source): Required<Pick<LiveSettingsFields, 'route'>> & LiveSettingsFields {
  return {
    route: session.route, nativeHarness: session.nativeHarness, model: session.model, effort: session.effort, speed: session.speed,
    permissionMode: session.permissionMode, accountId: session.accountId, sandbox: session.sandbox,
    planMode: session.planMode,
  };
}

/** The fields a window sends the worker after it changed settings. */
export function liveSettingsOf(session: Source): LiveSettingsFields {
  return pick(session);
}
