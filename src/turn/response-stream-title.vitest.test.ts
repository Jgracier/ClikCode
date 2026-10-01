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
 * The four call sites are now one shared `turnSink`, so the omission
 * this guards against is no longer expressible -- a transport cannot skip a
 * filter that lives inside the only function that paints. These tests
 * therefore assert the invariant itself (nothing paints an unfiltered delta,
 * and every painted value comes from the filter) rather than counting copies,
 * which is what the earlier `>= 4` check really did and which a correct
 * consolidation would always break.
 */
describe('streamed answers go through the title filter', () => {
  const turnSources = async (): Promise<string> => (await Promise.all(
    ['turn-output.ts', 'vendor-turn.ts', 'vendor-cli-attempt.ts', 'vendor-session-attempt.ts', 'direct-turn.ts', 'agent-turn.ts', 'platform-assistant-turn.ts']
      .map((file) => readFile(new URL(file, import.meta.url), 'utf8')),
  )).join('\n');

  it('has no onResponseDelta that writes the raw text to the screen', async () => {
    const source = await turnSources();
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
    const source = await turnSources();
    // Every painted value is produced by the title filter. Named variables
    // only -- a literal (the empty string that clears the slot for a retry)
    // is not a delta.
    const painted = [...source.matchAll(/prompter\?\.response\((\w+)/g)].map((m) => m[1]);
    expect(painted.length, 'nothing paints an answer at all').toBeGreaterThan(0);
    for (const name of new Set(painted)) {
      if (name === 'answer') continue;
      // A constant table of the two literal edits a retry makes (clear, new
      // paragraph): typed so nothing else can be passed, and never a delta.
      if (name === 'RETRY_EDITS') { expect(source).toMatch(/const RETRY_EDITS = \{ clear: \['', 'replace'\], 'new-paragraph': \['\\n\\n', 'append'\] \} as const;/); continue; }
      // A delta through push(), or what push() was still holding when the
      // stream ended, released by flush(): both are the filter's own output.
      expect(source, `${name} must come from the title filter`)
        .toMatch(new RegExp(`const ${name} = titleStream(?: \\? titleStream\\.push\\(|\\?\\.flush\\(\\))`));
    }
  });

  it('routes every transport through the one shared delta emitter', async () => {
    const source = await turnSources();
    // The real invariant after consolidation: ONE filter site per sink, not
    // one per transport. The two that remain are turnSink (the vendor path,
    // where three transports share it, and the api-key path) and the gateway
    // platform assistant, which also echoes to the terminal as it streams.
    // A third is the regression to catch: it would mean a transport grew its
    // own copy back.
    const filterSites = [...source.matchAll(/titleStream \? titleStream\.push\(/g)];
    expect(filterSites.length, 'the title filter has been copied again').toBe(2);
    expect(source).toMatch(/export function turnSink\(/);
    // The two session protocols and CLI parser all use the shared observer.
    expect(source).toMatch(/onResponseDelta: sink\.response/);
    const spreads = [...source.matchAll(/\.\.\.sharedObserver/g)];
    expect(spreads.length, 'a transport stopped using the shared observer').toBe(3);
    expect(source).toMatch(/sharedObserver\.onResponseDelta\?\.\(text, mode \?\? 'append'\)/);
  });
});
