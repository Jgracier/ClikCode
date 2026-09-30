/** The one shell-command classifier. The native agent's permission check
 * (may auto mode run this?) and the turn checkpoint (could this vendor
 * command have changed the workspace?) ask the same question, and they used
 * to answer it with two lists that disagreed -- each let through something
 * the other caught. A command is read-only here only when it is provably so;
 * anything unrecognised is not. */
import { readDenyReason, resolvePath, type PathScope } from './security.js';

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
  branch: /^(?:-[a-zA-Z]*[dDmMcCfu]|--delete|--move|--copy|--force|--set-upstream-to.*|--unset-upstream|--edit-description|--create-reflog|--track.*)$/,
  remote: /^(?:add|remove|rm|rename|set-url|set-head|set-branches|prune|update)$/,
  tag: /^(?:-[a-zA-Z]*[adfsum]|--delete|--force|--annotate|--sign|--local-user.*|--message.*|--file.*)$/,
  stash: /^(?:push|pop|apply|drop|clear|save|branch|create|store|-[a-zA-Z]+)$/,
  reflog: /^(?:expire|delete)$/,
};

/** Actions that execute a program or write a file. Anything else find does
 * only reads. */
const FIND_DANGEROUS = /^-(?:exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/;

/** Redirections that cannot change anything: discarding output, or joining
 * stderr to stdout. Dropped before tokenizing so `rg x 2>/dev/null` is still
 * judged by what it runs. */
const HARMLESS_REDIRECT = /\s*(?:\d?>>?\s*\/dev\/null\b|\d>&\d)/g;

/** Minimal POSIX-ish tokenizer. Returns undefined when the command uses any
 * construct whose effect cannot be decided statically (substitution,
 * redirection, globs to programs, backgrounding, ...). */
function tokenizeSimple(command: string): string[][] | undefined {
  const normalized = command.replace(HARMLESS_REDIRECT, '').replace(/&&/g, ';');
  if (/[`$<>(){}\n\r\\]|&|\|\||;;/.test(normalized)) return undefined;
  const pipelines: string[][] = [];
  let tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let hasToken = false;
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

/** A short-option cluster (`-uo`) or a long option that carries `letter`/`long`. */
function hasOption(args: readonly string[], letter: string, long?: RegExp): boolean {
  return args.some((arg) => (/^-[a-zA-Z0-9]+$/.test(arg) && arg.slice(1).includes(letter)) || (arg.startsWith(`-${letter}`) && !arg.startsWith('--')) || (long ? long.test(arg) : false));
}

function gitArgsAreSafe(args: string[]): string | undefined {
  const rest = [...args];
  while (rest.length && rest[0].startsWith('-')) {
    const flag = rest.shift()!;
    // -c and --exec-path can run arbitrary programs (core.pager, aliases).
    if (flag === '-c' || flag.startsWith('--exec-path') || flag.startsWith('--config-env')) return `git ${flag} can execute code`;
    if (flag === '-C' || flag.startsWith('--git-dir') || flag.startsWith('--work-tree') || flag.startsWith('--namespace')) return `git ${flag} retargets the repository`;
  }
  const sub = rest.shift();
  if (!sub || !SAFE_GIT_SUBCOMMANDS.has(sub)) return `git ${sub ?? ''} is not read-only`.trim();
  if (sub === 'stash' && (rest.length === 0 || !['list', 'show'].includes(rest[0]))) return 'git stash modifies the working tree';
  const mutating = GIT_MUTATING_ARGS[sub];
  if (mutating && sub !== 'stash' && rest.some((arg) => mutating.test(arg))) return `git ${sub} ${rest.join(' ')} mutates the repository`;
  // `git branch NAME` and `git tag NAME` create one; only listing is read-only.
  if ((sub === 'branch' || sub === 'tag') && !rest.some((arg) => /^(?:-l|--list)$/.test(arg)) && rest.some((arg) => !arg.startsWith('-'))) {
    return `git ${sub} ${rest.join(' ')} creates a ${sub}`;
  }
  if (rest.some((arg) => /^--(?:output|ext-diff|textconv|open-files-in-pager)\b/.test(arg))) return 'git option that writes a file or runs a program';
  if (sub === 'grep' && rest.some((arg) => /^-O/.test(arg))) return 'git grep -O runs a program';
  return undefined;
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
  switch (program) {
    case 'find': return args.some((arg) => FIND_DANGEROUS.test(arg)) ? 'find with an action that executes, writes or deletes' : undefined;
    case 'rg': return args.some((arg) => /^--(?:pre|hostname-bin)(?:=|$)/.test(arg)) ? `rg ${args.find((arg) => /^--(?:pre|hostname-bin)/.test(arg))} runs a program` : undefined;
    case 'sort': return hasOption(args, 'o', /^--(?:output|compress-program)/) ? 'sort writes a file or runs a program' : undefined;
    case 'tree': return hasOption(args, 'o') ? 'tree -o writes a file' : undefined;
    // `-I` takes its format glued on (`-Iseconds`), so it is not a cluster.
    case 'date': return hasOption(args.filter((arg) => !arg.startsWith('-I')), 's', /^--set/) ? 'date --set changes the clock' : undefined;
    case 'file': return hasOption(args, 'C', /^--compile/) ? 'file -C writes a compiled magic file' : undefined;
    // `uniq IN OUT` writes OUT.
    case 'uniq': return args.filter((arg) => !arg.startsWith('-')).length > 1 ? 'uniq with an output file writes it' : undefined;
    case 'git': return gitArgsAreSafe(args);
    default: return undefined;
  }
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

/** Whether a command a vendor reported running cannot have changed the
 * workspace. The same classifier, after unwrapping `/bin/bash -lc '...'`
 * (Codex wraps every command that way) and refusing a label the vendor
 * truncated, whose end cannot be seen. */
export function commandIsReadOnly(command: string, scope?: PathScope): boolean {
  let text = command.trim();
  const wrapped = /^(?:\S*\/)?(?:ba|z|da)?sh\s+-l?c\s+(['"])([\s\S]*)\1\s*$/.exec(text);
  if (wrapped) text = wrapped[2]!.trim();
  if (!text || /…|\.\.\.$/.test(text)) return false;
  return classifyCommand(text, scope).tier === 'safe';
}
