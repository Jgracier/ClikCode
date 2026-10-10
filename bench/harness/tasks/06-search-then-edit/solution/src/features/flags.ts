import { readEnv } from '../config/env.ts';

/** FEATURES=a,b,c turns features on. */
export function enabledFeatures(): Set<string> {
  return new Set(readEnv('FEATURES', '').split(',').map((name) => name.trim()).filter(Boolean));
}

export function isEnabled(name: string): boolean {
  if (readEnv('FORCE_ALL_FEATURES') === '1') return true;
  return enabledFeatures().has(name);
}
