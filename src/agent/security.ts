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
function realpathNearest(absolute: string): string {
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
    // The model must not be able to grant itself permissions.
    if (segments.includes('.clikcode') && /^settings(?:\..+)?\.json$/.test(name)) return 'ClikCode permission settings can only be changed by the user';
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

// ── shell command tiers ──────────────────────────────────────────────────────

type CommandTier = 'deny' | 'ask' | 'safe';
interface CommandClassification { tier: CommandTier; reason: string }

const ROOTISH = String.raw`(?:/|/\*|~|~/|~/\*|\$HOME|\$\{HOME\}|\$HOME/|\$HOME/\*|/(?:bin|boot|dev|etc|home|lib|lib64|opt|proc|root|sbin|sys|usr|var)/?\*?)`;
const RM_FLAGS = String.raw`(?:\s+(?:-[a-zA-Z]+|--[a-z-]+))*`;

const DENY_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: new RegExp(String.raw`\brm${RM_FLAGS}\s+(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)${RM_FLAGS}\s+(?:--\s+)?["']?${ROOTISH}["']?(?:\s|;|&|\||$)`), reason: 'recursive delete of a root, home or system directory' },
  { pattern: /\brm\b[^;&|]*--no-preserve-root/, reason: 'rm --no-preserve-root' },
  { pattern: /\bmkfs(?:\.[a-z0-9]+)?\b/, reason: 'formats a filesystem' },
  { pattern: /\bdd\b[^;&|]*\bof=\/dev\/(?!null\b|zero\b|stdout\b|stderr\b|fd\/|tty\b)/, reason: 'dd onto a block device' },
  { pattern: />\s*\/dev\/(?:sd[a-z]|nvme\d|hd[a-z]|vd[a-z]|mmcblk\d|disk\d)/, reason: 'redirects output onto a block device' },
  { pattern: /\b(?:wipefs|shred)\b[^;&|]*\/dev\//, reason: 'destroys a block device' },
  { pattern: /:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:[^}]*\}\s*;\s*:/, reason: 'fork bomb' },
  { pattern: /\b(\w+)\s*\(\s*\)\s*\{\s*\1\s*\|\s*\1\s*&\s*\}\s*;\s*\1\b/, reason: 'fork bomb' },
  { pattern: /\bchmod\s+(?:-[a-zA-Z]+\s+)*-R\s+(?:0?777|a\+rwx)\s+\/(?:\s|$)/, reason: 'recursive chmod of /' },
  { pattern: /\bchown\s+(?:-[a-zA-Z]+\s+)*-R\s+\S+\s+\/(?:\s|$)/, reason: 'recursive chown of /' },
];

const ASK_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /\b(?:curl|wget|fetch)\b[^;&]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/, reason: 'pipes a download into a shell' },
  { pattern: /\b(?:ba|z)?sh\s+<\(\s*(?:curl|wget)\b/, reason: 'runs a downloaded script' },
  { pattern: /\bsudo\b|\bsu\s+-|\bdoas\b/, reason: 'elevates privileges' },
  { pattern: /\bgit\s+push\b[^;&|]*(?:--force|-f\b)/, reason: 'force push' },
  { pattern: /\bgit\s+(?:reset\s+--hard|clean\s+-[a-zA-Z]*f)/, reason: 'discards uncommitted work' },
];

/** Read-only programs that are safe for auto mode with plain arguments. */
const SAFE_PROGRAMS = new Set([
  'ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'rg', 'grep', 'egrep', 'fgrep', 'find', 'file', 'stat', 'du', 'df',
  'echo', 'printf', 'date', 'whoami', 'uname', 'which', 'type', 'basename', 'dirname', 'realpath', 'readlink',
  'sort', 'uniq', 'cut', 'tr', 'nl', 'tree', 'diff', 'cmp', 'sha256sum', 'md5sum', 'true', 'test', 'git',
]);

const SAFE_GIT_SUBCOMMANDS = new Set([
  'status', 'diff', 'log', 'show', 'branch', 'rev-parse', 'ls-files', 'blame', 'describe', 'shortlog', 'remote',
  'tag', 'stash', 'grep', 'cat-file', 'merge-base', 'rev-list', 'ls-tree', 'whatchanged', 'reflog',
]);

/** Arguments that turn an otherwise read-only git subcommand into a mutation. */
const GIT_MUTATING_ARGS: Readonly<Record<string, RegExp>> = {
  branch: /^(?:-[dDmMcCf]|--delete|--move|--copy|--force|--set-upstream-to.*|-u|--unset-upstream|--edit-description)$/,
  remote: /^(?:add|remove|rm|rename|set-url|set-head|set-branches|prune|update)$/,
  tag: /^(?:-[adfsum]|--delete|--force|--annotate|--sign)$/,
  stash: /^(?:push|pop|apply|drop|clear|save|branch|create|store|-[a-zA-Z]+)$/,
  reflog: /^(?:expire|delete)$/,
};

const FIND_DANGEROUS = /^-(?:exec|execdir|ok|okdir|delete|fprint|fprintf|fls)$/;

/** Minimal POSIX-ish tokenizer. Returns undefined when the command uses any
 * construct whose effect cannot be decided statically (substitution,
 * redirection, globs to programs, backgrounding, ...). */
