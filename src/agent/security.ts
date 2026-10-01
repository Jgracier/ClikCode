/** Path confinement, deny lists, shell-command risk tiers, secret masking
 * and output caps. Everything here is pure or filesystem-read-only, and every
 * root (home, state dir, workspace) arrives through the context so tests
 * never touch the real home directory. */
import fs from 'node:fs';
import path from 'node:path';

export interface PathScope {
  cwd: string;
  addDirs: readonly string[];
  stateDir: string;
  homeDir: string;
}

export interface ResolvedPath {
  /** Absolute, normalized, as the model asked for it (symlinks NOT followed). */
  absolute: string;
  /** Where a write/read would really land once symlinks are followed. */
  real: string;
  /** True when `real` sits inside cwd or an added directory. */
  confined: boolean;
  /** The workspace root that contains it, when confined. */
  root?: string;
}

export class ConfinementError extends Error {
  readonly code = 'ERR_PATH_NOT_CONFINED';
}

function expandHome(input: string, homeDir: string): string {
  if (input === '~') return homeDir;
  if (input.startsWith('~/') || input.startsWith('~\\')) return path.join(homeDir, input.slice(2));
  return input;
}

/** realpath of the nearest existing ancestor, with the not-yet-existing tail
 * re-attached. This is what makes a symlinked directory inside the workspace
 * that points outside it resolve to its true, outside location even when the
 * final file does not exist yet. */
export function realpathNearest(absolute: string): string {
  let current = absolute;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(current);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      // A dangling symlink is ENOENT for realpath but still redirects a write.
      try {
        const link = fs.readlinkSync(current);
        current = path.resolve(path.dirname(current), link);
        continue;
      } catch { /* not a symlink */ }
      const parent = path.dirname(current);
      if (parent === current) return tail.length ? path.join(current, ...tail.reverse()) : current;
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function workspaceRoots(scope: Pick<PathScope, 'cwd' | 'addDirs'>): string[] {
  return [scope.cwd, ...scope.addDirs].map((dir) => realpathNearest(path.resolve(dir)));
}

export function resolvePath(input: string, scope: PathScope): ResolvedPath {
  if (typeof input !== 'string' || !input.trim()) throw new ConfinementError('A non-empty path is required');
  if (input.includes('\0')) throw new ConfinementError('Path contains a NUL byte');
  const absolute = path.resolve(scope.cwd, expandHome(input, scope.homeDir));
  const real = realpathNearest(absolute);
  const root = workspaceRoots(scope).find((candidate) => isInside(real, candidate));
  return { absolute, real, confined: root !== undefined, ...(root ? { root } : {}) };
}

const SHELL_RC_FILES = new Set([
  '.bashrc', '.bash_profile', '.bash_login', '.bash_logout', '.profile', '.zshrc', '.zshenv', '.zprofile', '.zlogin',
  '.kshrc', '.cshrc', '.tcshrc', '.inputrc', '.gitconfig', '.npmrc', '.netrc',
]);

/** Agent settings files, by the folder they sit in, whose contents run
 * commands (hooks, MCP servers) or grant permissions: Claude Code's (whose
 * hooks ClikCode's own agent runs, hooks.ts) and those of the harnesses
 * ClikCode fronts. `.mcp.json` is refused wherever it is. */
const AGENT_CONFIG_FILES: Readonly<Record<string, RegExp>> = {
  '.claude': /^settings(?:\..+)?\.json$/,
  '.gemini': /^settings\.json$/,
  '.qwen': /^settings\.json$/,
  '.codex': /^config\.toml$/,
  '.cursor': /^(?:mcp|hooks|cli)\.json$/,
};

/** Why a write to this location is refused in every mode, or undefined. */
export function writeDenyReason(resolved: ResolvedPath, scope: PathScope): string | undefined {
  for (const candidate of new Set([resolved.real, resolved.absolute])) {
    const segments = candidate.split(path.sep);
    if (segments.includes('.git')) return 'writes inside .git are never allowed; use git commands instead';
    const home = realpathNearest(path.resolve(scope.homeDir));
    for (const dir of ['.ssh', '.gnupg', '.aws', '.kube', path.join('.config', 'gcloud'), path.join('.config', 'gh')]) {
      if (isInside(candidate, path.join(home, dir))) return `writes under ~/${dir} are never allowed`;
    }
    if (isInside(candidate, realpathNearest(path.resolve(scope.stateDir)))) return 'the ClikCode state directory is managed by ClikCode itself';
    const name = path.basename(candidate);
    // The model must not be able to grant itself permissions, or write a
    // command that ClikCode or a harness it fronts runs without asking.
    if (segments.includes('.clikcode') && /^settings(?:\..+)?\.json$/.test(name)) return 'ClikCode permission settings can only be changed by the user';
    const config = AGENT_CONFIG_FILES[path.basename(path.dirname(candidate))];
    if ((config && config.test(name)) || name === '.mcp.json') return `${path.join(path.basename(path.dirname(candidate)), name)} declares hooks, permissions or MCP servers, and can only be changed by the user`;
    const inHomeRoot = path.dirname(candidate) === home;
    if (inHomeRoot && SHELL_RC_FILES.has(name) && !resolved.confined) return `${name} is a shell/credential startup file outside the workspace`;
    if (isInside(candidate, path.join(home, '.config', 'fish')) && !resolved.confined) return 'fish shell configuration is outside the workspace';
  }
  return undefined;
}

/** Locations whose CONTENT must never reach a model: private keys and the
 * harness's own credential store. */
export function readDenyReason(resolved: ResolvedPath, scope: PathScope): string | undefined {
  const home = realpathNearest(path.resolve(scope.homeDir));
  for (const candidate of new Set([resolved.real, resolved.absolute])) {
    for (const dir of ['.ssh', '.gnupg', '.aws']) {
      if (isInside(candidate, path.join(home, dir))) return `reading ~/${dir} is never allowed`;
    }
    const state = realpathNearest(path.resolve(scope.stateDir));
    if (isInside(candidate, state) && !isToolOutputSpill(candidate, state)) return 'the ClikCode state directory is private to ClikCode';
  }
  return undefined;
}

/** `<stateDir>/sessions/<id>/tool-output/*` holds full command output the
 * harness itself spilled for the model to page through; it is the one part of
 * the state directory a read tool may open. */
export function toolOutputDir(stateDir: string, sessionId: string): string {
  return path.join(stateDir, 'sessions', sessionId, 'tool-output');
}

function isToolOutputSpill(candidate: string, realStateDir: string): boolean {
  const parts = path.relative(realStateDir, candidate).split(path.sep);
  return parts.length === 4 && parts[0] === 'sessions' && parts[2] === 'tool-output';
}

// ── environment scrubbing ────────────────────────────────────────────────────

const SCRUBBED_ENV_PATTERN = /(_KEY|_TOKEN|_SECRET|PASSWORD|CLIKCODE_)/i;

export function scrubEnvironment(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || SCRUBBED_ENV_PATTERN.test(key)) continue;
    out[key] = value;
  }
  return out;
}

