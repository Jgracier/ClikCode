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
 * Asserted against the source because the bug was an omission at one call
 * site among four; no behavioural test of the other three would have caught
 * it, and none did.
 *
 * The four call sites are now one shared `emitResponseDelta`, so the omission
 * this guards against is no longer expressible -- a transport cannot skip a
 * filter that lives inside the only function that paints. These tests
 * therefore assert the invariant itself (nothing paints an unfiltered delta,
 * and every painted value comes from the filter) rather than counting copies,
 * which is what the earlier `>= 4` check really did and which a correct
 * consolidation would always break.
 */
describe('streamed answers go through the title filter', () => {
  it('has no onResponseDelta that writes the raw text to the screen', async () => {
    const source = await readFile(new URL('./drive.ts', import.meta.url), 'utf8');
    const lines = source.split('\n');
    const offenders: string[] = [];
    for (const [index, line] of lines.entries()) {
      if (!/prompter\?\.response\(/.test(line)) continue;
      // Clearing the slot for a retry passes a literal empty string.
      if (/response\(''/.test(line)) continue;
      // The answer being painted must be a filtered value, never the raw
      // delta the transport handed over.
      const painted = /prompter\?\.response\((\w+)/.exec(line)?.[1];
      if (painted === 'text' || painted === 'delta') {
        offenders.push(`line ${index + 1}: ${line.trim()}`);
      }
    }
    expect(offenders, 'these paint an unfiltered delta').toEqual([]);
  });

  it('filters through titleStream wherever a delta is painted', async () => {
    const source = await readFile(new URL('./drive.ts', import.meta.url), 'utf8');
    // Every painted value is produced by the title filter. Named variables
    // only -- a literal (the empty string that clears the slot for a retry)
    // is not a delta.
    const painted = [...source.matchAll(/prompter\?\.response\((\w+)/g)].map((m) => m[1]);
    expect(painted.length, 'nothing paints an answer at all').toBeGreaterThan(0);
    for (const name of new Set(painted)) {
      if (name === 'answer') continue;
      expect(source, `${name} must come from the title filter`)
        .toMatch(new RegExp(`const ${name} = titleStream \\? titleStream\\.push\\(`));
    }
  });

  it('routes every transport through the one shared delta emitter', async () => {
    const source = await readFile(new URL('./drive.ts', import.meta.url), 'utf8');
    // The real invariant after consolidation: ONE filter site per execution
    // path, not one per transport. The three that remain are the vendor-CLI
    // path (where three transports now share a single emitter), the api-key
    // path and the gateway path -- each a separate function with its own
    // titleStream, which is irreducible without merging the paths themselves.
    // A fourth is the regression to catch: it would mean a transport grew its
    // own copy back.
    const filterSites = [...source.matchAll(/titleStream \? titleStream\.push\(/g)];
    expect(filterSites.length, 'the title filter has been copied again').toBe(3);
    expect(source).toMatch(/const emitResponseDelta = /);
    // Each of the three native transports hands its deltas to it, directly or
    // by spreading the shared observer that names it.
    expect(source).toMatch(/onResponseDelta: emitResponseDelta/);
    const spreads = [...source.matchAll(/\.\.\.sharedObserver/g)];
    expect(spreads.length, 'a transport stopped using the shared observer').toBe(3);
  });
});
