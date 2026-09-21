import { describe, expect, it } from 'vitest';
import { allLocalHarnesses, localHarnessCapabilityManifest } from '../../../../packages/clikrouter/src/ai-local-harness';
import { commonControlFor, OPTION_NORMALIZATION, optionIdsForControl, vendorFacingOptions } from './harness-options';

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
    // Of the registry's rows, 66 restate a control the user already had. What
    // is left is the genuinely vendor-specific surface. Grok, Kimi, Auggie
    // and Continue publish nothing a ClikCode control does not already own --
    // a model selector, a permission mode -- so their vendor surface is
    // correctly empty rather than a list of duplicates.
    const all = harnesses.flatMap((h) => optionsOf(h));
    const kept = harnesses.flatMap((h) => vendorFacingOptions(optionsOf(h)));
    expect(all.length - kept.length, 'the duplicate count changed; re-check the registry').toBe(66);
    expect(kept.length).toBe(147);
    const emptied = harnesses.filter((h) => optionsOf(h).length > 0 && vendorFacingOptions(optionsOf(h)).length === 0);
    expect(emptied.map((h) => h.command)).toEqual(['grok', 'kimi', 'auggie', 'cn']);
  });

  it('routes both spellings of extra directories to the same command', () => {
    // Qwen publishes --include-directories; others publish --add-dir.
    // One concept, one control.
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

describe('every option is reachable, by exactly one route', () => {
  it('leaves nothing that a user cannot set', () => {
    // The two failure modes are opposite and both real: an option listed twice
    // gives one setting two interfaces, and an option folded into a control
    // that cannot actually drive it on this harness disappears entirely. The
    // second is the worse one, and it is what folding `include-directories`
    // into /add-dir caused until the lookup went by control rather than by id.
    const unreachable: string[] = [];
    const duplicated: string[] = [];
    for (const harness of harnesses) {
      const options = optionsOf(harness);
      const vendorRows = new Set(vendorFacingOptions(options).map((o) => o.id));
      for (const option of options) {
        const control = commonControlFor(option.id);
        const viaVendorRow = vendorRows.has(option.id);
        if (control && viaVendorRow) duplicated.push(`${harness.command}/${option.id}`);
        if (!control && !viaVendorRow) unreachable.push(`${harness.command}/${option.id}`);
      }
    }
    expect(unreachable, 'options with no route at all').toEqual([]);
    expect(duplicated, 'options reachable two ways').toEqual([]);
  });

  it('gives each control an option on every harness that has one to drive', () => {
    // A control owns a concept, not a spelling. If a harness publishes any id
    // the control owns, resolving by control must find it.
    for (const control of ['/add-dir', '/model', '/permissions', '/effort', '/cwd']) {
      const ids = optionIdsForControl(control);
      expect(ids.length, `${control} owns no option id`).toBeGreaterThan(0);
      for (const harness of harnesses) {
        const published = optionsOf(harness).filter((o) => ids.includes(o.id));
        // Either the harness publishes one of this control's spellings, or it
        // publishes none -- never one the control cannot see.
        expect(published.length, `${harness.command} publishes ${published.length} rows for ${control}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it('reaches both spellings of extra directories from one control', () => {
    const ids = optionIdsForControl('/add-dir');
    const byAddDir = harnesses.filter((h) => optionsOf(h).some((o) => o.id === 'add-dir'));
    const byInclude = harnesses.filter((h) => optionsOf(h).some((o) => o.id === 'include-directories'));
    expect(byAddDir.length).toBeGreaterThan(0);
    expect(byInclude.map((h) => h.command)).toEqual(['qwen']);
    for (const harness of [...byAddDir, ...byInclude]) {
      expect(optionsOf(harness).some((o) => ids.includes(o.id)), `${harness.command} is unreachable from /add-dir`).toBe(true);
    }
  });
});

describe('a harness only ever shows its own options', () => {
  it('never leaks one vendor\'s options into another\'s list', () => {
    // The lists are built from the selected session's harness manifest, so the
    // guarantee is that no id appears for a harness that does not publish it.
    for (const harness of harnesses) {
      const shown = new Set(vendorFacingOptions(optionsOf(harness)).map((o) => o.id));
      const published = new Set(optionsOf(harness).map((o) => o.id));
      for (const id of shown) expect(published.has(id), `${harness.command} shows ${id} it does not publish`).toBe(true);
    }
  });

  it('keeps vendor-specific ids out of every other harness that lacks them', () => {
    // `--worktree` exists on seven harnesses and must not appear on the other
    // seventeen just because it is a shared, normalized name.
    const withWorktree = harnesses.filter((h) => optionsOf(h).some((o) => o.id === 'worktree')).map((h) => h.command);
    const withoutWorktree = harnesses.filter((h) => !withWorktree.includes(h.command));
    expect(withWorktree.length).toBe(7);
    for (const harness of withoutWorktree) {
      expect(vendorFacingOptions(optionsOf(harness)).some((o) => o.id === 'worktree')).toBe(false);
    }
  });
});

describe('asking for a control by any of its spellings finds the right option', () => {
  /** Mirrors ai.ts's optionForHarness: exact id, then the control's others. */
  const resolve = (harness: typeof harnesses[number], id: string): Opt | undefined => {
    const options = optionsOf(harness);
    const exact = options.find((o) => o.id === id);
    if (exact) return exact;
    const control = commonControlFor(id);
    if (!control) return undefined;
    const ids = optionIdsForControl(control);
    return options.find((o) => ids.includes(o.id));
  };

  it('resolves every spelling of a control on every harness that has one', () => {
    for (const control of ['/model', '/permissions', '/effort', '/cwd', '/add-dir']) {
      const ids = optionIdsForControl(control);
      for (const harness of harnesses) {
        const published = optionsOf(harness).find((o) => ids.includes(o.id));
        if (!published) continue;
        // Asking by ANY id this control owns must land on the published one.
        for (const id of ids) {
          expect(resolve(harness, id)?.id, `${harness.command}: ${id} did not resolve to ${published.id}`).toBe(published.id);
        }
      }
    }
  });

  it('reaches Qwen through the id the others use', () => {
    for (const command of ['qwen']) {
      const harness = harnesses.find((h) => h.command === command)!;
      expect(resolve(harness, 'add-dir')?.id).toBe('include-directories');
    }
  });

  it('still refuses an option the harness genuinely does not have', () => {
    // The fallback must not invent a control where the harness publishes none.
    const amp = harnesses.find((h) => h.command === 'amp')!;
    expect(optionsOf(amp).some((o) => optionIdsForControl('/add-dir').includes(o.id))).toBe(false);
    expect(resolve(amp, 'add-dir')).toBeUndefined();
  });
});
