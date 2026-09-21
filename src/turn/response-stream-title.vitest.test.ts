import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

/**
 * Every transport that streams an answer to the screen must pass it through
 * the title filter first.
 *
 * The structured-CLI path did not, and that one omission produced the
 * duplicated response: the first turn of an unnamed chat streamed the raw
 * <clikcode-title> tag to the screen, so what the user saw differed from the
 * cleaned text that gets persisted — and the transcript, comparing the two,
 * read the saved answer as new content and emitted the whole reply a second
 * time underneath the copy already there.
 *
 * Asserted against the source because the bug is an omission at one call
 * site among four; no behavioural test of the other three would have caught
 * it, and none did.
 */
describe('streamed answers go through the title filter', () => {
  it('has no onResponseDelta that writes the raw text to the screen', async () => {
    const source = await readFile(new URL('./drive.ts', import.meta.url), 'utf8');
    const lines = source.split('\n');
    const offenders: string[] = [];
    for (const [index, line] of lines.entries()) {
      if (!/TERMINAL\.active\?\.response\(/.test(line)) continue;
      // Clearing the slot for a retry passes a literal empty string.
      if (/response\(''/.test(line)) continue;
      // The answer being painted must be a filtered value, never the raw
      // delta the transport handed over.
      const painted = /TERMINAL\.active\?\.response\((\w+)/.exec(line)?.[1];
      if (painted === 'text' || painted === 'delta') {
        offenders.push(`line ${index + 1}: ${line.trim()}`);
      }
    }
    expect(offenders, 'these paint an unfiltered delta').toEqual([]);
  });

  it('filters through titleStream wherever a delta is painted', async () => {
    const source = await readFile(new URL('./drive.ts', import.meta.url), 'utf8');
    // Each streaming call site names a filtered variable, and every one of
    // those is produced by titleStream.push.
    const painted = [...source.matchAll(/TERMINAL\.active\?\.response\((\w+)/g)].map((m) => m[1]);
    expect(painted.length).toBeGreaterThanOrEqual(4);
    for (const name of new Set(painted)) {
      if (name === 'answer') continue;
      expect(source, `${name} must come from the title filter`)
        .toMatch(new RegExp(`const ${name} = titleStream \\? titleStream\\.push\\(`));
    }
  });
});
