export function toCliErrorMessage(error: any): string {
  const raw =
    error?.response?.data?.error ??
    error?.response?.data?.message ??
    error?.message ??
    'Unknown error';

  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object') {
    const nested =
      (raw as any).message ||
      (raw as any).error ||
      (raw as any).code;
    if (typeof nested === 'string' && nested.trim()) return nested;
    try {
      return JSON.stringify(raw);
    } catch {
      return String(raw);
    }
  }
  return String(raw);
}
