/** Named swarm configurations. A host conversation turns on one or many.
 * Many combine by taking the stricter cap, so `lean` plus `frugal` cannot
 * spend more than `frugal`. */

export interface SwarmPolicy {
  /** Configurations that produced this policy, in the order the user named them. */
  names: readonly string[];
  maxWorkers: number;
  maxParallel: number;
  /** Tokens a clerk may be briefed with, including the board slice. */
  maxBriefTokens: number;
  /** Tokens the shared board may hold. */
  maxBoardTokens: number;
  /** Tokens of one clerk's card that may re-enter the host. */
  maxCardTokens: number;
}

export interface SwarmPreset {
  id: string;
  label: string;
  detail: string;
  policy: Omit<SwarmPolicy, 'names'>;
}

export const SWARM_PRESETS: readonly SwarmPreset[] = [
  {
    id: 'lean',
    label: 'Lean',
    detail: 'Up to two clerks. The host plans and merges; clerks do the reading and edits.',
    policy: { maxWorkers: 2, maxParallel: 2, maxBriefTokens: 12000, maxBoardTokens: 400, maxCardTokens: 300 },
  },
  {
    id: 'frugal',
    label: 'Frugal',
    detail: 'One clerk at a time, with a shorter brief and a shorter card.',
    policy: { maxWorkers: 1, maxParallel: 1, maxBriefTokens: 6000, maxBoardTokens: 300, maxCardTokens: 200 },
  },
];

const PRESET_BY_ID = new Map(SWARM_PRESETS.map((preset) => [preset.id, preset]));

export function swarmPreset(id: string): SwarmPreset | undefined {
  return PRESET_BY_ID.get(id);
}

/** The strictest combination of the named presets. Unknown names are returned
 * separately so the caller can refuse them before anything is stored. */
export function resolveSwarm(names: readonly string[]): { policy?: SwarmPolicy; unknown: string[] } {
  const wanted = [...new Set(names.map((name) => name.trim().toLowerCase()).filter(Boolean))];
  const unknown = wanted.filter((name) => !PRESET_BY_ID.has(name));
  const presets = wanted.flatMap((name) => {
    const preset = PRESET_BY_ID.get(name);
    return preset ? [preset] : [];
  });
  if (!presets.length) return { unknown };
  const min = (field: keyof SwarmPreset['policy']): number => Math.min(...presets.map((preset) => preset.policy[field]));
  return {
    unknown,
    policy: {
      names: presets.map((preset) => preset.id),
      maxWorkers: min('maxWorkers'),
      maxParallel: min('maxParallel'),
      maxBriefTokens: min('maxBriefTokens'),
      maxBoardTokens: min('maxBoardTokens'),
      maxCardTokens: min('maxCardTokens'),
    },
  };
}
