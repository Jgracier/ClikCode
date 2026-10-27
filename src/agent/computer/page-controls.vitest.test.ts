import { describe, expect, it } from 'vitest';
import { OPENS_ANOTHER_APP as fromConsent } from './oauth-consent.js';
import { OPENS_ANOTHER_APP, PRESSABLE, PRESSABLE_SITE, withPageControls } from './page-controls.js';

describe('page controls (pure parts)', () => {
  it('has one OPENS_ANOTHER_APP, re-exported by oauth-consent', () => {
    expect(fromConsent).toBe(OPENS_ANOTHER_APP);
    for (const href of ['mailto:a@b.co', 'tel:+1555', 'zoommtg://x']) expect(OPENS_ANOTHER_APP.test(href), href).toBe(true);
    for (const href of ['', '/x', 'https://a.co', 'javascript:void(0)', 'about:blank']) expect(OPENS_ANOTHER_APP.test(href), href).toBe(false);
  });
  it('selectors cover buttons and links; the consent one also covers account cards', () => {
    for (const s of [PRESSABLE, PRESSABLE_SITE]) expect(s).toMatch(/button.*\ba\b.*summary/);
    expect(PRESSABLE).toContain('[data-identifier]');
    expect(PRESSABLE_SITE).toContain('[role=tab]');
  });
  it('builds a self-contained expression that carries the reader and its options', () => {
    const src = withPageControls(read => read(), { pressable: 'button', otherApp: OPENS_ANOTHER_APP.source, cap: 5 });
    expect(src).toContain('function readPageControls');
    expect(src).toContain('"cap":5');
    expect(src.endsWith('})()')).toBe(true);
    expect(() => new Function(`return ${src}`)).not.toThrow();
  });
});
