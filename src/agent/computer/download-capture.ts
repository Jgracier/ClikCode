/** Some keys exist only as a file the site hands over (a Google service-account
 * JSON, a private key, a credentials CSV): there is no text on the page and no
 * Copy button. The worker takes the download, reads it, and deletes the file, so
 * the content goes nowhere but into the Secrets Manager. */
import fs from 'node:fs/promises';
import type { Page } from 'playwright-core';

const MAX_BYTES = 256 * 1024;

export async function captureDownload(page: Page, trigger: (() => Promise<void>) | undefined, timeoutMs = 30_000): Promise<string | undefined> {
  const waiting = page.waitForEvent('download', { timeout: timeoutMs });
  waiting.catch(() => undefined); // a timeout is answered below, not as an unhandled rejection
  await trigger?.();
  let download;
  try { download = await waiting; } catch { return undefined; }
  try {
    const file = await download.path();
    if (!file) return undefined;
    const info = await fs.stat(file);
    if (info.size > MAX_BYTES) return undefined;
    return (await fs.readFile(file, 'utf8')).trim() || undefined;
  } finally {
    await download.delete().catch(() => undefined);
  }
}

/** A JSON credential file carries secrets in several of its fields, not only in the whole:
 * each long string inside is registered too, so quoting a piece of it is hidden as well. */
export function secretParts(content: string): string[] {
  try {
    const parts: string[] = [];
    const walk = (node: unknown): void => {
      if (typeof node === 'string') { if (node.length >= 24) parts.push(node); }
      else if (Array.isArray(node)) node.forEach(walk);
      else if (node && typeof node === 'object') Object.values(node).forEach(walk);
    };
    walk(JSON.parse(content));
    return parts;
  } catch { return []; }
}
