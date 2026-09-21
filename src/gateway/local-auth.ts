/**
 * The on-disk gateway credential, under ClikCode's own config home.
 *
 * Writes only ever land in ~/.config/clikcode (and ~/.clikcode/api-key). Reads
 * fall back to the pre-split ClikDeploy locations so an existing login keeps
 * working; the first write after that migrates it.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

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

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

function getCanonicalAuthPaths(): { authJsonPath: string; apiKeyPath: string } {
  const authJsonPath = path.join(resolveConfigHome(), 'clikcode', 'auth.json');
  const apiKeyPath = path.join(os.homedir(), '.clikcode', 'api-key');
  return { authJsonPath, apiKeyPath };
}

/** Read-only migration source: where the ClikDeploy CLI kept the same credential. */
function getLegacyAuthPaths(): { authJsonPath: string; apiKeyPath: string } {
  return {
    authJsonPath: path.join(resolveConfigHome(), 'clikdeploy', 'auth.json'),
    apiKeyPath: path.join(os.homedir(), '.clikdeploy', 'api-key'),
  };
}

export function readCanonicalAuth(): CanonicalAuthRecord | null {
  return readAuthFrom(getCanonicalAuthPaths()) ?? readAuthFrom(getLegacyAuthPaths());
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
  } catch {
    // fall through to key file read
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
  } catch {
    // ignore
  }

  return null;
}

export function writeCanonicalAuth(record: CanonicalAuthRecord): void {
  const { authJsonPath, apiKeyPath } = getCanonicalAuthPaths();
  const authDir = path.dirname(authJsonPath);
  const keyDir = path.dirname(apiKeyPath);

  ensureDir(authDir);
  ensureDir(keyDir);

  fs.writeFileSync(
    authJsonPath,
    JSON.stringify(
      {
        apiUrl: record.apiUrl,
        apiKey: record.apiKey,
        updatedAt: record.updatedAt,
        ...(record.user !== undefined ? { user: record.user } : {}),
      },
      null,
      2
    ),
    { mode: 0o600 }
  );
  fs.writeFileSync(apiKeyPath, record.apiKey, { mode: 0o600 });
}

function clearCanonicalAuth(): void {
  const { authJsonPath, apiKeyPath } = getCanonicalAuthPaths();
  for (const p of [authJsonPath, apiKeyPath]) {
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {
      // ignore
    }
  }
}

