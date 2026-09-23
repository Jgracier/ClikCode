/** Every harness a user can pick must be installable from what ClikCode says.
 *
 * 16 of the 24 publish an npm package and are installed automatically
 * (inspect.ts runs `npm install --global`). The other 8 cannot be, so the
 * only thing standing between the user and a working harness is the hint --
 * and a hint with no command in it is a web page to go and read.
 *
 * Both kiro and antigravity were exactly that until this test existed.
 */
import { describe, expect, it } from 'vitest';
import { allLocalHarnesses } from '@clikcode/router/ai-local-harness';
import { HARNESS_INSTALL_HINTS, installInstructions } from './install-hints';

describe('installing a harness ClikCode cannot install for you', () => {
  const manual = allLocalHarnesses().filter((harness) => !harness.npmPackage);

  it('covers every harness with no npm package', () => {
    const uncovered = manual.filter((harness) => !HARNESS_INSTALL_HINTS[harness.command]).map((h) => h.command);
    expect(uncovered, 'harnesses with neither an npm package nor a hint').toEqual([]);
  });

  it('gives a runnable command, not just a link to go and read', () => {
    const docsOnly = manual
      .filter((harness) => !HARNESS_INSTALL_HINTS[harness.command]?.command)
      .map((harness) => harness.command);
    expect(docsOnly, 'hints that name no command').toEqual([]);
  });

  it('puts the command in the message the user actually sees', () => {
    for (const harness of manual) {
      const message = installInstructions(harness.displayName, harness.command, harness.binary);
      expect(message, harness.command).toContain(HARNESS_INSTALL_HINTS[harness.command]!.command!);
    }
  });

  it('still says something useful for a harness with no hint at all', () => {
    const message = installInstructions('Imaginary CLI', 'imaginary', 'imag');
    expect(message).toContain('imag');
    expect(message).toContain('does not publish an npm package');
  });
});
