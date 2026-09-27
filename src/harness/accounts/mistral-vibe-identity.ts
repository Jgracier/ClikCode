import { access, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { spawnPortable } from '../transport/spawn.js';
import { resolveBinaryPath } from '../transport/native/binary.js';

const IDENTITY_SCRIPT = String.raw`
import json, os, sys, urllib.request

profile = os.environ.get("VIBE_HOME")
key = None if profile else os.environ.get("MISTRAL_API_KEY")
if not key:
    paths = [os.path.join(profile, ".env")] if profile else [os.path.join(os.path.expanduser("~/.vibe"), ".env")]
    for path in paths:
        try:
            with open(path, encoding="utf-8") as env_file:
                for line in env_file:
                    line = line.strip()
                    if line.startswith("MISTRAL_API_KEY="):
                        key = line.split("=", 1)[1].strip().strip("\"'")
                        break
        except OSError:
            pass
        if key:
            break
if not key and not profile:
    try:
        import keyring
        key = keyring.get_password("ai.mistral.vibe", "MISTRAL_API_KEY")
    except Exception:
        key = None
if key:
    request = urllib.request.Request("https://api.mistral.ai/v1/users/me", headers={"Authorization": "Bearer " + key})
    try:
        with urllib.request.urlopen(request, timeout=8) as response:
            email = json.load(response).get("email")
        if isinstance(email, str) and email.strip():
            print(json.dumps({"email": email.strip()}))
    except Exception:
        pass
`;

const CAPTURE_SCRIPT = String.raw`
import os, pathlib, tempfile
key = None
profile = pathlib.Path(os.environ["VIBE_HOME"])
try:
    for line in (profile / ".env").read_text().splitlines():
        if line.startswith("MISTRAL_API_KEY="):
            key = line.split("=", 1)[1].strip().strip("\"'")
            break
except OSError:
    pass
try:
    if not key:
        import keyring
        key = keyring.get_password("ai.mistral.vibe", "MISTRAL_API_KEY")
except Exception:
    pass
if not key:
    key = os.environ.get("MISTRAL_API_KEY")
if not key:
    raise SystemExit(2)
profile.mkdir(mode=0o700, parents=True, exist_ok=True)
env_file = profile / ".env"
existing = env_file.read_text() if env_file.exists() else ""
lines = [line for line in existing.splitlines() if not line.startswith("MISTRAL_API_KEY=")]
lines.append("MISTRAL_API_KEY=" + repr(key))
fd, temporary = tempfile.mkstemp(dir=str(profile), prefix=".env.")
try:
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, "w") as output:
        output.write("\n".join(lines) + "\n")
    os.replace(temporary, env_file)
finally:
    if os.path.exists(temporary): os.unlink(temporary)
print('{"email":"__credential_captured__"}')
`;

function pythonExecutable(vibePath: string): string | undefined {
  const directory = dirname(vibePath);
  return join(directory, process.platform === 'win32' ? 'python.exe' : 'python');
}

async function runVibePython(script: string, profilePath?: string): Promise<string | undefined> {
  try {
    const binary = await resolveBinaryPath('vibe');
    if (!binary) return undefined;
    const python = pythonExecutable(await realpath(binary));
    if (!python) return undefined;
    await access(python);
    const result = await new Promise<string | undefined>((resolve) => {
      const child = spawnPortable(python, ['-c', script], {
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, ...(profilePath ? { VIBE_HOME: profilePath } : {}) },
      });
      let output = '';
      let settled = false;
      const finish = (value?: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        if (output.length < 4096) output += chunk;
      });
      child.once('error', () => finish());
      child.once('close', (code) => {
        if (code !== 0) return finish();
        try {
          const parsed = JSON.parse(output.trim()) as { email?: unknown };
          finish(typeof parsed.email === 'string' ? parsed.email : undefined);
        } catch { finish(); }
      });
      const timer = setTimeout(() => {
        child.kill();
        finish();
      }, 10_000);
      timer.unref();
    });
    return result;
  } catch {
    return undefined;
  }
}

export async function captureMistralVibeCredential(profilePath: string): Promise<boolean> {
  return (await runVibePython(CAPTURE_SCRIPT, profilePath)) === '__credential_captured__';
}

export async function mistralVibeAccountEmail(profilePath?: string): Promise<string | undefined> {
  return runVibePython(IDENTITY_SCRIPT, profilePath);
}
