/** Syntax highlighting for fenced code, shared by the terminal and the VS Code
 * webview: lines in, spans of one kind each out, colour left to the caller
 * (message-blocks.ts paints ANSI, the webview CSS classes from the theme).
 *
 * A small scanner rather than a highlighting library: the bundle carries no
 * runtime dependency it can avoid, and an answer's code needs comments,
 * strings, keywords, numbers, calls and types told apart -- not a grammar
 * per language. State (an open block comment or a multi-line string) carries
 * from line to line, and from earlier lines of the same fence (`before`), so
 * a fence retired a line at a time while it streams is coloured exactly as
 * the whole fence is. */

export type HighlightKind =
  | 'keyword' | 'string' | 'comment' | 'number' | 'constant' | 'function' | 'type'
  | 'property' | 'tag' | 'attribute' | 'inserted' | 'deleted' | 'meta';

export interface HighlightSpan { text: string; kind?: HighlightKind }

interface StringRule { open: string; close: string; multiline?: boolean; escape?: boolean }

interface Grammar {
  lineComments?: readonly string[];
  blockComments?: readonly (readonly [string, string])[];
  strings?: readonly StringRule[];
  keywords?: ReadonlySet<string>;
  constants?: ReadonlySet<string>;
  types?: ReadonlySet<string>;
  /** Capitalised names are types (C-like languages, Go, Rust, Swift). */
  capitalTypes?: boolean;
  /** Keywords match whatever their case (SQL). */
  caseless?: boolean;
  /** `@name` is an annotation or decorator. */
  decorators?: boolean;
  /** `$name` and `${...}` are variables (shell, PHP, Perl). */
  variables?: boolean;
  /** `key:` / `key =` at the start of a line is a key. */
  keys?: 'colon' | 'equals';
  /** A quoted string followed by `:` is a key (JSON). */
  stringKeys?: boolean;
  /** Identifiers may contain `-` (CSS, shell commands). */
  dashedNames?: boolean;
  markup?: boolean;
  diff?: boolean;
}

const words = (text: string): ReadonlySet<string> => new Set(text.split(/\s+/).filter(Boolean));

const C_STRINGS: readonly StringRule[] = [{ open: '"', close: '"', escape: true }, { open: "'", close: "'", escape: true }];
const SLASH_COMMENTS = { lineComments: ['//'], blockComments: [['/*', '*/']] as const };
const C_CONSTANTS = words('true false null nullptr nil undefined NaN Infinity this self super');

const JS: Grammar = {
  ...SLASH_COMMENTS,
  strings: [...C_STRINGS, { open: '`', close: '`', multiline: true, escape: true }],
  keywords: words(`abstract as async await break case catch class const continue debugger declare default delete do else enum export
    extends finally for from function get if implements import in infer instanceof interface is keyof let namespace new of override
    private protected public readonly return satisfies set static switch throw try type typeof var void while with yield`),
  constants: C_CONSTANTS,
  types: words('string number boolean bigint symbol object unknown never any void Array Promise Record Map Set Partial Readonly'),
  capitalTypes: true, decorators: true,
};

const PYTHON: Grammar = {
  lineComments: ['#'],
  strings: [
    { open: '"""', close: '"""', multiline: true, escape: true }, { open: "'''", close: "'''", multiline: true, escape: true },
    ...C_STRINGS,
  ],
  keywords: words(`and as assert async await break class continue def del elif else except finally for from global if import in is
    lambda match case nonlocal not or pass raise return try while with yield`),
  constants: words('True False None self cls'),
  types: words('int float str bool bytes list dict set tuple object type'),
  capitalTypes: true, decorators: true,
};

const C_LIKE: Grammar = {
  ...SLASH_COMMENTS,
  strings: [...C_STRINGS, { open: '`', close: '`', multiline: true }],
  keywords: words(`abstract as async await break case catch chan class const continue data default defer delegate do dyn else enum
    extends extern final finally fn for func fun go goto guard if impl implements import in init inline interface internal is let
    loop map match mod move mut namespace new object open operator override package private protected pub public range ref
    return sealed select static struct super switch sync synchronized throw throws trait try type typealias typedef union unsafe
    use using val var virtual volatile when where while yield #include #define #ifdef #ifndef #endif #pragma`),
  constants: C_CONSTANTS,
  types: words(`int long short char float double bool boolean void byte string String usize isize u8 u16 u32 u64 i8 i16 i32 i64 f32 f64
    str uint int8 int16 int32 int64 uint8 uint16 uint32 uint64 float32 float64 rune error any auto size_t Self Vec Option Result Box`),
  capitalTypes: true, decorators: true,
};

