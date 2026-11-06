/** ASCII fallback: a terminal whose locale is not UTF-8 (or the Linux console) cannot be trusted
 * with box drawing or braille, so every row is folded to plain ASCII on its way out. Each
 * replacement is one cell for one cell, so no width computed before the fold changes.
 * CLIKCODE_ASCII=1 forces it, CLIKCODE_ASCII=0 turns it off. */
export function asciiMode(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CLIKCODE_ASCII === '1') return true;
  if (env.CLIKCODE_ASCII === '0') return false;
  if (env.TERM?.toLowerCase() === 'linux') return true;
  // POSIX precedence: LC_ALL, then LC_CTYPE, then LANG; the first one set decides.
  const locale = [env.LC_ALL, env.LC_CTYPE, env.LANG].find((value) => value !== undefined && value !== '');
  if (locale === undefined) return false; // Unknown: not evidence of a bad terminal.
  return !/utf-?8/i.test(locale);
}

const FOLD: Record<string, string> = {};
const put = (chars: string, to: string): void => { for (const ch of chars) FOLD[ch] = to; };
put('─━═╌╍┄┅┈┉', '-');
put('│┃║╎╏┆┇┊┋', '|');
put('┌┐└┘├┤┬┴┼╭╮╰╯╔╗╚╝╠╣╦╩╬┏┓┗┛┣┫┳┻╋', '+');
put('•●◆▪■', '*');
put('○◇□', 'o');
put('·∙', '-');
put('…', '.');
put('✓✔', '+');
put('✗✘×', 'x');
put('↑▲', '^');
put('↓▼', 'v');
put('←◀', '<');
put('→▶▸', '>');
put('—–', '-');
put('‘’', "'");
put('“”', '"');

const SPIN = '-\\|/';
const NON_ASCII = /[^\x00-\x7f]/;

/** One row folded to ASCII; braille spinner cells become one of `-\|/` by their dot pattern. */
export function foldAscii(text: string): string {
  if (!NON_ASCII.test(text)) return text;
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) out += ch;
    else if (cp >= 0x2800 && cp <= 0x28ff) out += SPIN[cp % 4];
    else out += FOLD[ch] ?? ch;
  }
  return out;
}
