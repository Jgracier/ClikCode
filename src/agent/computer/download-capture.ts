/** Some keys exist only as a file the site hands over (a Google service-account
 * JSON, a private key, a credentials CSV): there is no text on the page and no
 * Copy button. If a download starts while a key is being captured, the worker
 * reads it and deletes the file, so its content goes nowhere but into the Secrets
 * Manager. Nothing has to be asked for: a download is simply noticed. */
import fs from 'node:fs/promises';
import type { Download, Page } from 'playwright-core';

const MAX_BYTES = 256 * 1024;

type DownloadWatch = { result(): Promise<string | undefined>; stop(): void };

export function watchDownload(page: Page): DownloadWatch {
  let reading: Promise<string | undefined> | undefined;
  const read = async (download: Download): Promise<string | undefined> => {
    try {
      const file = await download.path();
      if (!file) return undefined;
      const info = await fs.stat(file);
      if (info.size > MAX_BYTES) return undefined;
      return (await fs.readFile(file, 'utf8')).trim() || undefined;
    } catch { return undefined; }
    finally { await download.delete().catch(() => undefined); }
  };
  const onDownload = (download: Download): void => { reading ??= read(download); };
  page.on('download', onDownload);
  return {
    // Resolves with the file's text once a download has finished; undefined while there is none.
    result: async () => reading ? reading : undefined,
    stop: () => { page.off('download', onDownload); },
  };
}

/** Fields of a JSON credential file that are secrets in their own right (the private key, a client secret,
 * a token): quoting one on its own must be hidden too. Identifiers (private_key_id, client_email, project_id)
 * are public and stay readable, so the agent can tell which key is which. */
const SECRET_FIELD = /(?:private_key|secret|password|token|credential|api_?key)$/i;

export function secretParts(content: string): string[] {
  try {
    const parts: string[] = [];
    const walk = (node: unknown, field = ''): void => {
      if (typeof node === 'string') { if (node.length >= 16 && SECRET_FIELD.test(field)) parts.push(node); }
      else if (Array.isArray(node)) node.forEach(item => walk(item, field));
      else if (node && typeof node === 'object') for (const [key, child] of Object.entries(node)) walk(child, key);
    };
    walk(JSON.parse(content));
    return parts;
  } catch { return []; }
}
