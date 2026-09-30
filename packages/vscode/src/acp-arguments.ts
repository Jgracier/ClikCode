/** Preserve launch arguments exactly as entered in the VS Code dialog. */
export function parseAcpArguments(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch { throw new Error('Enter ACP arguments as a JSON array, for example ["--stdio", "--config", "two words"].'); }
  if (!Array.isArray(parsed) || !parsed.every((arg) => typeof arg === 'string')) {
    throw new Error('ACP arguments must be a JSON array of strings.');
  }
  return parsed;
}