function tokenizeSimple(command: string): string[][] | undefined {
  if (/[`$<>(){}\n\r\\]|&(?!&)|(?<!&)&$|\|\||;;/.test(command.replace(/&&/g, ';'))) return undefined;
  const pipelines: string[][] = [];
  let tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let hasToken = false;
  const normalized = command.replace(/&&/g, ';');
  const pushToken = (): void => { if (hasToken) tokens.push(current); current = ''; hasToken = false; };
  const pushCommand = (): boolean => { pushToken(); if (!tokens.length) return false; pipelines.push(tokens); tokens = []; return true; };
  for (const char of normalized) {
    if (quote) { if (char === quote) quote = undefined; else current += char; continue; }
    if (char === '"' || char === "'") { quote = char; hasToken = true; continue; }
    if (char === ' ' || char === '\t') { pushToken(); continue; }
    if (char === ';' || char === '|') { if (!pushCommand()) return undefined; continue; }
    current += char; hasToken = true;
  }
  if (quote) return undefined;
  pushToken();
  if (tokens.length) pipelines.push(tokens);
  return pipelines.length ? pipelines : undefined;
}

function looksLikePath(token: string): boolean {
  return token.startsWith('/') || token.startsWith('~') || token.split('/').includes('..');
}

function simpleCommandIsSafe(tokens: string[], scope?: PathScope): string | undefined {
  const [program, ...args] = tokens;
  if (program.includes('=')) return 'sets an environment variable';
  if (program.includes('/')) return `${program} is invoked by path`;
  if (!SAFE_PROGRAMS.has(program)) return `${program} is not on the read-only allowlist`;
  for (const arg of args) {
    const value = arg.includes('=') && arg.startsWith('-') ? arg.slice(arg.indexOf('=') + 1) : arg;
    if (!looksLikePath(value)) continue;
    if (!scope) return `${arg} may point outside the workspace`;
    try {
      const resolved = resolvePath(value, scope);
      if (!resolved.confined) return `${arg} is outside the workspace`;
      if (readDenyReason(resolved, scope)) return `${arg} is a protected location`;
    } catch { return `${arg} could not be resolved`; }
  }
  if (program === 'find' && args.some((arg) => FIND_DANGEROUS.test(arg))) return 'find with an action that executes or deletes';
  if ((program === 'rg' || program === 'grep') && args.some((arg) => /^--pre(?:=|$)/.test(arg))) return 'rg --pre runs a program';
  if (program === 'sort' && args.some((arg) => /^(?:-o|--output)/.test(arg))) return 'sort -o writes a file';
  if (program === 'tree' && args.some((arg) => arg === '-o')) return 'tree -o writes a file';
  if (program === 'date' && args.some((arg) => /^(?:-s|--set)/.test(arg))) return 'date --set changes the clock';
  if (program === 'git') {
    const rest = [...args];
    while (rest.length && rest[0].startsWith('-')) {
      const flag = rest.shift()!;
      // -c and --exec-path can run arbitrary programs (core.pager, aliases).
      if (flag === '-c' || flag.startsWith('--exec-path') || flag.startsWith('--config-env')) return `git ${flag} can execute code`;
      if (flag === '-C' || flag === '--git-dir' || flag === '--work-tree') return `git ${flag} retargets the repository`;
    }
    const sub = rest.shift();
    if (!sub || !SAFE_GIT_SUBCOMMANDS.has(sub)) return `git ${sub ?? ''} is not read-only`.trim();
    const mutating = GIT_MUTATING_ARGS[sub];
    if (sub === 'stash' && rest.length === 0) return 'git stash modifies the working tree';
    if (mutating && rest.some((arg) => mutating.test(arg)) && !(sub === 'stash' && (rest[0] === 'list' || rest[0] === 'show'))) return `git ${sub} ${rest.join(' ')} mutates the repository`;
    if (rest.some((arg) => /^--(?:output|ext-diff|textconv)\b/.test(arg))) return 'git option that writes a file or runs a program';
  }
  return undefined;
}

/** deny → never runs, even in bypass. ask → needs a human. safe → read-only,
 * auto mode may run it. Anything not provably read-only is `ask`: test
 * runners, package scripts and build tools all execute project code. */
export function classifyCommand(command: string, scope?: PathScope): CommandClassification {
  const text = command.trim();
  if (!text) return { tier: 'deny', reason: 'empty command' };
  for (const { pattern, reason } of DENY_PATTERNS) if (pattern.test(text)) return { tier: 'deny', reason };
  for (const { pattern, reason } of ASK_PATTERNS) if (pattern.test(text)) return { tier: 'ask', reason };
  const pipelines = tokenizeSimple(text);
  if (!pipelines) return { tier: 'ask', reason: 'uses shell features that cannot be checked statically' };
  for (const tokens of pipelines) {
    const unsafe = simpleCommandIsSafe(tokens, scope);
    if (unsafe) return { tier: 'ask', reason: unsafe };
  }
  return { tier: 'safe', reason: 'read-only command' };
}

// ── environment scrubbing ────────────────────────────────────────────────────

const SCRUBBED_ENV_PATTERN = /(_KEY|_TOKEN|_SECRET|PASSWORD|CLIKDEPLOY_)/i;

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

/** Bounded, secret-masked tail for HarnessActivityEvent.output. */
export function eventOutputPreview(text: string): string[] | undefined {
  const trimmed = redactSecrets(text).replace(/\r?\n$/, '');
  if (!trimmed.trim()) return undefined;
  const lines = trimmed.split(/\r?\n/);
  const tail = lines.slice(-OUTPUT_CAPS.eventOutputLines).map((line) => line.length > OUTPUT_CAPS.eventLineChars ? `${line.slice(0, OUTPUT_CAPS.eventLineChars)}…` : line);
  return lines.length > tail.length ? [`… ${lines.length - tail.length} earlier line${lines.length - tail.length === 1 ? '' : 's'}`, ...tail] : tail;
}
