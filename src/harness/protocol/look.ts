/** The one look of an activity row, for every harness, in the terminal and in
 * the VS Code webview: glyphs, colour roles, spinner and shimmer timing.
 *
 * Plain data and pure functions -- no chalk, no node imports -- so the webview
 * bundles it. The terminal paints from it (`tool-category-style.ts`, chalk
 * `ansi256`); the webview sets the same values as CSS custom properties on
 * its root (`lookCssVariables`, applied by `webview/look.ts`) and styles.css
 * only reads `var(--look-*)`. A colour is an xterm-256 index, and its hex is
 * DERIVED from that index by the standard xterm palette, so the blue is the
 * same blue on both surfaces and there is one number to change.
 *
 * Nothing in src/tui/render, src/harness/protocol or the webview may carry a
 * colour or a tool-row glyph of its own (look-guard.vitest.test.ts).
 */

import { SHIMMER_STRIDE, SHIMMER_WIDTH, SPIN_MS, SPIN_PHASES } from './timings.js';
import { waitingSpinnerGlyph } from './activity-view.js';

/** The standard xterm 256-colour palette entry, as `[r, g, b]`. */
export function xtermRgb(index: number): readonly [number, number, number] {
  if (index < 16) {
    const base: ReadonlyArray<readonly [number, number, number]> = [
      [0, 0, 0], [128, 0, 0], [0, 128, 0], [128, 128, 0], [0, 0, 128], [128, 0, 128], [0, 128, 128], [192, 192, 192],
      [128, 128, 128], [255, 0, 0], [0, 255, 0], [255, 255, 0], [0, 0, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
    ];
    return base[index]!;
  }
  if (index >= 232) { const level = 8 + (index - 232) * 10; return [level, level, level]; }
  const cube = index - 16;
  const step = (value: number): number => (value === 0 ? 0 : 55 + value * 40);
  return [step(Math.floor(cube / 36)), step(Math.floor(cube / 6) % 6), step(cube % 6)];
}

export function xtermHex(index: number): string {
  return `#${xtermRgb(index).map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

/** A colour role: an xterm-256 index, or a text style with no colour of its
 * own (`dim`, `italic`: the surface's own foreground, receded). */
export interface LookRole { readonly ansi?: number; readonly dim?: true; readonly italic?: true }

export const LOOK = {
  glyph: {
    /** Every tool row, whatever the call and whoever made it. */
    tool: '‣',
    /** A settled thought. */
    thought: '✻',
    /** A call its turn was stopped under. */
    stopped: '■',
    /** A settled success, a failure. */
    ok: '✓',
    failed: '✗',
  },
  roles: {
    /** The tool glyph. */
    toolGlyph: { ansi: 68 },
    /** The words of a tool row. */
    toolText: { ansi: 110 },
    /** A run group's summary row (its counts), the same blue as a tool row's words. */
    summary: { ansi: 110 },
    /** What is running: the spinner of the turn and of a running row. */
    accent: { ansi: 75 },
    failed: { ansi: 203 },
    stopped: { ansi: 179 },
    success: { ansi: 114 },
    /** A thought, and everything that is only context (output, hints). */
    thought: { dim: true, italic: true },
    neutral: { dim: true },
  },
  /** Between the parts of a summary row (`Ran 4 commands · 2 thoughts`). */
  separator: ' · ',
  spinner: { stepMs: SPIN_MS, phases: SPIN_PHASES, glyph: waitingSpinnerGlyph },
  shimmer: { stride: SHIMMER_STRIDE, width: SHIMMER_WIDTH, lift: 0.65 },
} as const satisfies {
  glyph: Record<string, string>; roles: Record<string, LookRole>; separator: string;
  spinner: unknown; shimmer: unknown;
};

export type LookRoleName = keyof typeof LOOK.roles;

/** Every colour role's hex (roles with no colour of their own are absent). */
export const LOOK_HEX: Readonly<Partial<Record<LookRoleName, string>>> = Object.fromEntries(
  Object.entries(LOOK.roles as Record<string, LookRole>).flatMap(([name, role]) => (role.ansi === undefined ? [] : [[name, xtermHex(role.ansi)]])),
);

const kebab = (name: string): string => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

/** The look as CSS custom properties: `--look-tool-glyph: #5f87d7`, ... */
export function lookCssVariables(): Record<string, string> {
  return Object.fromEntries(Object.entries(LOOK_HEX).map(([name, hex]) => [`--look-${kebab(name)}`, hex!]));
}
