/** The one place configuration is read from the environment.
 *
 * Every read is recorded, so `clikapp config --explain` can list which
 * variables the app consults. Reading `process.env` anywhere else bypasses
 * that list. */
export const consulted = new Set<string>();

/** The variable's value; the fallback when it is unset or empty. */
export function readEnv(name: string): string | undefined;
export function readEnv(name: string, fallback: string): string;
export function readEnv(name: string, fallback?: string): string | undefined {
  consulted.add(name);
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}
