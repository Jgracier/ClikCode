const LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type Level = (typeof LEVELS)[number];

export function logLevel(): Level {
  const env = process.env;
  const wanted = (env.LOG_LEVEL || 'info').toLowerCase();
  return (LEVELS as readonly string[]).includes(wanted) ? (wanted as Level) : 'info';
}

export function shouldLog(level: Level): boolean {
  return LEVELS.indexOf(level) >= LEVELS.indexOf(logLevel());
}
