import { describe, expect, it } from 'vitest';
import { allLocalHarnesses, localHarnessCapabilityManifest } from '../../../../packages/clikrouter/src/ai-local-harness';
import { commonControlFor, OPTION_NORMALIZATION, vendorFacingOptions } from './harness-options';

type Opt = { id: string; category?: string; description?: string };
const harnesses = allLocalHarnesses() as unknown as Array<{ command: string; displayName: string }>;
const optionsOf = (h: typeof harnesses[number]): Opt[] =>
  ((localHarnessCapabilityManifest(h as never) as { options?: Opt[] }).options ?? []);

/** id -> the harnesses that publish it. */
const published = new Map<string, string[]>();
for (const harness of harnesses) {
  for (const option of optionsOf(harness)) {
    published.set(option.id, [...(published.get(option.id) ?? []), harness.command]);
  }
}
const sharedIds = [...published].filter(([, cmds]) => cmds.length >= 2).map(([id]) => id);

describe('every option two or more harnesses publish is classified', () => {
  it('leaves none unclassified, so a new harness cannot widen the surface quietly', () => {
    const missing = sharedIds.filter((id) => !OPTION_NORMALIZATION[id]);
    expect(missing, 'shared option ids with no normalization decision').toEqual([]);
  });

  it('classifies nothing that no harness publishes', () => {
    const known = new Set(published.keys());
    expect(Object.keys(OPTION_NORMALIZATION).filter((id) => !known.has(id))).toEqual([]);
  });

  it('explains every decision', () => {
    for (const [id, entry] of Object.entries(OPTION_NORMALIZATION)) {
      expect(entry.note.length, `${id} has no note`).toBeGreaterThan(20);
    }
  });
});

describe('a setting a ClikCode command owns is not also a raw vendor row', () => {
  it('drops every duplicate, across every harness', () => {
    // Fifty-six rows duplicated a control the user already had: /model listed
    // `model`, /permissions listed `permissions`, and the two interfaces could
    // disagree about the same session.
    let duplicates = 0;
    for (const harness of harnesses) {
      for (const option of vendorFacingOptions(optionsOf(harness))) {
        if (commonControlFor(option.id)) duplicates += 1;
      }
    }
    expect(duplicates, 'a command-owned option is still listed as a vendor row').toBe(0);
  });

  it('folds the duplicates and keeps everything else', () => {
    // 213 rows, of which 63 restated a control the user already had. What is
    // left is 150 genuinely vendor-specific rows across 19 harnesses. Kimi and
    // Auggie publish nothing BUT a model selector, so their vendor surface is
    // now correctly empty rather than a lone duplicate of /model.
    const all = harnesses.flatMap((h) => optionsOf(h));
    const kept = harnesses.flatMap((h) => vendorFacingOptions(optionsOf(h)));
    expect(all.length - kept.length, 'the duplicate count changed; re-check the registry').toBe(63);
    expect(kept.length).toBe(150);
    const emptied = harnesses.filter((h) => optionsOf(h).length > 0 && vendorFacingOptions(optionsOf(h)).length === 0);
    expect(emptied.map((h) => h.command)).toEqual(['kimi', 'auggie']);
  });

  it('routes both spellings of extra directories to the same command', () => {
    // Gemini and Qwen publish --include-directories; five others publish
    // --add-dir. One concept, one control.
    expect(commonControlFor('add-dir')).toBe('/add-dir');
    expect(commonControlFor('include-directories')).toBe('/add-dir');
  });

  it('keeps a shared name that is not a shared meaning out of the common surface', () => {
    // `provider` inside Goose or Cline is an inference provider, not ClikCode's
    // provider; `mode` is a different enum in Antigravity and Cursor.
    for (const id of ['provider', 'agent', 'mode']) {
      expect(OPTION_NORMALIZATION[id]!.kind, `${id} was promoted`).toBe('vendor');
      expect(commonControlFor(id)).toBeUndefined();
    }
  });
});
