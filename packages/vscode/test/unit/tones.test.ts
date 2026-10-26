import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lookCssVariables } from '../../../../src/harness/protocol/look';
import { workingLabelClass } from '../../src/webview/chat';

const css = readFileSync(join(__dirname, '../../src/webview/styles.css'), 'utf8');

describe('tool colours in the panel', () => {
  it('has no colour of its own per category: the look roles are the only tones', () => {
    expect(css).not.toMatch(/\.tone-(blue|magenta|yellow|cyan|green|permission)\b/);
    for (const name of ['accent', 'tool', 'failed', 'stopped', 'success']) expect(css).toContain(`.tone-${name} {`);
  });

  it('paints from the look tokens: every variable the css reads is one look.ts sets', () => {
    const set = new Set(Object.keys(lookCssVariables()));
    const read = [...css.matchAll(/var\((--look-[\w-]+)\)/g)].map((match) => match[1]!);
    expect(read.length).toBeGreaterThan(0);
    for (const name of read) expect(set.has(name), name).toBe(true);
    expect(lookCssVariables()['--look-tool-glyph']).toBe('#5f87d7');
    expect(lookCssVariables()['--look-tool-text']).toBe('#87afd7');
  });

  it('does not infer failure styling from silence', () => {
    expect(css).not.toContain('.conversation-dot.working.stalled');
  });
});

describe('the working line while the turn waits on the user', () => {
  it('holds its label still: the shimmer is only for a turn at work', () => {
    expect(workingLabelClass('tone-accent', true)).not.toContain('shimmer');
    expect(workingLabelClass('tone-plain', false)).toContain('shimmer');
    // Every rule that animates the label asks for that class.
    const rules = [...css.matchAll(/([^{}]*\.working-label[^{}]*)\{([^}]*)\}/g)].filter(([, , body]) => /animation:\s*shimmer/.test(body!));
    expect(rules.length).toBeGreaterThan(0);
    for (const [, selector] of rules) expect(selector).toContain('.working-label.shimmer');
  });
});
