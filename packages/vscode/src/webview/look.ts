/** The webview's half of the look (src/harness/protocol/look.ts): the same
 * colour roles the terminal paints, set as CSS custom properties on the root.
 * styles.css only reads `var(--look-*)`; it carries no colour of its own for
 * an activity row. */
import { LOOK, lookCssVariables } from '../../../../src/harness/protocol/look';

export { LOOK };

export function applyLook(root: HTMLElement = document.documentElement): void {
  for (const [name, value] of Object.entries(lookCssVariables())) root.style.setProperty(name, value);
}
