export function corsHeaders(): Record<string, string> {
  const origin = process.env['CORS_ORIGIN'] || '*';
  return { 'access-control-allow-origin': origin, vary: 'origin' };
}