// ── secret masking ───────────────────────────────────────────────────────────
// Same two-pass approach as packages/core/src/log-redaction.ts (value shapes
// first, then secret-shaped assignments — the order is load-bearing there for
// PEM bodies). The CLI cannot import core, and the assignment pass reuses the
// env-scrub name rule above rather than defining a second keyword vocabulary.

const MASK = '[REDACTED]';
const URL_CREDENTIAL_RE = /(\b[a-z][a-z0-9+.-]*:\/\/)([^:@/\s]+):([^@/\s]+)@/gi;
const VALUE_SHAPES: readonly RegExp[] = [
  /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abdeoprs]-[A-Za-z0-9-]{10,}\b/g,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}\b/g,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{24,}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\b(Bearer)\s+[A-Za-z0-9._~+/-]{20,}=*/g,
];
const ASSIGNMENT_RE = /("?\b[A-Za-z0-9_.-]*(?:[-_.]KEY|[-_.]?TOKEN|[-_.]?SECRET|PASSWORD|PASSWD)[A-Za-z0-9_.-]*"?\s*[:=]\s*)("[^"]*"|'[^']*'|[^,\s}]+)/gi;

export function redactSecrets(text: string): string {
  let out = String(text ?? '');
  if (out.includes('@')) out = out.replace(URL_CREDENTIAL_RE, (_match, scheme: string, user: string) => `${scheme}${user}:${MASK}@`);
  for (const shape of VALUE_SHAPES) out = out.replace(shape, (match, bearer?: unknown) => typeof bearer === 'string' && match.startsWith('Bearer') ? `Bearer ${MASK}` : MASK);
  return out.replace(ASSIGNMENT_RE, (_match, head: string) => `${head}${MASK}`);
}

// ── output caps ──────────────────────────────────────────────────────────────

export const OUTPUT_CAPS = {
  /** Tool output returned to the model. */
  toolOutputBytes: 30 * 1024,
  /** Lines of output attached to an activity event. */
  eventOutputLines: 8,
  eventLineChars: 240,
  /** Approval detail strings. */
  approvalDetailChars: 6000,
  readFileLines: 2000,
  readFileLineChars: 2000,
  webFetchBytes: 10 * 1024 * 1024,
  webFetchTextChars: 60_000,
  spillFileBytes: 64 * 1024 * 1024,
} as const;

/** Keep the head and the tail, which is where commands put their banner and
 * their verdict; drop the middle with an explicit marker. */
export function capHeadTail(text: string, maxBytes: number = OUTPUT_CAPS.toolOutputBytes, note?: string): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false };
  const half = Math.floor(maxBytes / 2);
  const buffer = Buffer.from(text, 'utf8');
  const head = buffer.subarray(0, half).toString('utf8').replace(/�$/, '');
  const tail = buffer.subarray(buffer.length - half).toString('utf8').replace(/^�/, '');
  const dropped = buffer.length - half * 2;
  return { text: `${head}\n\n… [${dropped} bytes truncated${note ? `; ${note}` : ''}] …\n\n${tail}`, truncated: true };
}

/** Bounded, secret-masked tail for HarnessActivityEvent.output: the newest
 * lines, with the count of earlier ones for the renderer to report. */
export function eventOutputPreview(text: string): { output: string[]; outputOmitted?: number; outputTail: true } | undefined {
  const trimmed = redactSecrets(text).replace(/\r?\n$/, '');
  if (!trimmed.trim()) return undefined;
  const lines = trimmed.split(/\r?\n/);
  const tail = lines.slice(-OUTPUT_CAPS.eventOutputLines).map((line) => line.length > OUTPUT_CAPS.eventLineChars ? `${line.slice(0, OUTPUT_CAPS.eventLineChars)}…` : line);
  return { output: tail, ...(lines.length > tail.length ? { outputOmitted: lines.length - tail.length } : {}), outputTail: true };
}
