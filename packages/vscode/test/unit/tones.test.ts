import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TOOL_CATEGORY } from '../../../../src/harness/protocol/tool-category';
import { workingLabelClass } from '../../src/webview/chat';

const css = readFileSync(join(__dirname, '../../src/webview/styles.css'), 'utf8');

describe('tool colours in the panel', () => {
  it('give every category colour its own theme variable', () => {
    const colours = [...new Set(Object.values(TOOL_CATEGORY).map((entry) => entry.colour))];
    const variables = colours.map((colour) => new RegExp(`\\.tone-${colour} \\{ --tone: var\\((--vscode-[\\w-]+)`).exec(css)?.[1]);
    expect(variables.every(Boolean)).toBe(true);
    expect(new Set(variables).size).toBe(colours.length);
  });

  it('colour a stalled conversation yellow, as the terminal does', () => {
    expect(css).toContain('.conversation-dot.working.stalled');
  });
});

describe('the working line while the turn waits on the user', () => {
  it('holds its label still: the shimmer is only for a turn at work', () => {
    expect(workingLabelClass('tone-permission', true)).not.toContain('shimmer');
    expect(workingLabelClass('tone-plain', false)).toContain('shimmer');
    // Every rule that animates the label asks for that class.
    const rules = [...css.matchAll(/([^{}]*\.working-label[^{}]*)\{([^}]*)\}/g)].filter(([, , body]) => /animation:\s*shimmer/.test(body!));
    expect(rules.length).toBeGreaterThan(0);
    for (const [, selector] of rules) expect(selector).toContain('.working-label.shimmer');
  });
});
