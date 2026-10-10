import { readEnv } from '../config/env.ts';

export function corsHeaders(): Record<string, string> {
  const origin = readEnv('CORS_ORIGIN', '*');
  return { 'access-control-allow-origin': origin, vary: 'origin' };
}