const RUBY: Grammar = {
  lineComments: ['#'],
  strings: [...C_STRINGS],
  keywords: words(`alias and begin break case class def defined? do else elsif end ensure for if in module next not or redo rescue retry
    return then undef unless until when while yield require attr_accessor attr_reader private protected`),
  constants: words('true false nil self'),
  capitalTypes: true,
};

const SHELL: Grammar = {
  lineComments: ['#'],
  strings: [{ open: '"', close: '"', multiline: true, escape: true }, { open: "'", close: "'", multiline: true }],
  keywords: words(`if then else elif fi for in do done while until case esac function return local export readonly declare set unset
    source alias exit break continue`),
  constants: words('true false'),
  variables: true, dashedNames: true,
};

const SQL: Grammar = {
  lineComments: ['--'],
  blockComments: [['/*', '*/']],
  strings: [{ open: "'", close: "'" }, { open: '"', close: '"' }],
  keywords: words(`select from where and or not insert into values update set delete create table index view drop alter add column
    primary key foreign references join left right inner outer full on as group by order having limit offset union all distinct
    case when then else end is null like in between exists returning with begin commit rollback transaction default unique if`),
  constants: words('true false null'),
  types: words('int integer bigint smallint text varchar char boolean bool date timestamp timestamptz numeric decimal real serial uuid jsonb json'),
  caseless: true,
};

const JSON_GRAMMAR: Grammar = { strings: [{ open: '"', close: '"', escape: true }], constants: words('true false null'), stringKeys: true, ...SLASH_COMMENTS };
const YAML: Grammar = { lineComments: ['#'], strings: C_STRINGS, constants: words('true false null yes no on off ~'), keys: 'colon', dashedNames: true };
const TOML: Grammar = { lineComments: ['#', ';'], strings: [{ open: '"""', close: '"""', multiline: true }, ...C_STRINGS], constants: words('true false'), keys: 'equals', dashedNames: true };
const CSS: Grammar = { blockComments: [['/*', '*/']], strings: C_STRINGS, keys: 'colon', dashedNames: true, keywords: words('@media @import @keyframes @font-face !important') };
const MARKUP: Grammar = { blockComments: [['<!--', '-->']], strings: C_STRINGS, markup: true };
const LUA: Grammar = {
  lineComments: ['--'], blockComments: [['--[[', ']]']], strings: C_STRINGS,
  keywords: words('and break do else elseif end for function goto if in local not or repeat return then until while'),
  constants: words('true false nil self'),
};

const GRAMMARS: Readonly<Record<string, Grammar>> = {
  js: JS, javascript: JS, jsx: JS, mjs: JS, cjs: JS, ts: JS, typescript: JS, tsx: JS, mts: JS, cts: JS,
  py: PYTHON, python: PYTHON, python3: PYTHON,
  go: C_LIKE, golang: C_LIKE, rs: C_LIKE, rust: C_LIKE, java: C_LIKE, kt: C_LIKE, kotlin: C_LIKE, kts: C_LIKE, scala: C_LIKE,
  swift: C_LIKE, c: C_LIKE, h: C_LIKE, cpp: C_LIKE, 'c++': C_LIKE, cc: C_LIKE, hpp: C_LIKE, cs: C_LIKE, csharp: C_LIKE,
  dart: C_LIKE, php: { ...C_LIKE, variables: true, lineComments: ['//', '#'] }, groovy: C_LIKE, gradle: C_LIKE, zig: C_LIKE,
  rb: RUBY, ruby: RUBY,
  sh: SHELL, bash: SHELL, shell: SHELL, zsh: SHELL, console: SHELL, shellscript: SHELL, dockerfile: SHELL, docker: SHELL, makefile: SHELL, make: SHELL, fish: SHELL, ps1: SHELL, powershell: SHELL,
  sql: SQL, psql: SQL, postgres: SQL, postgresql: SQL, mysql: SQL, sqlite: SQL,
  json: JSON_GRAMMAR, jsonc: JSON_GRAMMAR, json5: JSON_GRAMMAR, jsonl: JSON_GRAMMAR,
  yaml: YAML, yml: YAML, toml: TOML, ini: TOML, conf: TOML, env: TOML, properties: TOML,
  css: CSS, scss: CSS, sass: CSS, less: CSS,
  html: MARKUP, htm: MARKUP, xml: MARKUP, svg: MARKUP, vue: MARKUP, svelte: MARKUP, xhtml: MARKUP, plist: MARKUP,
  lua: LUA,
  diff: { diff: true }, patch: { diff: true },
};

