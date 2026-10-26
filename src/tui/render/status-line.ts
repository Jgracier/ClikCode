/** The status line's look: the spinner and the label turnStatus() chose,
 * coloured by what the turn is doing, a highlight swept across the label.
 *
 * Truecolor terminals get blends -- the highlight is the tone brightened.
 * Fewer colours, and the highlight is bold. No colour at all (NO_COLOR, a pipe) and
 * chalk writes the words alone, which is all they need to read. */

import chalk, { type ChalkInstance } from 'chalk';
import { shimmerLevels, type StatusTone } from '../../harness/protocol/turn-flow.js';
import { LOOK, xtermRgb } from '../../harness/protocol/look.js';

type Rgb = readonly [number, number, number];

const WHITE: Rgb = [255, 255, 255];

function blend(from: Rgb, to: Rgb, amount: number): Rgb {
  const t = Math.max(0, Math.min(1, amount));
  return [0, 1, 2].map((index) => Math.round(from[index]! + (to[index]! - from[index]!) * t)) as unknown as Rgb;
}

/** The spinner glyph and the label, painted. One colour for every tone, every
 * tool and every harness: the look's running accent (look.ts), a highlight
 * swept across the label. `shimmer` is false whenever the band should hold
 * still: reduced motion or an approval up. `tone` decides the words
 * (turnStatus); silence does not change a running spinner to failure colours. */
export function paintStatus(input: {
  glyph: string; label: string; tone: StatusTone;
  frame: number; shimmer: boolean;
}, paint: ChalkInstance = chalk): { spinner: string; label: string } {
  const accent = LOOK.roles.accent.ansi;
  if (paint.level === 0) return { spinner: input.glyph, label: input.label };
  const characters = [...input.label];
  const levels = input.shimmer ? shimmerLevels(characters.length, input.frame * LOOK.shimmer.stride) : undefined;
  const spinnerIndex = accent;
  if (paint.level >= 3) {
    const tone = xtermRgb(accent);
    const label = levels
      ? painted(characters, (index) => blend(tone, WHITE, (levels[index] ?? 0) * LOOK.shimmer.lift).join(','), (key, run) => paint.rgb(...(key.split(',').map(Number) as unknown as Rgb))(run))
      : paint.rgb(...tone)(input.label);
    return { spinner: paint.rgb(...xtermRgb(spinnerIndex))(input.glyph), label };
  }
  const label = levels
    ? painted(characters, (index) => ((levels[index] ?? 0) >= 0.5 ? 'bold' : ''), (key, run) => (key ? paint.ansi256(accent).bold(run) : paint.ansi256(accent)(run)))
    : paint.ansi256(accent)(input.label);
  return { spinner: paint.ansi256(spinnerIndex)(input.glyph), label };
}

/** The characters as runs of one look each, every run painted once: the
 * colour codes go out where the colour changes, not around every character.
 * Away from the highlight a label is one run. */
function painted(characters: readonly string[], look: (index: number) => string, paintRun: (key: string, run: string) => string): string {
  let out = '';
  let run = '';
  let key: string | undefined;
  characters.forEach((character, index) => {
    const next = look(index);
    if (key !== undefined && next !== key) { out += paintRun(key, run); run = ''; }
    key = next;
    run += character;
  });
  return key === undefined ? out : out + paintRun(key, run);
}
