import { globalFlag } from './flags.js';

/**
 * Global `--debug` escape hatch. Opt-in only.
 *
 * When enabled, error rendering additionally surfaces stack traces, HTTP status
 * codes and raw response bodies that the friendly-by-default path collapses to a
 * single line. Honors the registered `--debug` option or CLIKCODE_DEBUG=1.
 */
export function isDebugMode(): boolean {
  if (globalFlag('debug')) return true;
  const env = String(process.env.CLIKCODE_DEBUG || '').trim().toLowerCase();
  return env === '1' || env === 'true' || env === 'yes';
}
