/** The status line's look: the spinner and the label turnStatus() chose,
 * coloured by what the turn is doing, a highlight swept across the label.
 *
 * Truecolor terminals get blends -- the highlight is the tone brightened.
 * Fewer colours, and the highlight is bold. No colour at all (NO_COLOR, a pipe) and
 * chalk writes the words alone, which is all they need to read. */

import chalk, { type ChalkInstance } from 'chalk';
import type { ToolCategory } from '../../harness/prompter.js';
import { TOOL_CATEGORY } from '../../harness/protocol/tool-category.js';
import { shimmerLevels, type StatusTone } from '../../harness/protocol/turn-flow.js';
import { SHIMMER_STRIDE } from '../../harness/protocol/timings.js';

type Colour = 'cyan' | 'blue' | 'magenta' | 'yellow' | 'green' | 'red';
type Rgb = readonly [number, number, number];

/** The named colours, as the truecolor blends start from them. */
const RGB: Record<Colour, Rgb> = {
  cyan: [80, 200, 220], blue: [110, 150, 255], magenta: [205, 125, 235],
  yellow: [230, 190, 90], green: [135, 205, 115], red: [235, 85, 85],
};
const WHITE: Rgb = [255, 255, 255];

/** How far the highlight brightens the tone at its centre. */
const SHIMMER_LIFT = 0.65;


function blend(from: Rgb, to: Rgb, amount: number): Rgb {
  const t = Math.max(0, Math.min(1, amount));
  return [0, 1, 2].map((index) => Math.round(from[index]! + (to[index]! - from[index]!) * t)) as unknown as Rgb;
}

/** The tone's colour: thinking cyan, a call its category's, asking blue. */
export function statusColour(tone: StatusTone, category?: ToolCategory): Colour {
  if (tone === 'asking') return 'blue';
  if (tone === 'tool' && category) return TOOL_CATEGORY[category].colour;
  return 'cyan';
}

/** The spinner glyph and the label, painted. `shimmer` is false whenever the
 * band should hold still: reduced motion, an approval up. `stalled`: the turn
 * has gone quiet (turn-pace.ts), and the spinner alone turns yellow -- the
 * words keep the colour of what the turn is doing. */
export function paintStatus(input: {
  glyph: string; label: string; tone: StatusTone; category?: ToolCategory;
  frame: number; shimmer: boolean; stalled?: boolean;
}, paint: ChalkInstance = chalk): { spinner: string; label: string } {
  const base = statusColour(input.tone, input.category);
  const spinnerColour: Colour = input.stalled ? 'yellow' : base;
  if (paint.level === 0) return { spinner: input.glyph, label: input.label };
  const characters = [...input.label];
  const levels = input.shimmer ? shimmerLevels(characters.length, input.frame * SHIMMER_STRIDE) : undefined;
  if (paint.level >= 3) {
    const tone = RGB[base];
    const label = levels
      ? painted(characters, (index) => blend(tone, WHITE, (levels[index] ?? 0) * SHIMMER_LIFT).join(','), (key, run) => paint.rgb(...(key.split(',').map(Number) as unknown as Rgb))(run))
      : paint.rgb(...tone)(input.label);
    return { spinner: paint.rgb(...RGB[spinnerColour])(input.glyph), label };
  }
  const label = levels
    ? painted(characters, (index) => ((levels[index] ?? 0) >= 0.5 ? 'bold' : ''), (key, run) => (key ? paint.bold[base](run) : paint[base](run)))
    : paint[base](input.label);
  return { spinner: paint[spinnerColour](input.glyph), label };
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