/** Whether `language` (a fence's info word) is one this colours. */
export function highlightsLanguage(language: string | undefined): boolean {
  return Boolean(language && GRAMMARS[language.toLowerCase()]);
}

type State = undefined | { comment: string } | { string: StringRule };

const IDENTIFIER = /[A-Za-z_$#?][\w$?]*/y;
const DASHED_IDENTIFIER = /[A-Za-z_$][\w$-]*/y;
const NUMBER = /(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)[a-zA-Z%]*/y;
const isWordChar = (char: string | undefined): boolean => char !== undefined && /[\w$]/.test(char);

/** One line, from `state`: its spans and the state the next line starts in. */
function scanLine(line: string, grammar: Grammar, state: State): { spans: HighlightSpan[]; state: State } {
  const spans: HighlightSpan[] = [];
  const push = (text: string, kind?: HighlightKind): void => {
    if (!text) return;
    const last = spans[spans.length - 1];
    if (last && last.kind === kind) last.text += text;
    else spans.push(kind ? { text, kind } : { text });
  };
  if (grammar.diff) {
    const kind: HighlightKind | undefined = /^(?:\+\+\+|---|@@|diff |index )/.test(line) ? 'meta' : line.startsWith('+') ? 'inserted' : line.startsWith('-') ? 'deleted' : undefined;
    push(line, kind);
    return { spans, state: undefined };
  }
  let at = 0;
  /** Closes the string or comment `state` holds, from `at`. */
  const finishOpen = (): void => {
    if (state && 'comment' in state) {
      const end = line.indexOf(state.comment, at);
      if (end < 0) { push(line.slice(at), 'comment'); at = line.length; return; }
      push(line.slice(at, end + state.comment.length), 'comment');
      at = end + state.comment.length;
      state = undefined;
    } else if (state && 'string' in state) {
      const rule = state.string;
      let index = at;
      while (index < line.length) {
        if (rule.escape && line[index] === '\\') { index += 2; continue; }
        if (line.startsWith(rule.close, index)) break;
        index += 1;
      }
      if (index >= line.length) {
        push(line.slice(at), 'string');
        at = line.length;
        if (!rule.multiline) state = undefined;
        return;
      }
      push(line.slice(at, index + rule.close.length), 'string');
      at = index + rule.close.length;
      state = undefined;
    }
  };
  // A key at the head of the line (YAML's `name:`, TOML's `name =`).
  if (!state && grammar.keys) {
    const key = (grammar.keys === 'colon' ? /^(\s*(?:-\s+)?)([\w$.@"'-]+)(?=\s*:(?:\s|$))/ : /^(\s*)([\w$.@"'-]+)(?=\s*=)/).exec(line);
    if (key) { push(key[1]!); push(key[2]!, 'property'); at = key[0].length; }
    else if (grammar.keys === 'equals') {
      const section = /^\s*\[[^\]]*\]/.exec(line);
      if (section) { push(section[0], 'type'); at = section[0].length; }
    }
  }
  let inTag = false;
  while (at < line.length) {
    if (state) { finishOpen(); continue; }
    const rest = line.slice(at);
    const char = line[at]!;
    if (/\s/.test(char)) { const run = /^\s+/.exec(rest)![0]; push(run); at += run.length; continue; }
    const block = grammar.blockComments?.find(([open]) => rest.startsWith(open));
    if (block) { push(block[0], 'comment'); at += block[0].length; state = { comment: block[1] }; continue; }
    const lineComment = grammar.lineComments?.find((open) => rest.startsWith(open) && (open !== '#' || at === 0 || /\s/.test(line[at - 1]!)));
    if (lineComment) { push(rest, 'comment'); break; }
    if (grammar.markup) {
      const tag = /^<\/?[\w:.-]+/.exec(rest);
      if (tag) { push(tag[0], 'tag'); at += tag[0].length; inTag = true; continue; }
      if (inTag && (rest.startsWith('/>') || char === '>')) { const end = rest.startsWith('/>') ? '/>' : '>'; push(end, 'tag'); at += end.length; inTag = false; continue; }
      if (inTag) {
        const attribute = /^[\w:@.-]+(?==)|^[\w:@.-]+/.exec(rest);
        if (attribute && char !== '"' && char !== "'") { push(attribute[0], 'attribute'); at += attribute[0].length; continue; }
      }
      if (!inTag && char !== '"' && char !== "'") {
        const text = /^[^<]+/.exec(rest)?.[0] ?? char;
        push(text); at += text.length; continue;
      }
    }
    const quote = grammar.strings?.find((rule) => rest.startsWith(rule.open));
    if (quote) {
      const start = at;
      push(quote.open, 'string');
      at += quote.open.length;
      state = { string: quote };
      finishOpen();
      // JSON's keys are the strings a colon follows.
      if (grammar.stringKeys && !state && /^\s*:/.test(line.slice(at))) {
        const last = spans[spans.length - 1]!;
        const keyText = line.slice(start, at);
        if (last.text === keyText) last.kind = 'property';
        else { last.text = last.text.slice(0, last.text.length - keyText.length); push(keyText, 'property'); }
      }
      continue;
    }
    if (/\d/.test(char) && !isWordChar(line[at - 1])) {
      NUMBER.lastIndex = at;
      const number = NUMBER.exec(line);
      if (number) { push(number[0], 'number'); at += number[0].length; continue; }
    }
    if (grammar.decorators && char === '@' && /[A-Za-z_]/.test(line[at + 1] ?? '')) {
      const name = /^@[\w.]+/.exec(rest)![0];
      push(name, 'meta'); at += name.length; continue;
    }
    if (grammar.variables && char === '$') {
      const variable = /^\$(?:\{[^}]*\}|\w+|[@#?*!$-])/.exec(rest)?.[0];
      if (variable) { push(variable, 'property'); at += variable.length; continue; }
    }
    if (char === '#' && grammar === CSS) {
      const hex = /^#[\da-fA-F]{3,8}\b/.exec(rest)?.[0];
      if (hex) { push(hex, 'number'); at += hex.length; continue; }
    }
    const pattern = grammar.dashedNames ? DASHED_IDENTIFIER : IDENTIFIER;
    pattern.lastIndex = at;
    const name = /[A-Za-z_$#?]/.test(char) ? pattern.exec(line)?.[0] : undefined;
    if (name && !(name.startsWith('#') && !grammar.keywords?.has(name))) {
      const word = grammar.caseless ? name.toLowerCase() : name;
      const kind: HighlightKind | undefined = grammar.keywords?.has(word) ? 'keyword'
        : grammar.constants?.has(word) ? 'constant'
          : grammar.types?.has(word) ? 'type'
            : /^\s*\(/.test(line.slice(at + name.length)) && grammar !== SHELL ? 'function'
              : grammar.capitalTypes && /^[A-Z][a-z0-9]\w*$/.test(name) ? 'type'
                : undefined;
      push(name, kind);
      at += name.length;
      continue;
    }
    push(char);
    at += 1;
  }
  // A string that may not span lines ends with its line.
  if (state && 'string' in state && !state.string.multiline) state = undefined;
  return { spans, state };
}

/** The state after `lines`, remembered for the fence most recently asked
 * about: a fence retired a line at a time asks again for the same lines plus
 * one, and is scanned from where it was left rather than from the top. */
let remembered: { grammar: Grammar; text: string; state: State } | undefined;

function stateAfter(lines: readonly string[], grammar: Grammar): State {
  if (!lines.length) return undefined;
  const text = lines.join('\n');
  let state: State = undefined;
  let from = 0;
  if (remembered?.grammar === grammar && text.startsWith(remembered.text) && (text.length === remembered.text.length || text[remembered.text.length] === '\n')) {
    state = remembered.state;
    from = remembered.text ? remembered.text.split('\n').length : 0;
    if (text.length === remembered.text.length) return state;
  }
  for (const line of lines.slice(from)) state = scanLine(line, grammar, state).state;
  remembered = { grammar, text, state };
  return state;
}

/** `lines` of a fence in `language` as spans, line by line; `before` are the
 * lines of the same fence above them, already shown. A language this does
 * not know gives each line as one plain span. */
export function highlightLines(lines: readonly string[], language: string | undefined, before: readonly string[] = []): HighlightSpan[][] {
  const grammar = language ? GRAMMARS[language.toLowerCase()] : undefined;
  if (!grammar) return lines.map((line) => (line ? [{ text: line }] : []));
  let state = stateAfter(before, grammar);
  return lines.map((line) => {
    const scanned = scanLine(line, grammar, state);
    state = scanned.state;
    return scanned.spans;
  });
}
