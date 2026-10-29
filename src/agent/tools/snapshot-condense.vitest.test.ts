import { describe, expect, it } from 'vitest';
import { arrangeSnapshot } from './computer-web.js';
import { capSections, condenseSnapshot, dedupeLinks, shortenText } from './snapshot-condense.js';

const link = (name: string, ref: number, url: string, indent = 6): string => `${' '.repeat(indent)}- link "${name}" [ref=e${ref}] [cursor=pointer]:\n${' '.repeat(indent + 2)}- /url: ${url}`;

/** A typical sign-up page: a big header menu, a hero, many feature cards with repeated links, a form, a long footer. */
function signupPage(): string {
  let ref = 10;
  const nav = Array.from({ length: 60 }, (_, i) => `      - listitem [ref=e${ref++}]:\n${link(`Product ${i % 30}`, ref++, `/p/${i % 30}`, 8)}`).join('\n');
  const cards = Array.from({ length: 50 }, (_, i) => [
    `        - listitem [ref=e${ref++}]:`, `          - heading "Feature ${i}" [level=3] [ref=e${ref++}]`,
    `          - paragraph [ref=e${ref++}]: ${'Lorem ipsum dolor sit amet, '.repeat(14)}`, link('Learn more', ref++, '/features', 10)].join('\n')).join('\n');
  const footer = Array.from({ length: 80 }, (_, i) => link(`Footer link ${i}`, ref++, `/f/${i}`, 6)).join('\n');
  return [
    '- generic [active] [ref=e1]:', '  - banner [ref=e2]:', '    - navigation [ref=e3]:', '      - list [ref=e4]:', nav,
    '  - main [ref=e5]:', '    - heading "Create your account" [level=1] [ref=e6]',
    '    - list [ref=e7]:', cards,
    '    - form [ref=e8]:', '      - textbox "Email" [ref=e900]', '      - textbox "Password" [ref=e901]', '      - checkbox "I agree" [ref=e902]', '      - button "Sign up" [ref=e903]',
    '  - contentinfo [ref=e9]:', footer,
  ].join('\n');
}
const refsOf = (text: string): Set<string> => new Set([...text.matchAll(/\[ref=(e\d+)\]/g)].map(m => m[1]!));

describe('condenseSnapshot', () => {
  it('leaves a link repeated with the same name and address out, and the wrapper it emptied', () => {
    const lines = ['- list [ref=e1]:', '  - listitem [ref=e2]:', link('Docs', 3, '/docs', 4), '  - listitem [ref=e4]:', link('Docs', 5, '/docs', 4), '  - listitem [ref=e6]:', link('Docs', 7, '/other', 4)];
    const { lines: out, removed } = dedupeLinks(lines.flatMap(line => line.split('\n')));
    expect(removed).toBe(1);
    expect(out.join('\n')).not.toContain('e4');
    expect(out.join('\n')).not.toContain('e5');
    expect(out.join('\n')).toContain('/other');
  });

  it('shortens a long text line and keeps short ones', () => {
    const [long, short] = shortenText([`  - paragraph [ref=e1]: ${'word '.repeat(100)}`, '  - paragraph [ref=e2]: short']);
    expect(long!.length).toBeLessThan(330);
    expect(long).toContain('more characters');
    expect(short).toBe('  - paragraph [ref=e2]: short');
  });

  it('cuts the tail of a long section but keeps its first lines and every control with the lines it sits under', () => {
    const rows = ['- list [ref=e1]:', ...Array.from({ length: 80 }, (_, i) => `  - link "Item ${i}" [ref=e${10 + i}]`), '  - listitem [ref=e200]:', '    - button "Buy" [ref=e201]'];
    const { lines, cut } = capSections(rows);
    const text = lines.join('\n');
    expect(cut).toBeGreaterThan(60);
    expect(text).toContain('Item 0');
    expect(text).not.toContain('Item 70');
    expect(text).toContain('listitem [ref=e200]');
    expect(text).toContain('button "Buy" [ref=e201]');
    expect(text).toContain('more lines of this section left out');
  });

  it('shrinks a sign-up page a great deal and loses no ref of the form or its buttons', () => {
    const page = signupPage();
    const before = arrangeSnapshot(page, true);
    const after = arrangeSnapshot(page);
    const sizes = { full: before.length, shown: after.length };
    expect(sizes.shown).toBeLessThan(sizes.full * 0.25);
    for (const ref of ['e6', 'e8', 'e900', 'e901', 'e902', 'e903']) expect(refsOf(after).has(ref)).toBe(true);
    expect(after).toContain('button "Sign up"');
    // Without the condensing pass the shown page was far larger.
    const raw = page.split('\n').filter(line => !/^\s*- (?:banner|contentinfo)/.test(line)).join('\n');
    expect(after.length).toBeLessThan(raw.length * 0.5);
  });

  it('full keeps everything', () => {
    const page = signupPage();
    expect(arrangeSnapshot(page, true)).toContain('Footer link 79');
    expect(arrangeSnapshot(page)).not.toContain('Footer link 79');
  });
});
