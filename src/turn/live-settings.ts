/** What the user may change while a turn runs, as the running turn reads it.
 *
 * The conversation's session worker owns one. The settings come to it as a
 * `settings-changed` command from whichever window changed them (which also
 * persists them in the state file); the turn reads this object and never the
 * state file. Seeded from the conversation as the turn starts, so a change
 * made while no turn ran is already in it. */
import type { AiHarnessPermissionMode } from '../harness/definition.js';
import type { HarnessSession } from '../session/model.js';

export interface LiveSettingsFields {
  route?: HarnessSession['route'];
  model?: string | null;
  effort?: string;
  speed?: 'fast' | undefined;
  permissionMode?: AiHarnessPermissionMode | undefined;
}

type Source = Pick<HarnessSession, 'route' | 'model' | 'effort' | 'speed' | 'permissionMode'>;

export class LiveSettings {
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
    this.current = { ...this.current, ...changes } as typeof this.current;
  }

  get route(): HarnessSession['route'] { return this.current.route; }
  get model(): string | null | undefined { return this.current.model; }
  get effort(): string | undefined { return this.current.effort; }
  get speed(): 'fast' | undefined { return this.current.speed; }
  get permissionMode(): AiHarnessPermissionMode | undefined { return this.current.permissionMode; }
}

function pick(session: Source): Required<Pick<LiveSettingsFields, 'route'>> & LiveSettingsFields {
  return { route: session.route, model: session.model, effort: session.effort, speed: session.speed, permissionMode: session.permissionMode };
}

/** The fields a window sends the worker after it changed settings. */
export function liveSettingsOf(session: Source): LiveSettingsFields {
  return pick(session);
}
