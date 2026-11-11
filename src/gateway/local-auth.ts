/**
 * The gateway credential older versions kept on disk beside the config's
 * per-URL record: ~/.config/clikcode/auth.json and ~/.clikcode/api-key.
 * Read only, to move a key into that record (credentials.ts); nothing
 * writes these any more.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { swallowed } from '../runtime/lifecycle-log.js';

interface CanonicalAuthRecord {
  apiUrl: string;
  apiKey: string;
  updatedAt: string;
  user?: unknown;
}

function resolveConfigHome(): string {
  if (process.platform === 'win32') {
    return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  }
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

function getCanonicalAuthPaths(): { authJsonPath: string; apiKeyPath: string } {
  const authJsonPath = path.join(resolveConfigHome(), 'clikcode', 'auth.json');
  const apiKeyPath = path.join(os.homedir(), '.clikcode', 'api-key');
  return { authJsonPath, apiKeyPath };
}

export function readCanonicalAuth(): CanonicalAuthRecord | null {
  return readAuthFrom(getCanonicalAuthPaths());
}

function readAuthFrom({ authJsonPath, apiKeyPath }: { authJsonPath: string; apiKeyPath: string }): CanonicalAuthRecord | null {
  try {
    if (fs.existsSync(authJsonPath)) {
      const parsed = JSON.parse(fs.readFileSync(authJsonPath, 'utf8')) as Partial<CanonicalAuthRecord>;
      const apiUrl = String(parsed.apiUrl || '').trim();
      const apiKey = String(parsed.apiKey || '').trim();
      if (apiUrl && apiKey) {
        return {
          apiUrl,
          apiKey,
          updatedAt: String(parsed.updatedAt || new Date().toISOString()),
          ...(parsed.user !== undefined ? { user: parsed.user } : {}),
        };
      }
    }
  } catch (error) {
    // fall through to key file read
    swallowed('gateway/local-auth', error);
  }

  try {
    if (fs.existsSync(apiKeyPath)) {
      const apiKey = fs.readFileSync(apiKeyPath, 'utf8').trim();
      if (apiKey) {
        return {
          apiUrl: '',
          apiKey,
          updatedAt: new Date().toISOString(),
        };
      }
    }
  } catch (error) {
    // ignore
    swallowed('gateway/local-auth', error);
  }

  return null;
}
