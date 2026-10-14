/** The look is one file (look.ts). This holds the rest of the code to it: an
 * activity row is painted from a role, never from a colour or a glyph typed
 * where the row is built, so the terminal and the webview cannot drift apart
 * (or per harness) without a test going red. */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../../..');
const SCANNED = ['src/tui/render', 'src/tui/prompter/paint', 'src/harness/protocol', 'packages/vscode/src/webview'];

/** Files that may hold a colour of their own, and why. Everything else in
 * SCANNED must go through look.ts. */
const ALLOWED: Readonly<Record<string, string>> = {
  'src/harness/protocol/look.ts': 'the tokens themselves',
  'src/harness/protocol/tool-category-style.ts': 'the terminal painters, built from look.ts',
  'src/tui/render/approval-block.ts': 'approval prompt, not an activity row',
  'src/tui/render/question-block.ts': 'question prompt, not an activity row',
  'src/tui/render/plan-block.ts': 'plan checklist, not an activity row',
  'src/tui/render/turn-mark-rows.ts': 'the settled plan row\'s checklist marks',
  'src/tui/render/message-blocks.ts': 'answer markdown',
  'src/tui/render/markdown.ts': 'answer markdown',
  'src/tui/render/footer-rows.ts': 'composer footer menu',
  'src/tui/render/waiting.ts': 'the usage rule in the composer frame',
  'src/tui/render/status-line.ts': 'the status line\'s truecolor/ansi painter, driven by look.ts accent and stopped',
  'src/tui/prompter/paint/footer.ts': 'notices and the footer meta, not activity rows',
  'src/tui/prompter/paint/transcript.ts': 'the account-switch notice',
};

const COLOUR = /chalk\.(?:red|green|yellow|blue|cyan|magenta|white|black|gray|grey|redBright|greenBright|yellowBright|blueBright|cyanBright|magentaBright|whiteBright|bgRed|bgGreen|bgYellow|bgBlue|bgCyan|bgMagenta|rgb|hex|bgRgb|bgHex)\b|\.ansi256\(|\.bgAnsi256\(|\.rgb\(\s*\d|#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b(?![\w-])/;
const GLYPH = /['"`][^'"`\n]*[‣✻][^'"`\n]*['"`]/;

function sources(dir: string): string[] {
  return readdirSync(join(ROOT, dir)).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(join(ROOT, path)).isDirectory()) return sources(path);
    return /\.(?:ts|tsx)$/.test(name) && !/\.(?:vitest\.)?test\.|\.vitest\.ts$|test-support/.test(name) ? [path] : [];
  });
}

const code = (text: string): string => text.split('\n').map((line) => line.replace(/^\s*(?:\/\/|\*|\/\*).*$/, '')).join('\n');

describe('the look guard', () => {
  const files = SCANNED.flatMap(sources);

  it('recognises what it forbids', () => {
    for (const line of ["chalk.red('x')", 'chalk.ansi256(68)(x)', "paint.ansi256(i)(x)", "const c = '#5f87d7';", 'chalk.bgYellow(x)']) expect(COLOUR.test(line), line).toBe(true);
    for (const line of ['chalk.dim(x)', 'chalk.bold(chalk.italic(x))', 'look.paint.failed(x)', 'const issue = "#12"']) expect(COLOUR.test(line), line).toBe(false);
    expect(GLYPH.test("const g = '‣';")).toBe(true);
    expect(GLYPH.test('`  ✻ ${text}`')).toBe(true);
  });

  it('scans the directories it names', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain('src/harness/protocol/activity-line.ts');
    expect(files).toContain('packages/vscode/src/webview/activity-rows.tsx');
  });

  it('keeps every colour in look.ts, outside the short allow-list of non-activity UI', () => {
    const offenders = files.filter((file) => !ALLOWED[file]).flatMap((file) => code(readFileSync(join(ROOT, file), 'utf8')).split('\n')
      .flatMap((line, index) => (COLOUR.test(line) ? [`${file}:${index + 1}: ${line.trim()}`] : [])));
    expect(offenders).toEqual([]);
  });

  it('keeps the tool and thought glyphs in look.ts', () => {
    const offenders = files.filter((file) => file !== 'src/harness/protocol/look.ts').flatMap((file) => code(readFileSync(join(ROOT, file), 'utf8')).split('\n')
      .flatMap((line, index) => (GLYPH.test(line) ? [`${file}:${index + 1}: ${line.trim()}`] : [])));
    expect(offenders).toEqual([]);
  });

  it('keeps the allow-list honest: every entry exists and still needs it', () => {
    for (const [file, reason] of Object.entries(ALLOWED)) {
      expect(reason.length).toBeGreaterThan(0);
      const text = readFileSync(join(ROOT, file), 'utf8');
      if (file === 'src/harness/protocol/look.ts') continue;
      expect(COLOUR.test(code(text)), `${file} no longer carries a colour: take it off the allow-list`).toBe(true);
    }
  });

  it('keeps the webview stylesheet free of per-category or per-theme tool colours', () => {
    const css = readFileSync(join(ROOT, 'packages/vscode/src/webview/styles.css'), 'utf8');
    expect(css).not.toMatch(/\.tone-(?:blue|magenta|yellow|cyan|green|permission)\b/);
    const rows = css.split('\n').filter((line) => /\.(?:activity|explored|trace-toggle|thought|tone-|tool-glyph|group-summary)\b/.test(line) && /^[^{]*\{/.test(line));
    const offenders = rows.filter((line) => /--vscode-terminal-ansi|#[0-9a-fA-F]{3,8}\b/.test(line));
    expect(offenders).toEqual([]);
  });

  it('paints the terminal and the webview from the same values', async () => {
    const { LOOK, LOOK_HEX, lookCssVariables, xtermHex } = await import('./look.js');
    expect(LOOK.glyph.tool).toBe('‣');
    expect(LOOK.glyph.thought).toBe('✻');
    expect(LOOK_HEX.toolGlyph).toBe(xtermHex(68));
    expect(LOOK_HEX.toolText).toBe(xtermHex(110));
    expect(lookCssVariables()['--look-tool-glyph']).toBe(LOOK_HEX.toolGlyph);
    // The xterm cube and grey ramp, and the 16 base colours.
    expect(xtermHex(68)).toBe('#5f87d7');
    expect(xtermHex(110)).toBe('#87afd7');
    expect(xtermHex(232)).toBe('#080808');
    expect(xtermHex(15)).toBe('#ffffff');
    expect(relative(ROOT, join(ROOT, 'src/harness/protocol/look.ts'))).toBe('src/harness/protocol/look.ts');
  });
});
